use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};

use crate::terminal::view::{TerminalInput, TerminalView};
use crate::terminal::{TerminalConfig, TerminalSession, default_terminal_font};
use gpui::{
    AnyElement, Context, Entity, IntoElement, Render, SharedString, Window, div, prelude::*, px,
    relative, rgb, svg,
};

use crate::{
    CloseTerminal, NewSession, NewTerminal, NewWindow,
    client::{HostAction, HostClient, HostEvent},
    model::{MuxTerminal, SessionSnapshot, SessionTab, TerminalLayoutNode},
    theme::YaadeTheme,
};

struct NativeTerminal {
    pty_id: String,
    view: Entity<TerminalView>,
}

pub struct YaadeApp {
    host: HostClient,
    snapshots: Vec<SessionSnapshot>,
    terminals: HashMap<String, NativeTerminal>,
    attached_ptys: HashSet<String>,
    active_session_id: Option<String>,
    active_tab_id: Option<String>,
    active_terminal_id: Option<String>,
    connection: ConnectionState,
    action_error: Option<String>,
    session_switcher_open: bool,
    settings_open: bool,
    theme: YaadeTheme,
}

#[derive(Clone)]
enum ConnectionState {
    Connecting,
    Connected,
    Offline(String),
}

impl YaadeApp {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let app = Self {
            host: HostClient::start(),
            snapshots: Vec::new(),
            terminals: HashMap::new(),
            attached_ptys: HashSet::new(),
            active_session_id: None,
            active_tab_id: None,
            active_terminal_id: None,
            connection: ConnectionState::Connecting,
            action_error: None,
            session_switcher_open: false,
            settings_open: false,
            theme: YaadeTheme::dark(),
        };
        app.start_event_pump(window, cx);
        app
    }

    fn start_event_pump(&self, window: &mut Window, cx: &mut Context<Self>) {
        let events = self.host.events().clone();
        cx.spawn_in(window, async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(8))
                    .await;
                let mut pending = Vec::new();
                while let Ok(event) = events.try_recv() {
                    pending.push(event);
                    if pending.len() >= 256 {
                        break;
                    }
                }
                if pending.is_empty() {
                    continue;
                }
                let should_resize = pending.iter().any(|event| {
                    matches!(
                        event,
                        HostEvent::Snapshots(_) | HostEvent::TerminalReplay { .. }
                    )
                });
                if this
                    .update_in(cx, |this, window, cx| {
                        for event in pending {
                            this.handle_event(event, cx);
                        }
                        if should_resize {
                            this.resize_active_terminal(window, cx);
                        }
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
    }

    fn handle_event(&mut self, event: HostEvent, cx: &mut Context<Self>) {
        match event {
            HostEvent::Connecting => self.connection = ConnectionState::Connecting,
            HostEvent::Connected => {
                self.connection = ConnectionState::Connected;
                self.action_error = None;
            }
            HostEvent::Offline(error) => self.connection = ConnectionState::Offline(error),
            HostEvent::Snapshots(snapshots) => self.apply_snapshots(snapshots, cx),
            HostEvent::RefreshRequested => self.host.hydrate(),
            HostEvent::TerminalReplay {
                pty_id,
                chunks,
                cols,
                rows,
            } => {
                if let Some(terminal) = self.terminal_for_pty(&pty_id) {
                    terminal.view.update(cx, |view, cx| {
                        view.resize_terminal(cols, rows, cx);
                        for chunk in chunks {
                            view.queue_output_bytes(&chunk, cx);
                        }
                    });
                }
            }
            HostEvent::TerminalOutput { pty_id, bytes } => {
                if let Some(terminal) = self.terminal_for_pty(&pty_id) {
                    terminal
                        .view
                        .update(cx, |view, cx| view.queue_output_bytes(&bytes, cx));
                }
            }
            HostEvent::ActionFailed(error) => self.action_error = Some(error),
        }
        cx.notify();
    }

    fn apply_snapshots(&mut self, mut snapshots: Vec<SessionSnapshot>, cx: &mut Context<Self>) {
        snapshots.retain(|snapshot| snapshot.session.archived_at.is_none());
        snapshots.sort_by_key(|snapshot| snapshot.session.position);
        for snapshot in &mut snapshots {
            snapshot.tabs.retain(|tab| tab.archived_at.is_none());
            snapshot.tabs.sort_by_key(|tab| tab.position);
            snapshot
                .mux_terminals
                .retain(|terminal| terminal.archived_at.is_none());
            snapshot
                .mux_terminals
                .sort_by_key(|terminal| terminal.position);
        }

        let session_id = self
            .active_session_id
            .as_ref()
            .filter(|id| snapshots.iter().any(|snapshot| &snapshot.session.id == *id))
            .cloned()
            .or_else(|| {
                snapshots
                    .first()
                    .map(|snapshot| snapshot.session.id.clone())
            });
        self.active_session_id = session_id;
        self.snapshots = snapshots;
        self.reconcile_selection();

        let terminals = self
            .snapshots
            .iter()
            .flat_map(|snapshot| snapshot.mux_terminals.iter())
            .filter_map(|terminal| {
                terminal
                    .output
                    .pty_id
                    .as_ref()
                    .map(|pty| (terminal.id.clone(), pty.clone()))
            })
            .collect::<Vec<_>>();
        let live_ids = terminals
            .iter()
            .map(|(id, _)| id.clone())
            .collect::<HashSet<_>>();
        self.terminals.retain(|id, _| live_ids.contains(id));
        for (terminal_id, pty_id) in terminals {
            let unchanged = self
                .terminals
                .get(&terminal_id)
                .is_some_and(|terminal| terminal.pty_id == pty_id);
            if unchanged {
                continue;
            }
            let view = self.new_terminal_view(&pty_id, cx);
            self.terminals.insert(
                terminal_id,
                NativeTerminal {
                    pty_id: pty_id.clone(),
                    view,
                },
            );
            if self.attached_ptys.insert(pty_id.clone()) {
                self.host.attach(pty_id);
            }
        }
        cx.notify();
    }

    fn new_terminal_view(&self, pty_id: &str, cx: &mut Context<Self>) -> Entity<TerminalView> {
        let host = self.host.clone();
        let pty_id = pty_id.to_owned();
        let theme = self.theme;
        cx.new(move |cx| {
            let focus = cx.focus_handle();
            let session = TerminalSession::new(TerminalConfig {
                cols: 80,
                rows: 24,
                default_fg: theme.terminal_foreground(),
                default_bg: theme.terminal_background(),
                update_window_title: false,
            })
            .expect("initialize Ghostty terminal");
            let input_id = pty_id.clone();
            let input = TerminalInput::new(move |bytes| host.input(input_id.clone(), bytes));
            TerminalView::new_with_input(session, focus, input)
        })
    }

    fn terminal_for_pty(&self, pty_id: &str) -> Option<&NativeTerminal> {
        self.terminals
            .values()
            .find(|terminal| terminal.pty_id == pty_id)
    }

    fn reconcile_selection(&mut self) {
        let Some(snapshot) = self.active_snapshot() else {
            self.active_tab_id = None;
            self.active_terminal_id = None;
            return;
        };
        let tab_id = self
            .active_tab_id
            .as_ref()
            .filter(|id| snapshot.tabs.iter().any(|tab| &tab.id == *id))
            .cloned()
            .or_else(|| snapshot.session.active_tab_id.clone())
            .or_else(|| snapshot.tabs.first().map(|tab| tab.id.clone()));
        let terminal_id = tab_id.as_ref().and_then(|tab_id| {
            self.active_terminal_id
                .as_ref()
                .filter(|id| {
                    snapshot.mux_terminals.iter().any(|terminal| {
                        &terminal.id == *id && terminal.tab_id.as_ref() == Some(tab_id)
                    })
                })
                .cloned()
                .or_else(|| {
                    snapshot
                        .tabs
                        .iter()
                        .find(|tab| &tab.id == tab_id)
                        .and_then(|tab| tab.active_mux_terminal_id.clone())
                })
                .or_else(|| {
                    snapshot
                        .mux_terminals
                        .iter()
                        .find(|terminal| terminal.tab_id.as_ref() == Some(tab_id))
                        .map(|terminal| terminal.id.clone())
                })
        });
        self.active_tab_id = tab_id;
        self.active_terminal_id = terminal_id;
    }

    fn active_snapshot(&self) -> Option<&SessionSnapshot> {
        let id = self.active_session_id.as_ref()?;
        self.snapshots
            .iter()
            .find(|snapshot| &snapshot.session.id == id)
    }

    fn active_tabs(&self) -> Vec<SessionTab> {
        self.active_snapshot()
            .map(|snapshot| snapshot.tabs.clone())
            .unwrap_or_default()
    }

    fn active_terminal(&self) -> Option<&MuxTerminal> {
        let id = self.active_terminal_id.as_ref()?;
        self.active_snapshot()?
            .mux_terminals
            .iter()
            .find(|terminal| &terminal.id == id)
    }

    fn select_session(&mut self, id: String, cx: &mut Context<Self>) {
        self.session_switcher_open = false;
        self.active_session_id = Some(id.clone());
        self.active_tab_id = None;
        self.active_terminal_id = None;
        self.reconcile_selection();
        self.host
            .action(HostAction::SelectSession { session_id: id });
        cx.notify();
    }

    fn select_tab(&mut self, session_id: String, tab_id: String, cx: &mut Context<Self>) {
        self.active_tab_id = Some(tab_id.clone());
        self.active_terminal_id = None;
        self.reconcile_selection();
        self.host
            .action(HostAction::SelectTab { session_id, tab_id });
        cx.notify();
    }

    fn select_terminal(&mut self, session_id: String, terminal_id: String, cx: &mut Context<Self>) {
        self.active_terminal_id = Some(terminal_id.clone());
        self.host.action(HostAction::SelectTerminal {
            session_id,
            terminal_id,
        });
        cx.notify();
    }

    fn create_window(&mut self) {
        let Some(snapshot) = self.active_snapshot() else {
            self.host.action(HostAction::CreateSession);
            return;
        };
        self.host.action(HostAction::CreateTab {
            session_id: snapshot.session.id.clone(),
            title: format!("Window {}", snapshot.tabs.len() + 1),
        });
    }

    fn create_terminal(&mut self) {
        let (Some(session_id), Some(tab_id)) =
            (self.active_session_id.clone(), self.active_tab_id.clone())
        else {
            return;
        };
        self.host
            .action(HostAction::CreateTerminal { session_id, tab_id });
    }

    pub fn close_terminal(&self) {
        if let Some(terminal_id) = self.active_terminal_id.clone() {
            self.host.action(HostAction::CloseTerminal { terminal_id });
        }
    }

    pub fn resize_active_terminal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(active_id) = self.active_terminal_id.clone() else {
            return;
        };
        let Some(terminal) = self.terminals.get(&active_id) else {
            return;
        };
        let Some((cell_width, cell_height)) = cell_metrics(window) else {
            return;
        };
        let viewport = window.viewport_size();
        let width = (f32::from(viewport.width) - 18.0).max(1.0);
        let height = (f32::from(viewport.height) - 60.0).max(1.0);
        let cols = (width / cell_width).floor().clamp(1.0, u16::MAX as f32) as u16;
        let rows = (height / cell_height).floor().clamp(1.0, u16::MAX as f32) as u16;
        terminal
            .view
            .update(cx, |view, cx| view.resize_terminal(cols, rows, cx));
        self.host.resize(terminal.pty_id.clone(), cols, rows);
    }

    fn icon_button(
        &self,
        id: &'static str,
        icon: &'static str,
        _title: &'static str,
        on_click: impl Fn(&mut Self, &mut Window, &mut Context<Self>) + 'static,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        div()
            .id(id)
            .size(px(31.0))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(999.0))
            .text_color(self.theme.muted_foreground)
            .hover(|style| {
                style
                    .bg(YaadeTheme::alpha(self.theme.accent, 0.72))
                    .text_color(self.theme.foreground)
            })
            .active(|style| style.opacity(0.76))
            .cursor_pointer()
            .on_click(cx.listener(move |this, _, window, cx| on_click(this, window, cx)))
            .child(
                svg()
                    .path(icon)
                    .size(px(15.0))
                    .text_color(self.theme.muted_foreground),
            )
    }

    fn render_header(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let tabs = self.active_tabs();
        let active_tab_id = self.active_tab_id.clone();
        let session_id = self.active_session_id.clone();
        let theme = self.theme;

        div()
            .h(px(42.0))
            .flex_none()
            .flex()
            .items_center()
            .gap(px(3.0))
            .px(px(6.0))
            .border_b_1()
            .border_color(theme.border)
            .bg(theme.chrome)
            .child(self.icon_button(
                "sessions",
                "icons/layers.svg",
                "Switch session",
                |this, _, cx| {
                    this.session_switcher_open = !this.session_switcher_open;
                    this.settings_open = false;
                    cx.notify();
                },
                cx,
            ))
            .child(self.icon_button(
                "settings",
                "icons/settings.svg",
                "Settings",
                |this, _, cx| {
                    this.settings_open = !this.settings_open;
                    this.session_switcher_open = false;
                    cx.notify();
                },
                cx,
            ))
            .child(
                div()
                    .h_full()
                    .min_w(px(0.0))
                    .flex_1()
                    .flex()
                    .items_center()
                    .gap(px(2.0))
                    .overflow_x_hidden()
                    .children(tabs.into_iter().map(|tab| {
                        let selected = active_tab_id.as_ref() == Some(&tab.id);
                        let choose_session =
                            session_id.clone().unwrap_or_else(|| tab.session_id.clone());
                        let choose_tab = tab.id.clone();
                        let close_tab = tab.id.clone();
                        div()
                            .id(SharedString::from(format!("window-{}", tab.id)))
                            .group("window-tab")
                            .relative()
                            .h(px(31.0))
                            .min_w(px(182.0))
                            .max_w(px(234.0))
                            .flex()
                            .items_center()
                            .gap(px(7.0))
                            .pl(px(10.0))
                            .pr(px(5.0))
                            .rounded(px(999.0))
                            .border_1()
                            .border_color(if selected {
                                theme.border
                            } else {
                                YaadeTheme::alpha(theme.border, 0.0)
                            })
                            .bg(if selected {
                                rgb(0x252c34)
                            } else {
                                YaadeTheme::alpha(theme.card, 0.0)
                            })
                            .text_color(if selected {
                                theme.foreground
                            } else {
                                theme.muted_foreground
                            })
                            .hover(|style| style.bg(rgb(0x202831)))
                            .cursor_pointer()
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.select_tab(choose_session.clone(), choose_tab.clone(), cx);
                            }))
                            .child(
                                svg()
                                    .path("icons/terminal.svg")
                                    .size(px(14.0))
                                    .flex_none()
                                    .text_color(theme.muted_foreground),
                            )
                            .child(
                                div()
                                    .min_w(px(0.0))
                                    .flex_1()
                                    .text_size(px(12.0))
                                    .font_weight(gpui::FontWeight::MEDIUM)
                                    .child(tab.title),
                            )
                            .child(
                                div()
                                    .id(SharedString::from(format!("close-{}", close_tab)))
                                    .size(px(22.0))
                                    .flex_none()
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded(px(999.0))
                                    .opacity(if selected { 0.7 } else { 0.0 })
                                    .group_hover("window-tab", |style| style.opacity(1.0))
                                    .hover(|style| style.bg(theme.accent))
                                    .on_click(cx.listener(
                                        move |this, _: &gpui::ClickEvent, _, cx| {
                                            cx.stop_propagation();
                                            this.host.action(HostAction::CloseTab {
                                                tab_id: close_tab.clone(),
                                            });
                                        },
                                    ))
                                    .child(
                                        svg()
                                            .path("icons/x.svg")
                                            .size(px(12.0))
                                            .text_color(theme.muted_foreground),
                                    ),
                            )
                    })),
            )
            .child(self.icon_button(
                "new-window",
                "icons/plus.svg",
                "New Window",
                |this, _, _| this.create_window(),
                cx,
            ))
    }

    fn render_session_switcher(&self, cx: &mut Context<Self>) -> Option<impl IntoElement> {
        if !self.session_switcher_open {
            return None;
        }
        let sessions = self
            .snapshots
            .iter()
            .map(|snapshot| {
                let count = snapshot
                    .mux_terminals
                    .iter()
                    .filter(|terminal| terminal.archived_at.is_none())
                    .count();
                (snapshot.session.clone(), count)
            })
            .collect::<Vec<_>>();
        let active_id = self.active_session_id.clone();
        let theme = self.theme;
        Some(
            div()
                .absolute()
                .top(px(8.0))
                .left(px(8.0))
                .w(px(352.0))
                .max_h(px(352.0))
                .overflow_hidden()
                .rounded(px(11.0))
                .border_1()
                .border_color(theme.border)
                .bg(theme.card)
                .shadow(vec![gpui::BoxShadow {
                    color: gpui::rgba(0x00000052).into(),
                    offset: gpui::point(px(0.0), px(8.0)),
                    blur_radius: px(24.0),
                    spread_radius: px(0.0),
                }])
                .child(
                    div()
                        .max_h(px(298.0))
                        .overflow_hidden()
                        .p(px(6.0))
                        .when(sessions.is_empty(), |list| {
                            list.child(
                                div()
                                    .px(px(10.0))
                                    .py(px(18.0))
                                    .text_size(px(12.0))
                                    .text_color(theme.muted_foreground)
                                    .child("No active sessions."),
                            )
                        })
                        .children(sessions.into_iter().map(|(session, count)| {
                            let selected = active_id.as_ref() == Some(&session.id);
                            let target = session.id.clone();
                            div()
                                .id(SharedString::from(format!("session-{}", session.id)))
                                .min_h(px(44.0))
                                .flex()
                                .items_center()
                                .gap(px(9.0))
                                .rounded(px(8.0))
                                .px(px(10.0))
                                .bg(if selected {
                                    YaadeTheme::alpha(theme.accent, 0.8)
                                } else {
                                    YaadeTheme::alpha(theme.accent, 0.0)
                                })
                                .hover(|style| style.bg(YaadeTheme::alpha(theme.accent, 0.55)))
                                .cursor_pointer()
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.select_session(target.clone(), cx);
                                }))
                                .child(
                                    div()
                                        .size(px(20.0))
                                        .flex_none()
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .rounded(px(999.0))
                                        .border_1()
                                        .border_color(if selected {
                                            theme.primary
                                        } else {
                                            theme.border
                                        })
                                        .text_size(px(11.0))
                                        .text_color(theme.primary)
                                        .child(if selected { "✓" } else { "" }),
                                )
                                .child(
                                    div()
                                        .min_w(px(0.0))
                                        .flex_1()
                                        .flex()
                                        .flex_col()
                                        .gap(px(1.0))
                                        .child(
                                            div()
                                                .text_size(px(12.0))
                                                .font_weight(gpui::FontWeight::MEDIUM)
                                                .child(session.title),
                                        )
                                        .child(
                                            div()
                                                .text_size(px(10.0))
                                                .text_color(theme.muted_foreground)
                                                .child(format!("{count} terminals")),
                                        ),
                                )
                        })),
                )
                .child(
                    div()
                        .border_t_1()
                        .border_color(theme.border)
                        .p(px(6.0))
                        .child(
                            div()
                                .id("new-session")
                                .h(px(40.0))
                                .flex()
                                .items_center()
                                .gap(px(9.0))
                                .rounded(px(8.0))
                                .px(px(9.0))
                                .hover(|style| style.bg(YaadeTheme::alpha(theme.accent, 0.6)))
                                .cursor_pointer()
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.session_switcher_open = false;
                                    this.host.action(HostAction::CreateSession);
                                    cx.notify();
                                }))
                                .child(
                                    div()
                                        .size(px(24.0))
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .rounded(px(999.0))
                                        .bg(YaadeTheme::alpha(theme.primary, 0.15))
                                        .child(
                                            svg()
                                                .path("icons/plus.svg")
                                                .size(px(13.0))
                                                .text_color(theme.primary),
                                        ),
                                )
                                .child(div().text_size(px(12.0)).child("New session")),
                        ),
                ),
        )
    }

    fn render_settings(&self) -> Option<impl IntoElement> {
        if !self.settings_open {
            return None;
        }
        let theme = self.theme;
        Some(
            div()
                .absolute()
                .top(px(8.0))
                .left(px(42.0))
                .w(px(300.0))
                .rounded(px(11.0))
                .border_1()
                .border_color(theme.border)
                .bg(theme.card)
                .p(px(14.0))
                .shadow(vec![gpui::BoxShadow {
                    color: gpui::rgba(0x00000052).into(),
                    offset: gpui::point(px(0.0), px(8.0)),
                    blur_radius: px(24.0),
                    spread_radius: px(0.0),
                }])
                .child(
                    div()
                        .text_size(px(12.0))
                        .font_weight(gpui::FontWeight::SEMIBOLD)
                        .child("Appearance"),
                )
                .child(
                    div()
                        .mt(px(10.0))
                        .rounded(px(8.0))
                        .border_1()
                        .border_color(theme.border)
                        .bg(theme.content)
                        .p(px(10.0))
                        .flex()
                        .flex_col()
                        .gap(px(4.0))
                        .child(div().text_size(px(12.0)).child("YAADE Default Dark"))
                        .child(
                            div()
                                .text_size(px(10.0))
                                .text_color(theme.muted_foreground)
                                .child("Geist · Geist Mono · Native system motion"),
                        ),
                ),
        )
    }

    fn render_connection_notice(&self) -> Option<impl IntoElement> {
        let text = match &self.connection {
            ConnectionState::Connecting => {
                Some("Reconnecting · Reconciling session state".to_owned())
            }
            ConnectionState::Offline(error) => Some(format!("Host offline · {error}")),
            ConnectionState::Connected => self
                .action_error
                .clone()
                .map(|error| format!("Action failed · {error}")),
        }?;
        Some(
            div()
                .absolute()
                .top(px(12.0))
                .left(px(12.0))
                .right(px(12.0))
                .rounded(px(10.0))
                .border_1()
                .border_color(self.theme.border)
                .bg(self.theme.card)
                .px(px(12.0))
                .py(px(9.0))
                .text_size(px(12.0))
                .text_color(self.theme.muted_foreground)
                .child(text),
        )
    }

    fn render_terminal_picker(&self, cx: &mut Context<Self>) -> Option<impl IntoElement> {
        let snapshot = self.active_snapshot()?;
        let tab_id = self.active_tab_id.as_ref()?;
        let terminals = snapshot
            .mux_terminals
            .iter()
            .filter(|terminal| terminal.tab_id.as_ref() == Some(tab_id))
            .cloned()
            .collect::<Vec<_>>();
        if terminals.len() <= 1 {
            return None;
        }
        let session_id = snapshot.session.id.clone();
        let active = self.active_terminal_id.clone();
        let theme = self.theme;
        Some(
            div()
                .absolute()
                .left(px(10.0))
                .bottom(px(10.0))
                .flex()
                .gap(px(3.0))
                .rounded(px(999.0))
                .border_1()
                .border_color(theme.border)
                .bg(theme.chrome)
                .p(px(3.0))
                .children(terminals.into_iter().map(|terminal| {
                    let selected = active.as_ref() == Some(&terminal.id);
                    let target = terminal.id.clone();
                    let session_id = session_id.clone();
                    div()
                        .id(SharedString::from(format!("terminal-{}", terminal.id)))
                        .max_w(px(180.0))
                        .h(px(27.0))
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .px(px(9.0))
                        .rounded(px(999.0))
                        .bg(if selected {
                            theme.accent
                        } else {
                            YaadeTheme::alpha(theme.accent, 0.0)
                        })
                        .text_color(if selected {
                            theme.foreground
                        } else {
                            theme.muted_foreground
                        })
                        .hover(|style| style.bg(theme.accent))
                        .cursor_pointer()
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.select_terminal(session_id.clone(), target.clone(), cx);
                        }))
                        .child(svg().path("icons/terminal.svg").size(px(12.0)))
                        .child(div().text_size(px(11.0)).child(terminal.title))
                })),
        )
    }

    fn render_workspace(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let active_view = self
            .active_terminal_id
            .as_ref()
            .and_then(|id| self.terminals.get(id))
            .map(|terminal| terminal.view.clone());
        let has_active_view = active_view.is_some();
        let status = self.active_terminal().map(MuxTerminal::status_label);
        let terminal_id = self.active_terminal_id.clone();
        let theme = self.theme;

        div()
            .relative()
            .min_h(px(0.0))
            .flex_1()
            .p(px(8.0))
            .bg(theme.background)
            .child(
                div()
                    .relative()
                    .size_full()
                    .overflow_hidden()
                    .rounded(px(10.0))
                    .border_1()
                    .border_color(theme.border)
                    .bg(theme.content)
                    .shadow(vec![gpui::BoxShadow {
                        color: YaadeTheme::alpha(theme.foreground, 0.05).into(),
                        offset: gpui::point(px(0.0), px(1.0)),
                        blur_radius: px(0.0),
                        spread_radius: px(0.0),
                    }])
                    .when_some(active_view, |pane, view| {
                        pane.child(
                            div()
                                .size_full()
                                .cursor(gpui::CursorStyle::IBeam)
                                .font_family("Geist Mono")
                                .text_size(px(13.0))
                                .line_height(relative(1.0))
                                .child(view),
                        )
                    })
                    .when(!has_active_view, |pane| {
                        pane.child(
                            div()
                                .size_full()
                                .flex()
                                .flex_col()
                                .items_center()
                                .justify_center()
                                .gap(px(8.0))
                                .text_color(theme.muted_foreground)
                                .child(svg().path("icons/terminal.svg").size(px(28.0)).opacity(0.4))
                                .child(div().text_size(px(12.0)).child(match status {
                                    Some("Starting") => "Starting terminal…",
                                    _ if terminal_id.is_some() => "Opening terminal…",
                                    _ => "No terminal in this Window",
                                }))
                                .child(
                                    div()
                                        .id("new-terminal-empty")
                                        .mt(px(4.0))
                                        .rounded(px(8.0))
                                        .bg(theme.accent)
                                        .px(px(12.0))
                                        .py(px(7.0))
                                        .text_color(theme.foreground)
                                        .text_size(px(12.0))
                                        .cursor_pointer()
                                        .on_click(
                                            cx.listener(|this, _, _, _| this.create_terminal()),
                                        )
                                        .child("New terminal"),
                                ),
                        )
                    }),
            )
            .when_some(self.render_connection_notice(), |workspace, notice| {
                workspace.child(notice)
            })
            .when_some(self.render_terminal_picker(cx), |workspace, picker| {
                workspace.child(picker)
            })
            .when_some(self.render_session_switcher(cx), |workspace, switcher| {
                workspace.child(switcher)
            })
            .when_some(self.render_settings(), |workspace, settings| {
                workspace.child(settings)
            })
    }
}

impl Render for YaadeApp {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .flex()
            .flex_col()
            .overflow_hidden()
            .bg(self.theme.background)
            .text_color(self.theme.foreground)
            .font_family("Geist")
            .text_size(px(13.0))
            .on_action(cx.listener(|this, _: &NewSession, _, _| {
                this.host.action(HostAction::CreateSession);
            }))
            .on_action(cx.listener(|this, _: &NewWindow, _, _| this.create_window()))
            .on_action(cx.listener(|this, _: &NewTerminal, _, _| this.create_terminal()))
            .on_action(cx.listener(|this, _: &CloseTerminal, _, _| this.close_terminal()))
            .child(self.render_header(cx))
            .child(self.render_workspace(cx))
    }
}

fn cell_metrics(window: &mut Window) -> Option<(f32, f32)> {
    let mut style = window.text_style();
    let font = default_terminal_font();
    style.font_family = font.family.clone();
    style.font_features = crate::terminal::default_terminal_font_features();
    style.font_fallbacks = font.fallbacks.clone();
    style.font_size = px(13.0).into();
    style.line_height = relative(1.0);

    let rem_size = window.rem_size();
    let font_size = style.font_size.to_pixels(rem_size);
    let line_height = style.line_height.to_pixels(style.font_size, rem_size);
    let run = style.to_run(1);
    let lines = window
        .text_system()
        .shape_text(SharedString::from("M"), font_size, &[run], None, Some(1))
        .ok()?;
    Some((
        f32::from(lines.first()?.width()).max(1.0),
        f32::from(line_height).max(1.0),
    ))
}
