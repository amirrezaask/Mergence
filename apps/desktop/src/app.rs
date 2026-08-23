use std::{
    collections::{HashMap, HashSet},
    ops::Range,
    time::Duration,
};

use gpui::{
    Animation, AnimationExt as _, AnyElement, AppContext as _, Bounds, BoxShadow,
    ClickEvent, Context, CursorStyle, DragMoveEvent, ElementInputHandler, EntityInputHandler,
    FocusHandle, FontStyle, FontWeight, HighlightStyle, Hsla, IntoElement, KeyBinding,
    KeyDownEvent, Keystroke, MouseButton, MouseDownEvent, ParentElement as _, Pixels, Point,
    Render, Rgba,
    SharedString, StrikethroughStyle, Styled as _, StyledText, TextRun, Timer, UTF16Selection,
    UnderlineStyle, Window, WindowControlArea, actions, canvas, div, ease_out_quint, font, point,
    prelude::*, pulsating_between, px, relative, svg,
};

use crate::host::{HostClient, HostConfig};
use crate::model::{
    MuxTerminal, SessionSnapshot, TerminalCell, TerminalColor, TerminalCursor, TerminalModes,
    TerminalRow, TerminalSemanticSnapshot, TerminalStreamMessage, WorkspaceSelection,
    active_snapshot,
};
use crate::realtime::{RealtimeClient, RealtimeEvent};
use crate::semantic::{StoreApplyResult, TerminalSemanticStore};
use crate::theme::{ColorScheme, NativeTheme};
use crate::tiling::{
    Edge, MAX_TERMINAL_TILES, PanelId, PanelNode, TerminalPaneView, TerminalWorkspace,
};

const UI_FONT: &str = "Geist";
const MONO_FONT: &str = "Geist Mono";
const DEFAULT_TERMINAL_FONT_SIZE: f32 = 12.0;
const MIN_TERMINAL_FONT_SIZE: f32 = 8.0;
const MAX_TERMINAL_FONT_SIZE: f32 = 24.0;
const TERMINAL_FONT_SIZE_STEP: f32 = 1.0;
const TERMINAL_PADDING_PX: f32 = 8.0;
const TERMINAL_RESIZE_DEBOUNCE_MS: u64 = 75;
const LAYOUT_SAVE_DEBOUNCE_MS: u64 = 180;

actions!(
    yaade_desktop,
    [
        ZoomIn,
        ZoomOut,
        ResetZoom,
        PasteTerminal,
        SplitPaneRight,
        SplitPaneDown,
        TogglePaneZoom,
    ]
);

pub fn desktop_key_bindings() -> [KeyBinding; 8] {
    [
        KeyBinding::new("secondary-=", ZoomIn, None),
        KeyBinding::new("secondary-+", ZoomIn, None),
        KeyBinding::new("secondary--", ZoomOut, None),
        KeyBinding::new("secondary-0", ResetZoom, None),
        KeyBinding::new("secondary-v", PasteTerminal, None),
        KeyBinding::new("secondary-d", SplitPaneRight, None),
        KeyBinding::new("secondary-shift-d", SplitPaneDown, None),
        KeyBinding::new("secondary-shift-enter", TogglePaneZoom, None),
    ]
}

pub fn zoom_key_bindings() -> [KeyBinding; 4] {
    let bindings = desktop_key_bindings();
    [
        bindings[0].clone(),
        bindings[1].clone(),
        bindings[2].clone(),
        bindings[3].clone(),
    ]
}

#[derive(Clone, Debug)]
enum WorkspaceState {
    Loading,
    Ready,
    Error(String),
}

#[derive(Clone, Debug)]
enum TerminalLoadState {
    Loading,
    Ready,
    Unavailable(String),
}

#[derive(Clone, Debug)]
struct TerminalViewState {
    pty_id: String,
    title: String,
    load_state: TerminalLoadState,
    semantic: TerminalSemanticStore,
    replay_floor: u64,
    last_grid: Option<(usize, usize)>,
    resize_revision: u64,
}

impl TerminalViewState {
    fn loading(pty_id: String, title: String) -> Self {
        Self {
            pty_id,
            title,
            load_state: TerminalLoadState::Loading,
            semantic: TerminalSemanticStore::default(),
            replay_floor: 0,
            last_grid: None,
            resize_revision: 0,
        }
    }
}

#[derive(Clone, Debug)]
struct SplitResizeDrag {
    path: Vec<usize>,
    separator_index: usize,
    horizontal: bool,
    origin: Point<Pixels>,
    available: Pixels,
    ratios: Vec<f32>,
}

#[derive(Clone, Debug)]
struct PaneDrag {
    terminal_id: String,
    title: String,
}

struct DragPreview {
    label: String,
    background: Hsla,
    foreground: Hsla,
    border: Hsla,
}

#[derive(Debug)]
struct WorkspacePayload {
    snapshots: Vec<SessionSnapshot>,
    selection: WorkspaceSelection,
}

#[derive(Clone, Copy, Debug)]
enum Mutation {
    CreateSession,
    CreateTab,
    ArchiveTab,
}

pub struct DesktopApp {
    config: HostConfig,
    client: HostClient,
    realtime: RealtimeClient,
    theme: NativeTheme,
    focus_handle: FocusHandle,
    terminal_font_size: f32,
    terminal_cell_width: f32,
    terminal_line_height: f32,
    workspace_state: WorkspaceState,
    snapshots: Vec<SessionSnapshot>,
    selection: WorkspaceSelection,
    terminal_workspace: TerminalWorkspace,
    workspace_tab_id: Option<String>,
    workspace_server_revision: Option<u64>,
    workspace_server_layout: Option<String>,
    workspace_layout_dirty: bool,
    terminal_views: HashMap<String, TerminalViewState>,
    attached_ptys: HashSet<String>,
    split_bounds: HashMap<String, Bounds<Pixels>>,
    ime_composition: String,
    ime_marked_range: Option<Range<usize>>,
    session_switcher_open: bool,
    session_switcher_closing: bool,
    session_switcher_transition: u64,
    settings_open: bool,
    settings_closing: bool,
    settings_transition: u64,
    action_error: Option<String>,
    workspace_request: u64,
    workspace_reload_revision: u64,
    terminal_request: u64,
    terminal_requests: HashMap<String, u64>,
    layout_save_revision: u64,
    motion_revision: u64,
    reduced_motion: bool,
    cursor_blink_on: bool,
    realtime_connected: bool,
}

impl DesktopApp {
    pub fn new(
        config: HostConfig,
        theme: NativeTheme,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let client = HostClient::new(config.clone());
        let realtime = RealtimeClient::spawn(config.clone());
        let focus_handle = cx.focus_handle();
        focus_handle.focus(window);
        let preview = std::env::var("YAADE_DESKTOP_PREVIEW").unwrap_or_default();
        let preview_session_switcher = preview == "session-switcher";
        let preview_settings = preview == "settings";
        let mut app = Self {
            config,
            client,
            realtime,
            theme,
            focus_handle,
            terminal_font_size: DEFAULT_TERMINAL_FONT_SIZE,
            terminal_cell_width: DEFAULT_TERMINAL_FONT_SIZE * 0.6,
            terminal_line_height: DEFAULT_TERMINAL_FONT_SIZE * 1.25,
            workspace_state: WorkspaceState::Loading,
            snapshots: Vec::new(),
            selection: WorkspaceSelection {
                session_id: None,
                tab_id: None,
                terminal_id: None,
            },
            terminal_workspace: TerminalWorkspace::new(),
            workspace_tab_id: None,
            workspace_server_revision: None,
            workspace_server_layout: None,
            workspace_layout_dirty: false,
            terminal_views: HashMap::new(),
            attached_ptys: HashSet::new(),
            split_bounds: HashMap::new(),
            ime_composition: String::new(),
            ime_marked_range: None,
            session_switcher_open: preview_session_switcher,
            session_switcher_closing: false,
            session_switcher_transition: 0,
            settings_open: preview_settings,
            settings_closing: false,
            settings_transition: 0,
            action_error: None,
            workspace_request: 0,
            workspace_reload_revision: 0,
            terminal_request: 0,
            terminal_requests: HashMap::new(),
            layout_save_revision: 0,
            motion_revision: u64::from(preview_session_switcher || preview_settings),
            reduced_motion: std::env::var("YAADE_REDUCED_MOTION")
                .is_ok_and(|value| matches!(value.as_str(), "1" | "true" | "yes")),
            cursor_blink_on: true,
            realtime_connected: false,
        };
        app.start_cursor_blink(cx);
        app.start_realtime_events(cx);
        app.reload_workspace(None, cx);
        app
    }

    fn start_cursor_blink(&mut self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            loop {
                Timer::after(Duration::from_millis(530)).await;
                if this
                    .update(cx, |app, cx| {
                        app.cursor_blink_on = !app.cursor_blink_on;
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
    }

    fn start_realtime_events(&mut self, cx: &mut Context<Self>) {
        let events = self.realtime.event_receiver();
        cx.spawn(async move |this, cx| {
            while let Ok(first) = events.recv().await {
                let mut batch = vec![first];
                while batch.len() < 64 {
                    match events.try_recv() {
                        Ok(event) => batch.push(event),
                        Err(_) => break,
                    }
                }
                if this
                    .update(cx, |app, cx| {
                        for event in batch {
                            app.handle_realtime_event(event, cx);
                        }
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
    }

    fn handle_realtime_event(&mut self, event: RealtimeEvent, cx: &mut Context<Self>) {
        match event {
            RealtimeEvent::Connected(snapshots) => {
                self.realtime_connected = true;
                let requested = self.selection.session_id.clone();
                self.apply_workspace_snapshots(snapshots, requested.as_deref(), cx);
            }
            RealtimeEvent::Disconnected => {
                self.realtime_connected = false;
            }
            RealtimeEvent::Semantic(message) => self.apply_semantic_message(message, cx),
            RealtimeEvent::AttachResult {
                terminal_id,
                result,
            } => self.apply_attach_result(&terminal_id, result, cx),
            RealtimeEvent::WorkspaceInvalidated => self.schedule_workspace_reload(cx),
            RealtimeEvent::TerminalExited {
                terminal_id,
                exit_code,
                signal,
            } => {
                if let Some((_, state)) = self
                    .terminal_views
                    .iter_mut()
                    .find(|(_, state)| state.pty_id == terminal_id)
                {
                    let signal = signal.map_or_else(String::new, |value| format!(" (signal {value})"));
                    state.load_state = TerminalLoadState::Unavailable(format!(
                        "Process exited with status {exit_code}{signal}."
                    ));
                }
                self.schedule_workspace_reload(cx);
            }
            RealtimeEvent::Error(message) => {
                self.action_error = Some(message);
                self.bump_motion();
            }
        }
    }

    fn schedule_workspace_reload(&mut self, cx: &mut Context<Self>) {
        self.workspace_reload_revision = self.workspace_reload_revision.wrapping_add(1);
        let revision = self.workspace_reload_revision;
        cx.spawn(async move |this, cx| {
            Timer::after(Duration::from_millis(55)).await;
            let _ = this.update(cx, |app, cx| {
                if app.workspace_reload_revision == revision {
                    let requested = app.selection.session_id.clone();
                    app.reload_workspace(requested, cx);
                }
            });
        })
        .detach();
    }

    fn set_session_switcher_open(&mut self, open: bool, cx: &mut Context<Self>) {
        self.session_switcher_transition = self.session_switcher_transition.wrapping_add(1);
        let transition = self.session_switcher_transition;
        self.bump_motion();
        if open {
            self.session_switcher_open = true;
            self.session_switcher_closing = false;
            cx.notify();
            return;
        }
        if !self.session_switcher_open {
            return;
        }
        self.session_switcher_closing = true;
        let duration = if self.reduced_motion {
            1
        } else {
            self.theme.motion.hot_ms
        };
        cx.notify();
        cx.spawn(async move |this, cx| {
            Timer::after(Duration::from_millis(duration.max(1))).await;
            let _ = this.update(cx, |app, cx| {
                if app.session_switcher_transition == transition {
                    app.session_switcher_open = false;
                    app.session_switcher_closing = false;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn set_settings_open(&mut self, open: bool, cx: &mut Context<Self>) {
        self.settings_transition = self.settings_transition.wrapping_add(1);
        let transition = self.settings_transition;
        self.bump_motion();
        if open {
            self.settings_open = true;
            self.settings_closing = false;
            cx.notify();
            return;
        }
        if !self.settings_open {
            return;
        }
        self.settings_closing = true;
        let duration = if self.reduced_motion {
            1
        } else {
            self.theme.motion.hot_ms
        };
        cx.notify();
        cx.spawn(async move |this, cx| {
            Timer::after(Duration::from_millis(duration.max(1))).await;
            let _ = this.update(cx, |app, cx| {
                if app.settings_transition == transition {
                    app.settings_open = false;
                    app.settings_closing = false;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn motion(&self, duration_ms: u64) -> Animation {
        Animation::new(Duration::from_millis(if self.reduced_motion {
            1
        } else {
            duration_ms.max(1)
        }))
        .with_easing(ease_out_quint())
    }

    fn bump_motion(&mut self) {
        self.motion_revision = self.motion_revision.wrapping_add(1);
    }

    fn reload_workspace(&mut self, requested_session: Option<String>, cx: &mut Context<Self>) {
        self.workspace_request = self.workspace_request.wrapping_add(1);
        let request = self.workspace_request;
        if self.snapshots.is_empty() {
            self.workspace_state = WorkspaceState::Loading;
        }
        self.action_error = None;
        self.bump_motion();
        let client = self.client.clone();
        let load = cx.background_spawn(async move {
            client.list_sessions().map(|snapshots| WorkspacePayload {
                selection: WorkspaceSelection::resolve(&snapshots, requested_session.as_deref()),
                snapshots,
            })
        });
        cx.spawn(async move |this, cx| {
            let result = load.await;
            let _ = this.update(cx, |app, cx| {
                if request != app.workspace_request {
                    return;
                }
                match result {
                    Ok(payload) => app.apply_workspace_payload(payload, cx),
                    Err(error) => {
                        if app.snapshots.is_empty() {
                            app.workspace_state = WorkspaceState::Error(error.to_string());
                        } else {
                            app.action_error = Some(error.to_string());
                        }
                    }
                }
                app.bump_motion();
                cx.notify();
            });
        })
        .detach();
    }

    fn apply_workspace_snapshots(
        &mut self,
        snapshots: Vec<SessionSnapshot>,
        requested_session: Option<&str>,
        cx: &mut Context<Self>,
    ) {
        let selection = WorkspaceSelection::resolve(&snapshots, requested_session);
        self.apply_workspace_payload(
            WorkspacePayload {
                snapshots,
                selection,
            },
            cx,
        );
    }

    fn apply_workspace_payload(&mut self, payload: WorkspacePayload, cx: &mut Context<Self>) {
        self.snapshots = payload.snapshots;
        self.selection = payload.selection;
        self.workspace_state = WorkspaceState::Ready;
        self.reconcile_terminal_workspace(cx);
    }

    fn reconcile_terminal_workspace(&mut self, cx: &mut Context<Self>) {
        let Some(snapshot) = active_snapshot(&self.snapshots, &self.selection).cloned() else {
            self.workspace_tab_id = None;
            self.terminal_workspace = TerminalWorkspace::new();
            self.reconcile_terminal_views(cx);
            return;
        };
        let Some(tab_id) = self.selection.tab_id.clone() else {
            self.workspace_tab_id = None;
            self.terminal_workspace = TerminalWorkspace::new();
            self.reconcile_terminal_views(cx);
            return;
        };
        let Some(tab) = snapshot.tabs.iter().find(|tab| tab.id == tab_id) else {
            return;
        };
        let mut terminals = snapshot
            .mux_terminals
            .iter()
            .filter(|terminal| {
                terminal.archived_at.is_none() && terminal.tab_id.as_deref() == Some(tab_id.as_str())
            })
            .cloned()
            .collect::<Vec<_>>();
        terminals.sort_by(|left, right| left.position.total_cmp(&right.position));
        let live_ids = terminals
            .iter()
            .map(|terminal| terminal.id.clone())
            .collect::<Vec<_>>();
        let local_layout = (self.workspace_tab_id.as_deref() == Some(tab_id.as_str()))
            .then(|| self.terminal_workspace.serialize().ok())
            .flatten();
        self.terminal_workspace = TerminalWorkspace::restore(
            local_layout.as_deref().or(tab.layout_json.as_deref()),
            &live_ids,
        );
        self.workspace_tab_id = Some(tab_id);
        self.selection.terminal_id = self
            .terminal_workspace
            .view(self.terminal_workspace.focused_panel_id)
            .and_then(TerminalPaneView::terminal_id)
            .map(str::to_string)
            .or_else(|| terminals.first().map(|terminal| terminal.id.clone()));
        self.reconcile_terminal_views(cx);
    }

    fn reconcile_terminal_views(&mut self, cx: &mut Context<Self>) {
        let desired_ids = self
            .terminal_workspace
            .terminal_ids()
            .into_iter()
            .collect::<HashSet<_>>();
        let terminals = active_snapshot(&self.snapshots, &self.selection)
            .map(|snapshot| {
                snapshot
                    .mux_terminals
                    .iter()
                    .filter(|terminal| desired_ids.contains(&terminal.id))
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mut desired_ptys = HashSet::new();
        for terminal in terminals {
            let Some(pty_id) = terminal.output.pty_id.clone() else {
                continue;
            };
            desired_ptys.insert(pty_id.clone());
            let needs_load = self
                .terminal_views
                .get(&terminal.id)
                .is_none_or(|state| state.pty_id != pty_id);
            if needs_load {
                self.terminal_views.insert(
                    terminal.id.clone(),
                    TerminalViewState::loading(pty_id.clone(), terminal.title.clone()),
                );
                self.start_terminal_http_load(
                    terminal.id.clone(),
                    pty_id.clone(),
                    terminal.title,
                    cx,
                );
            }
            if self.attached_ptys.insert(pty_id.clone()) {
                let replay_floor = self
                    .terminal_views
                    .get(&terminal.id)
                    .map_or(0, |state| state.replay_floor);
                if !self.realtime.attach(pty_id, replay_floor) {
                    self.action_error = Some(
                        "Realtime command queue is full; terminal attachment will retry."
                            .to_string(),
                    );
                }
            }
        }
        let detached = self
            .attached_ptys
            .difference(&desired_ptys)
            .cloned()
            .collect::<Vec<_>>();
        for pty_id in detached {
            self.realtime.detach(pty_id.clone());
            self.attached_ptys.remove(&pty_id);
        }
        self.terminal_views
            .retain(|terminal_id, _| desired_ids.contains(terminal_id));
        cx.notify();
    }

    fn start_terminal_http_load(
        &mut self,
        mux_terminal_id: String,
        pty_id: String,
        fallback_title: String,
        cx: &mut Context<Self>,
    ) {
        self.terminal_request = self.terminal_request.wrapping_add(1);
        let request = self.terminal_request;
        self.terminal_requests
            .insert(mux_terminal_id.clone(), request);
        let client = self.client.clone();
        let load_pty_id = pty_id.clone();
        let load = cx.background_spawn(async move { client.attach_terminal(&load_pty_id) });
        cx.spawn(async move |this, cx| {
            let result = load.await;
            let _ = this.update(cx, |app, cx| {
                if app.terminal_requests.get(&mux_terminal_id) != Some(&request) {
                    return;
                }
                match result {
                    Ok(attached) => app.apply_attach_result(&pty_id, attached, cx),
                    Err(error) => {
                        if let Some(state) = app.terminal_views.get_mut(&mux_terminal_id)
                            && state.semantic.snapshot().is_none()
                        {
                            state.title = fallback_title;
                            state.load_state = TerminalLoadState::Unavailable(error.to_string());
                        }
                    }
                }
                app.bump_motion();
                cx.notify();
            });
        })
        .detach();
    }

    fn apply_attach_result(
        &mut self,
        pty_id: &str,
        result: Option<crate::model::TerminalAttachResult>,
        _cx: &mut Context<Self>,
    ) {
        let Some((mux_terminal_id, state)) = self
            .terminal_views
            .iter_mut()
            .find(|(_, state)| state.pty_id == pty_id)
        else {
            return;
        };
        let Some(mut attached) = result else {
            if state.semantic.snapshot().is_none() {
                state.load_state = TerminalLoadState::Unavailable(
                    "The host no longer has this terminal.".to_string(),
                );
            }
            return;
        };
        state.replay_floor = state.replay_floor.max(attached.last_sequence);
        if let Some(title) = attached.title.clone() {
            state.title = title;
        }
        let snapshot = attached
            .semantic_snapshot
            .take()
            .or_else(|| ansi_replay_snapshot(&attached, self.theme.scheme));
        if let Some(snapshot) = snapshot {
            let result = state.semantic.replace_attached_snapshot(
                pty_id.to_string(),
                attached.owner_epoch,
                attached.terminal_epoch,
                snapshot,
            );
            if result != StoreApplyResult::ResyncRequired {
                state.load_state = TerminalLoadState::Ready;
            }
        } else if state.semantic.snapshot().is_none() {
            state.load_state = TerminalLoadState::Unavailable(
                "The terminal has no replay or semantic screen yet.".to_string(),
            );
        }
        self.terminal_requests.remove(mux_terminal_id);
    }

    fn apply_semantic_message(
        &mut self,
        message: TerminalStreamMessage,
        _cx: &mut Context<Self>,
    ) {
        let terminal_id = match &message {
            TerminalStreamMessage::Snapshot(message) => message.terminal_id.as_str(),
            TerminalStreamMessage::Patch(message) => message.terminal_id.as_str(),
            TerminalStreamMessage::ResyncRequired(message) => message.terminal_id.as_str(),
        };
        let Some((_, state)) = self
            .terminal_views
            .iter_mut()
            .find(|(_, state)| state.pty_id == terminal_id)
        else {
            return;
        };
        let result = match message {
            TerminalStreamMessage::Snapshot(message) => state.semantic.apply_snapshot(message),
            TerminalStreamMessage::Patch(message) => state.semantic.apply_patch(message),
            TerminalStreamMessage::ResyncRequired(_) => StoreApplyResult::ResyncRequired,
        };
        if result == StoreApplyResult::Applied {
            state.load_state = TerminalLoadState::Ready;
            if let Some(title) = state
                .semantic
                .snapshot()
                .and_then(|snapshot| snapshot.title.clone())
            {
                state.title = title;
            }
        } else if result == StoreApplyResult::ResyncRequired {
            self.realtime
                .resync(state.pty_id.clone(), state.replay_floor);
        }
    }

    fn focused_terminal_id(&self) -> Option<&str> {
        self.terminal_workspace
            .view(self.terminal_workspace.focused_panel_id)
            .and_then(TerminalPaneView::terminal_id)
    }

    fn focused_terminal_modes(&self) -> TerminalModes {
        self.focused_terminal_id()
            .and_then(|terminal_id| self.terminal_views.get(terminal_id))
            .and_then(|state| state.semantic.snapshot())
            .map(|snapshot| snapshot.modes.clone())
            .unwrap_or_default()
    }

    fn select_session(&mut self, session_id: &str, cx: &mut Context<Self>) {
        self.selection = WorkspaceSelection::resolve(&self.snapshots, Some(session_id));
        self.workspace_tab_id = None;
        self.set_session_switcher_open(false, cx);
        self.reconcile_terminal_workspace(cx);
        cx.notify();
    }

    fn select_tab(&mut self, tab_id: &str, cx: &mut Context<Self>) {
        let Some(snapshot) = active_snapshot(&self.snapshots, &self.selection) else {
            return;
        };
        let Some(tab) = snapshot
            .tabs
            .iter()
            .find(|tab| tab.id == tab_id && tab.archived_at.is_none())
        else {
            return;
        };
        let mut terminals = snapshot
            .mux_terminals
            .iter()
            .filter(|terminal| {
                terminal.archived_at.is_none() && terminal.tab_id.as_deref() == Some(tab_id)
            })
            .collect::<Vec<_>>();
        terminals.sort_by(|left, right| left.position.total_cmp(&right.position));
        let terminal = tab
            .active_mux_terminal_id
            .as_deref()
            .and_then(|id| terminals.iter().copied().find(|terminal| terminal.id == id))
            .or_else(|| terminals.first().copied());
        self.selection.tab_id = Some(tab.id.clone());
        self.selection.terminal_id = terminal.map(|value| value.id.clone());
        self.workspace_tab_id = None;
        self.bump_motion();
        self.reconcile_terminal_workspace(cx);
        cx.notify();
    }

    fn run_mutation(&mut self, mutation: Mutation, cx: &mut Context<Self>) {
        let client = self.client.clone();
        let session_id = self.selection.session_id.clone();
        let tab_id = self.selection.tab_id.clone();
        self.action_error = None;
        let task = cx.background_spawn(async move {
            match mutation {
                Mutation::CreateSession => client.create_session().map(|session| Some(session.id)),
                Mutation::CreateTab => {
                    let session_id = session_id
                        .as_deref()
                        .ok_or_else(|| anyhow::anyhow!("Choose a session first."))?;
                    client
                        .create_tab(session_id)
                        .map(|_| Some(session_id.to_string()))
                }
                Mutation::ArchiveTab => {
                    let tab_id = tab_id
                        .as_deref()
                        .ok_or_else(|| anyhow::anyhow!("Choose a Window first."))?;
                    client.archive_tab(tab_id).map(|tab| Some(tab.session_id))
                }
            }
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |app, cx| match result {
                Ok(requested_session) => app.reload_workspace(requested_session, cx),
                Err(error) => {
                    app.action_error = Some(error.to_string());
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn focus_panel(
        &mut self,
        panel_id: PanelId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.terminal_workspace.focus(panel_id) {
            return;
        }
        self.selection.terminal_id = self
            .terminal_workspace
            .view(panel_id)
            .and_then(TerminalPaneView::terminal_id)
            .map(str::to_string);
        self.ime_composition.clear();
        self.ime_marked_range = None;
        self.focus_handle.focus(window);
        self.schedule_layout_save(cx);
        if let (Some(session_id), terminal_id) = (
            self.selection.session_id.clone(),
            self.selection.terminal_id.clone(),
        ) {
            let client = self.client.clone();
            cx.background_spawn(async move {
                let _ = client.select_terminal(&session_id, terminal_id.as_deref());
            })
            .detach();
        }
        cx.notify();
    }

    fn split_panel_and_create(&mut self, panel_id: PanelId, edge: Edge, cx: &mut Context<Self>) {
        if self.terminal_workspace.pane_count() >= MAX_TERMINAL_TILES {
            self.action_error = Some(format!(
                "A Window can show at most {MAX_TERMINAL_TILES} terminal panes."
            ));
            cx.notify();
            return;
        }
        let Some(target_panel) = self.terminal_workspace.split_panel(panel_id, edge) else {
            return;
        };
        self.schedule_layout_save(cx);
        self.create_terminal_in_panel(target_panel, cx);
    }

    fn create_terminal_in_panel(&mut self, target_panel: PanelId, cx: &mut Context<Self>) {
        let Some(session_id) = self.selection.session_id.clone() else {
            return;
        };
        let Some(tab_id) = self.selection.tab_id.clone() else {
            return;
        };
        let client = self.client.clone();
        let create_session_id = session_id.clone();
        let create_tab_id = tab_id.clone();
        let task = cx.background_spawn(async move {
            client.create_terminal(&create_session_id, &create_tab_id)
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |app, cx| match result {
                Ok(terminal) => {
                    if app.selection.session_id.as_deref() == Some(session_id.as_str())
                        && app.selection.tab_id.as_deref() == Some(tab_id.as_str())
                    {
                        if let Some(snapshot) = app
                            .snapshots
                            .iter_mut()
                            .find(|snapshot| snapshot.session.id == session_id)
                            && !snapshot
                                .mux_terminals
                                .iter()
                                .any(|existing| existing.id == terminal.id)
                        {
                            snapshot.mux_terminals.push(terminal.clone());
                        }
                        app.terminal_workspace
                            .open_terminal_in_panel(target_panel, terminal.id.clone());
                        app.selection.terminal_id = Some(terminal.id);
                        app.reconcile_terminal_views(cx);
                        app.schedule_layout_save(cx);
                    }
                    app.schedule_workspace_reload(cx);
                    cx.notify();
                }
                Err(error) => {
                    app.action_error = Some(error.to_string());
                    cx.notify();
                }
            });
        })
        .detach();
        cx.notify();
    }

    fn close_panel(&mut self, panel_id: PanelId, cx: &mut Context<Self>) {
        let view = self.terminal_workspace.view(panel_id).cloned();
        let Some(view) = view else { return };
        let terminal_id = view.terminal_id().map(str::to_string);
        self.terminal_workspace.close_panel(panel_id);
        self.selection.terminal_id = self
            .terminal_workspace
            .view(self.terminal_workspace.focused_panel_id)
            .and_then(TerminalPaneView::terminal_id)
            .map(str::to_string);
        self.schedule_layout_save(cx);
        let Some(terminal_id) = terminal_id else {
            self.reconcile_terminal_views(cx);
            return;
        };
        if let Some(state) = self.terminal_views.remove(&terminal_id) {
            self.realtime.detach(state.pty_id.clone());
            self.attached_ptys.remove(&state.pty_id);
        }
        for snapshot in &mut self.snapshots {
            snapshot
                .mux_terminals
                .retain(|terminal| terminal.id != terminal_id);
        }
        let client = self.client.clone();
        let requested_session = self.selection.session_id.clone();
        let task = cx.background_spawn(async move { client.close_terminal(&terminal_id) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |app, cx| match result {
                Ok(_) => app.reload_workspace(requested_session, cx),
                Err(error) => {
                    app.action_error = Some(error.to_string());
                    app.reload_workspace(requested_session, cx);
                }
            });
        })
        .detach();
        cx.notify();
    }

    fn toggle_panel_zoom(&mut self, panel_id: PanelId, cx: &mut Context<Self>) {
        if self.terminal_workspace.toggle_zoom(panel_id) {
            self.schedule_layout_save(cx);
            cx.notify();
        }
    }

    fn dock_terminal(
        &mut self,
        terminal_id: &str,
        target: PanelId,
        edge: Option<Edge>,
        cx: &mut Context<Self>,
    ) {
        if self
            .terminal_workspace
            .dock_terminal(terminal_id, target, edge)
        {
            self.selection.terminal_id = Some(terminal_id.to_string());
            self.schedule_layout_save(cx);
            cx.notify();
        }
    }

    fn resize_split_from_drag(
        &mut self,
        event: &DragMoveEvent<SplitResizeDrag>,
        cx: &mut Context<Self>,
    ) {
        let drag = event.drag(cx).clone();
        if drag.separator_index == 0 || drag.separator_index >= drag.ratios.len() {
            return;
        }
        if drag.available <= px(1.0) {
            return;
        }
        let axis_position = if drag.horizontal {
            event.event.position.x - drag.origin.x
        } else {
            event.event.position.y - drag.origin.y
        };
        let left_index = drag.separator_index - 1;
        let right_index = drag.separator_index;
        let prefix = drag.ratios[..left_index].iter().sum::<f32>();
        let separator_offset = px(4.0 * left_index as f32);
        let desired_cumulative = (axis_position - separator_offset) / drag.available;
        let pair = drag.ratios[left_index] + drag.ratios[right_index];
        let minimum = 0.08_f32.min(pair * 0.45);
        let left = (desired_cumulative - prefix).clamp(minimum, pair - minimum);
        let mut ratios = drag.ratios;
        ratios[left_index] = left;
        ratios[right_index] = pair - left;
        if self
            .terminal_workspace
            .set_split_ratios(&drag.path, &ratios)
        {
            self.schedule_layout_save(cx);
            cx.notify();
        }
    }

    fn schedule_layout_save(&mut self, cx: &mut Context<Self>) {
        let Some(tab_id) = self.selection.tab_id.clone() else {
            return;
        };
        let Ok(layout_json) = self.terminal_workspace.serialize() else {
            return;
        };
        self.layout_save_revision = self.layout_save_revision.wrapping_add(1);
        let save_revision = self.layout_save_revision;
        cx.spawn(async move |this, cx| {
            Timer::after(Duration::from_millis(LAYOUT_SAVE_DEBOUNCE_MS)).await;
            let _ = this.update(cx, |app, cx| {
                if app.layout_save_revision != save_revision
                    || app.selection.tab_id.as_deref() != Some(tab_id.as_str())
                {
                    return;
                }
                app.save_layout_now(tab_id, layout_json, save_revision, cx);
            });
        })
        .detach();
    }

    fn save_layout_now(
        &mut self,
        tab_id: String,
        layout_json: String,
        save_revision: u64,
        cx: &mut Context<Self>,
    ) {
        let observed_revision = self
            .snapshots
            .iter()
            .flat_map(|snapshot| &snapshot.tabs)
            .find(|tab| tab.id == tab_id)
            .and_then(|tab| tab.revision);
        let client = self.client.clone();
        let save_tab_id = tab_id.clone();
        let save_layout = layout_json.clone();
        let task = cx.background_spawn(async move {
            client.save_tab_layout(&save_tab_id, &save_layout, observed_revision)
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |app, cx| match result {
                Ok(saved) => {
                    if let Some(tab) = app
                        .snapshots
                        .iter_mut()
                        .flat_map(|snapshot| &mut snapshot.tabs)
                        .find(|tab| tab.id == saved.id)
                    {
                        *tab = saved;
                    }
                }
                Err(error) if app.layout_save_revision == save_revision => {
                    app.action_error = Some(format!("Could not save pane layout: {error}"));
                    cx.notify();
                }
                Err(_) => {}
            });
        })
        .detach();
    }

    fn record_split_bounds(&mut self, path: Vec<usize>, bounds: Bounds<Pixels>) {
        self.split_bounds.insert(split_path_key(&path), bounds);
    }

    fn record_terminal_bounds(
        &mut self,
        mux_terminal_id: &str,
        bounds: Bounds<Pixels>,
        cx: &mut Context<Self>,
    ) {
        let width = (bounds.size.width - px(TERMINAL_PADDING_PX * 2.0)).max(px(1.0));
        let height = (bounds.size.height - px(TERMINAL_PADDING_PX * 2.0)).max(px(1.0));
        let cols = ((width / px(self.terminal_cell_width.max(1.0))).floor() as usize).clamp(2, 500);
        let rows = ((height / px(self.terminal_line_height.max(1.0))).floor() as usize).clamp(1, 300);
        let Some(state) = self.terminal_views.get_mut(mux_terminal_id) else {
            return;
        };
        if state.last_grid == Some((cols, rows)) {
            return;
        }
        state.last_grid = Some((cols, rows));
        state.resize_revision = state.resize_revision.wrapping_add(1);
        let revision = state.resize_revision;
        let terminal_id = mux_terminal_id.to_string();
        cx.spawn(async move |this, cx| {
            Timer::after(Duration::from_millis(TERMINAL_RESIZE_DEBOUNCE_MS)).await;
            let _ = this.update(cx, |app, cx| {
                let Some(state) = app.terminal_views.get(&terminal_id) else {
                    return;
                };
                if state.resize_revision != revision || state.last_grid != Some((cols, rows)) {
                    return;
                }
                let pty_id = state.pty_id.clone();
                if app.realtime.is_connected() && app.realtime.resize(pty_id.clone(), cols, rows) {
                    return;
                }
                let client = app.client.clone();
                cx.background_spawn(async move {
                    let _ = client.resize_terminal(&pty_id, cols, rows);
                })
                .detach();
            });
        })
        .detach();
    }

    fn send_terminal_input(&mut self, data: String, cx: &mut Context<Self>) {
        if data.is_empty() {
            return;
        }
        let Some(terminal_id) = self.focused_terminal_id().map(str::to_string) else {
            return;
        };
        let Some(state) = self.terminal_views.get(&terminal_id) else {
            return;
        };
        let pty_id = state.pty_id.clone();
        if self.realtime.is_connected() && self.realtime.write(pty_id.clone(), data.clone()) {
            return;
        }
        let client = self.client.clone();
        let task = cx.background_spawn(async move { client.write_terminal(&pty_id, &data) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            if let Err(error) = result {
                let _ = this.update(cx, |app, cx| {
                    app.action_error = Some(format!("Terminal input failed: {error}"));
                    cx.notify();
                });
            }
        })
        .detach();
    }

    fn paste_terminal(&mut self, cx: &mut Context<Self>) {
        let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) else {
            return;
        };
        let data = if self.focused_terminal_modes().bracketed_paste {
            format!("\u{1b}[200~{text}\u{1b}[201~")
        } else {
            text
        };
        self.send_terminal_input(data, cx);
    }

    fn handle_terminal_key_down(
        &mut self,
        event: &KeyDownEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(data) = terminal_key_data(&event.keystroke, &self.focused_terminal_modes()) {
            cx.stop_propagation();
            self.send_terminal_input(data, cx);
        }
    }

    fn render_icon(path: &'static str, size: f32, color: Hsla) -> gpui::Svg {
        svg().path(path).size(px(size)).text_color(color)
    }

    fn render_header(&mut self, cx: &mut Context<Self>) -> gpui::Div {
        let theme = self.theme.clone();
        let metrics = &theme.metrics;
        let active = active_snapshot(&self.snapshots, &self.selection);
        let active_session_title = active
            .map(|snapshot| snapshot.session.title.clone())
            .unwrap_or_else(|| "Choose session".to_string());
        let mut tabs = active
            .map(|snapshot| {
                snapshot
                    .tabs
                    .iter()
                    .filter(|tab| tab.archived_at.is_none())
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        tabs.sort_by(|left, right| left.position.total_cmp(&right.position));
        let active_tab_id = self.selection.tab_id.clone();
        let can_create_tab = self.selection.session_id.is_some();
        let switcher_open = self.session_switcher_open;

        let session_switcher = div()
            .id("session-switcher")
            .h(px(metrics.tab_pill_height_px))
            .max_w(px(160.0))
            .min_w(px(120.0))
            .px_2()
            .flex()
            .items_center()
            .gap(px(6.0))
            .rounded(px(metrics.control_radius_px))
            .bg(if switcher_open {
                theme.accent.opacity(0.70)
            } else {
                gpui::transparent_black()
            })
            .cursor_pointer()
            .text_color(theme.muted_foreground)
            .hover(|style| {
                style
                    .bg(theme.accent.opacity(0.60))
                    .text_color(theme.foreground)
            })
            .active(|style| style.opacity(0.88))
            .on_click(cx.listener(|app, _: &ClickEvent, _, cx| {
                let open = !app.session_switcher_open || app.session_switcher_closing;
                app.set_session_switcher_open(open, cx);
            }))
            .child(Self::render_icon(
                "icons/layers-3.svg",
                14.0,
                theme.muted_foreground,
            ))
            .child(
                div()
                    .min_w_0()
                    .flex_1()
                    .truncate()
                    .text_size(px(12.0))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.foreground.opacity(0.85))
                    .child(active_session_title),
            )
            .child(Self::render_icon(
                "icons/chevron-down.svg",
                14.0,
                theme.muted_foreground,
            ));

        let mut window_tabs = div()
            .h_full()
            .min_w_0()
            .flex_1()
            .flex()
            .items_center()
            .gap(px(1.625))
            .overflow_hidden();
        for tab in tabs {
            let active = active_tab_id.as_deref() == Some(tab.id.as_str());
            let tab_id = tab.id.clone();
            let mut tab_button = div()
                .id(SharedString::from(format!("window-tab-{}", tab.id)))
                .h(px(metrics.tab_pill_height_px))
                .min_w(px(80.0))
                .max_w(px(192.0))
                .px_2()
                .flex()
                .items_center()
                .gap(px(6.0))
                .rounded(px(999.0))
                .cursor_pointer()
                .text_color(if active {
                    theme.foreground
                } else {
                    theme.muted_foreground
                })
                .hover(|style| style.bg(theme.foreground.opacity(0.05)))
                .active(|style| style.opacity(0.84))
                .on_click(cx.listener(move |app, _: &ClickEvent, _, cx| {
                    app.select_tab(&tab_id, cx);
                }));
            if active {
                tab_button = tab_button.bg(theme.card).shadow(vec![BoxShadow {
                    color: theme.foreground.opacity(0.12),
                    blur_radius: px(12.0),
                    spread_radius: px(-8.0),
                    offset: point(px(0.0), px(5.0)),
                }]);
            }
            tab_button = tab_button
                .child(Self::render_icon(
                    "icons/app-window.svg",
                    14.0,
                    if active {
                        theme.foreground
                    } else {
                        theme.muted_foreground
                    },
                ))
                .child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .truncate()
                        .text_size(px(12.0))
                        .font_weight(FontWeight::MEDIUM)
                        .child(tab.title),
                );
            if active {
                let close_id = tab.id.clone();
                tab_button = tab_button.child(
                    div()
                        .id(SharedString::from(format!("close-window-{}", tab.id)))
                        .size(px(20.0))
                        .flex_none()
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(999.0))
                        .text_color(theme.muted_foreground)
                        .hover(|style| style.bg(theme.accent))
                        .on_click(cx.listener(move |app, _: &ClickEvent, _, cx| {
                            if app.selection.tab_id.as_deref() == Some(close_id.as_str()) {
                                app.run_mutation(Mutation::ArchiveTab, cx);
                            }
                        }))
                        .child(Self::render_icon(
                            "icons/x.svg",
                            12.0,
                            theme.muted_foreground,
                        )),
                );
            }
            if active {
                let animation_id = SharedString::from(format!(
                    "active-window-tab-{}-{}",
                    tab.id, self.motion_revision
                ));
                window_tabs = window_tabs.child(tab_button.with_animation(
                    animation_id,
                    self.motion(theme.motion.menu_ms),
                    |element, delta| element.opacity(0.58 + 0.42 * delta),
                ));
            } else {
                window_tabs = window_tabs.child(tab_button);
            }
        }
        let new_window = div()
            .id("new-window")
            .size(px(metrics.tab_pill_height_px))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(999.0))
            .text_color(theme.muted_foreground)
            .when(can_create_tab, |button| {
                button
                    .cursor_pointer()
                    .hover(|style| style.bg(theme.accent))
                    .active(|style| style.opacity(0.82))
                    .on_click(cx.listener(|app, _: &ClickEvent, _, cx| {
                        app.run_mutation(Mutation::CreateTab, cx);
                    }))
            })
            .when(!can_create_tab, |button| button.opacity(0.38))
            .child(Self::render_icon(
                "icons/plus.svg",
                15.0,
                theme.muted_foreground,
            ));
        window_tabs = window_tabs.child(new_window);

        let settings = div()
            .id("open-settings")
            .size(px(metrics.tab_pill_height_px))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(metrics.control_radius_px))
            .cursor_pointer()
            .text_color(theme.foreground)
            .hover(|style| style.bg(theme.accent))
            .active(|style| style.opacity(0.82))
            .on_click(cx.listener(|app, _: &ClickEvent, _, cx| {
                app.set_session_switcher_open(false, cx);
                app.set_settings_open(true, cx);
            }))
            .child(Self::render_icon(
                "icons/settings.svg",
                15.0,
                theme.muted_foreground,
            ));

        div()
            .h(px(metrics.tab_bar_height_px))
            .min_h(px(metrics.tab_bar_height_px))
            .w_full()
            .flex()
            .items_center()
            .gap(px(6.5))
            .pl(px(if cfg!(target_os = "macos") {
                82.0
            } else {
                14.0
            }))
            .pr(px(6.5))
            .border_b_1()
            .border_color(theme.border.opacity(0.78))
            .bg(theme.chrome)
            .window_control_area(WindowControlArea::Drag)
            .child(
                div()
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .child(
                        div()
                            .size(px(24.0))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(metrics.control_radius_px))
                            .bg(theme.primary.opacity(0.12))
                            .child(Self::render_icon("icons/terminal.svg", 14.0, theme.primary)),
                    )
                    .child(
                        div()
                            .text_size(px(11.5))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.foreground.opacity(0.80))
                            .child("YAADE"),
                    ),
            )
            .child(div().w(px(1.0)).h(px(16.0)).bg(theme.border.opacity(0.60)))
            .child(session_switcher)
            .child(window_tabs)
            .child(settings)
    }

    fn render_session_switcher(&mut self, cx: &mut Context<Self>) -> gpui::Div {
        let theme = self.theme.clone();
        let mut sessions = self
            .snapshots
            .iter()
            .filter(|snapshot| snapshot.session.archived_at.is_none())
            .cloned()
            .collect::<Vec<_>>();
        sessions.sort_by(|left, right| left.session.position.total_cmp(&right.session.position));
        let active_session_id = self.selection.session_id.clone();
        let metrics = &theme.metrics;
        let mut list = div()
            .id("session-switcher-list")
            .max_h(px(352.0))
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap(px(2.0));
        if sessions.is_empty() {
            list = list.child(
                div()
                    .px_2()
                    .py_4()
                    .text_size(px(12.0))
                    .text_color(theme.muted_foreground)
                    .child("No active sessions."),
            );
        }
        for snapshot in sessions {
            let active = active_session_id.as_deref() == Some(snapshot.session.id.as_str());
            let session_id = snapshot.session.id.clone();
            let terminal_count = snapshot
                .mux_terminals
                .iter()
                .filter(|terminal| terminal.archived_at.is_none())
                .count();
            let row = div()
                .id(SharedString::from(format!(
                    "session-option-{}",
                    snapshot.session.id
                )))
                .h(px(40.0))
                .px_2()
                .flex()
                .items_center()
                .gap_2()
                .rounded(px(metrics.control_radius_px))
                .cursor_pointer()
                .when(active, |row| {
                    row.bg(theme.accent).text_color(theme.accent_foreground)
                })
                .hover(|style| style.bg(theme.accent.opacity(0.78)))
                .on_click(cx.listener(move |app, _: &ClickEvent, _, cx| {
                    app.select_session(&session_id, cx);
                }))
                .child(
                    div()
                        .w(px(16.0))
                        .flex_none()
                        .flex()
                        .items_center()
                        .justify_center()
                        .when(active, |indicator| {
                            indicator.child(Self::render_icon(
                                "icons/check.svg",
                                14.0,
                                theme.primary,
                            ))
                        }),
                )
                .child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .truncate()
                        .text_size(px(12.0))
                        .font_weight(FontWeight::MEDIUM)
                        .child(snapshot.session.title),
                )
                .when(terminal_count > 0, |row| {
                    row.child(
                        div()
                            .font_family(MONO_FONT)
                            .text_size(px(11.0))
                            .text_color(theme.muted_foreground)
                            .child(terminal_count.to_string()),
                    )
                });
            list = list.child(row);
        }

        let popup = div()
            .w(px(320.0))
            .p(px(6.0))
            .rounded(px(metrics.menu_radius_px))
            .border_1()
            .border_color(theme.light_edge)
            .bg(theme.floating)
            .shadow(vec![BoxShadow {
                color: theme.foreground.opacity(0.28),
                blur_radius: px(54.0),
                spread_radius: px(-24.0),
                offset: point(px(0.0), px(24.0)),
            }])
            .child(list)
            .child(
                div()
                    .mt(px(6.0))
                    .pt(px(6.0))
                    .border_t_1()
                    .border_color(theme.border.opacity(0.70))
                    .child(
                        div()
                            .id("new-session")
                            .h(px(32.0))
                            .w_full()
                            .px_2()
                            .flex()
                            .items_center()
                            .gap_2()
                            .rounded(px(metrics.control_radius_px))
                            .bg(theme.secondary)
                            .cursor_pointer()
                            .text_size(px(12.0))
                            .font_weight(FontWeight::MEDIUM)
                            .hover(|style| style.bg(theme.accent))
                            .active(|style| style.opacity(0.82))
                            .on_click(cx.listener(|app, _: &ClickEvent, _, cx| {
                                app.set_session_switcher_open(false, cx);
                                app.run_mutation(Mutation::CreateSession, cx);
                            }))
                            .child(Self::render_icon("icons/plus.svg", 14.0, theme.foreground))
                            .child("New session"),
                    ),
            );

        div()
            .absolute()
            .top(px(metrics.tab_bar_height_px + 8.0))
            .left(px(if cfg!(target_os = "macos") {
                172.0
            } else {
                104.0
            }))
            .child(popup.with_animation(
                SharedString::from(format!(
                    "session-switcher-transition-{}",
                    self.motion_revision
                )),
                self.motion(if self.session_switcher_closing {
                    theme.motion.hot_ms
                } else {
                    theme.motion.menu_ms
                }),
                {
                    let closing = self.session_switcher_closing;
                    move |element, delta| {
                        if closing {
                            element.opacity(1.0 - delta).mt(px(-5.0 * delta))
                        } else {
                            element.opacity(delta).mt(px(-5.0 * (1.0 - delta)))
                        }
                    }
                },
            ))
    }

    fn render_workspace(&mut self, window: &mut Window, cx: &mut Context<Self>) -> gpui::Div {
        let theme = self.theme.clone();
        let padding = theme.metrics.terminal_workspace_padding_px;
        let content = match &self.workspace_state {
            WorkspaceState::Loading => self
                .render_centered_state(
                    "Connecting to YAADE…",
                    "Loading Sessions and Windows from the host.",
                    false,
                    cx,
                )
                .into_any_element(),
            WorkspaceState::Error(message) => self
                .render_centered_state("Host unavailable", message, true, cx)
                .into_any_element(),
            WorkspaceState::Ready if self.selection.session_id.is_none() => self
                .render_centered_state(
                    "No sessions yet",
                    "Create a session to open a terminal workspace.",
                    false,
                    cx,
                )
                .into_any_element(),
            WorkspaceState::Ready if self.selection.tab_id.is_none() => self
                .render_centered_state(
                    "No Windows yet",
                    "Create a Window to start tiling terminals.",
                    false,
                    cx,
                )
                .into_any_element(),
            WorkspaceState::Ready => self
                .render_terminal_workspace(window, cx)
                .into_any_element(),
        };

        let mut root = div()
            .relative()
            .min_h_0()
            .flex_1()
            .p(px(padding))
            .bg(theme.background)
            .child(
                div()
                    .size_full()
                    .min_h_0()
                    .min_w_0()
                    .overflow_hidden()
                    .rounded(px(theme.metrics.pane_radius_px))
                    .border_1()
                    .border_color(theme.ring.opacity(0.72))
                    .bg(theme.content)
                    .shadow(vec![
                        BoxShadow {
                            color: theme.foreground.opacity(0.05),
                            blur_radius: px(1.0),
                            spread_radius: px(0.0),
                            offset: point(px(0.0), px(1.0)),
                        },
                        BoxShadow {
                            color: theme.ring.opacity(0.18),
                            blur_radius: px(2.0),
                            spread_radius: px(0.0),
                            offset: point(px(0.0), px(0.0)),
                        },
                    ])
                    .child(content),
            );
        if let Some(error) = self.action_error.clone() {
            let toast = div()
                .absolute()
                .right(px(16.0))
                .bottom(px(16.0))
                .max_w(px(420.0))
                .px_3()
                .py_2()
                .rounded(px(theme.metrics.control_radius_px))
                .border_1()
                .border_color(theme.destructive.opacity(0.45))
                .bg(theme.popover)
                .text_size(px(12.0))
                .text_color(theme.foreground)
                .shadow_lg()
                .child(error);
            root = root.child(toast.with_animation(
                SharedString::from(format!("action-error-enter-{}", self.motion_revision)),
                self.motion(theme.motion.overlay_ms),
                |element, delta| element.opacity(delta).bottom(px(12.0 + 4.0 * delta)),
            ));
        }
        root
    }

    fn render_centered_state(
        &self,
        title: &str,
        message: &str,
        retry: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let theme = self.theme.clone();
        let pending = title.ends_with('…');
        let mut icon_tile = div()
            .size(px(34.0))
            .mb_1()
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(theme.control_radius()))
            .bg(theme.primary.opacity(0.12));
        if pending && !self.reduced_motion {
            icon_tile = icon_tile.child(
                Self::render_icon("icons/terminal.svg", 17.0, theme.primary).with_animation(
                    "terminal-loading-pulse",
                    Animation::new(Duration::from_millis(1_400))
                        .repeat()
                        .with_easing(pulsating_between(0.58, 1.0)),
                    |icon, opacity| icon.opacity(opacity),
                ),
            );
        } else {
            icon_tile =
                icon_tile.child(Self::render_icon("icons/terminal.svg", 17.0, theme.primary));
        }
        let state = div()
            .max_w(px(520.0))
            .px_6()
            .flex()
            .flex_col()
            .items_center()
            .gap_2()
            .text_center()
            .child(icon_tile)
            .child(
                div()
                    .text_size(px(13.0))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(title.to_string()),
            )
            .child(
                div()
                    .text_size(px(12.0))
                    .text_color(theme.muted_foreground)
                    .child(message.to_string()),
            )
            .when(retry, |state| {
                state.child(
                    div()
                        .id("retry-host")
                        .mt_2()
                        .h(px(32.0))
                        .px_3()
                        .flex()
                        .items_center()
                        .gap_2()
                        .rounded(px(theme.metrics.control_radius_px))
                        .bg(theme.primary)
                        .text_color(theme.primary_foreground)
                        .cursor_pointer()
                        .hover(|style| style.opacity(0.90))
                        .active(|style| style.opacity(0.78))
                        .on_click(cx.listener(|app, _: &ClickEvent, _, cx| {
                            let session = app.selection.session_id.clone();
                            app.reload_workspace(session, cx);
                        }))
                        .child(Self::render_icon(
                            "icons/refresh-cw.svg",
                            14.0,
                            theme.primary_foreground,
                        ))
                        .child("Try again"),
                )
            });

        div()
            .min_h_0()
            .flex_1()
            .flex()
            .items_center()
            .justify_center()
            .bg(theme.background)
            .child(state.with_animation(
                SharedString::from(format!("centered-state-enter-{}", self.motion_revision)),
                self.motion(theme.motion.overlay_ms),
                |element, delta| element.opacity(delta).mt(px(7.0 * (1.0 - delta))),
            ))
    }

    fn render_terminal_workspace(
        &mut self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let content = if let Some(zoomed) = self.terminal_workspace.zoomed_panel_id {
            self.terminal_workspace
                .view(zoomed)
                .cloned()
                .map(|view| self.render_panel_leaf(zoomed, &view, true, cx))
                .unwrap_or_else(|| div().size_full().into_any_element())
        } else {
            let root = self.terminal_workspace.root.clone();
            self.render_panel_node(&root, Vec::new(), cx)
        };
        div()
            .id("terminal-tiling-workspace")
            .size_full()
            .min_h_0()
            .min_w_0()
            .overflow_hidden()
            .child(content)
    }

    fn render_panel_node(
        &mut self,
        node: &PanelNode,
        path: Vec<usize>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        match node {
            PanelNode::Leaf { panel_id, view } => self.render_panel_leaf(
                *panel_id,
                view,
                self.terminal_workspace.focused_panel_id == *panel_id,
                cx,
            ),
            PanelNode::Row { split } | PanelNode::Column { split } => {
                let horizontal = node.is_row();
                let split_key = split_path_key(&path);
                let bounds = self.split_bounds.get(&split_key).copied();
                let separator_count = split.children.len().saturating_sub(1) as f32;
                let available = bounds.map_or(px(900.0), |bounds| {
                    let axis = if horizontal {
                        bounds.size.width
                    } else {
                        bounds.size.height
                    };
                    (axis - px(4.0 * separator_count)).max(px(1.0))
                });
                let entity = cx.entity();
                let measured_path = path.clone();
                let measure = canvas(
                    move |bounds, _, cx| {
                        entity.update(cx, |app, cx| {
                            let key = split_path_key(&measured_path);
                            let changed = app.split_bounds.get(&key) != Some(&bounds);
                            app.record_split_bounds(measured_path.clone(), bounds);
                            if changed {
                                cx.notify();
                            }
                        });
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .inset_0();
                let mut container = div()
                    .relative()
                    .size_full()
                    .min_h_0()
                    .min_w_0()
                    .flex()
                    .when(!horizontal, |container| container.flex_col())
                    .child(measure);
                for (index, child) in split.children.iter().enumerate() {
                    if index > 0 {
                        let drag = SplitResizeDrag {
                            path: path.clone(),
                            separator_index: index,
                            horizontal,
                            origin: bounds.map_or_else(Point::default, |bounds| bounds.origin),
                            available,
                            ratios: split.ratios.clone(),
                        };
                        let label = if horizontal {
                            "Resize columns"
                        } else {
                            "Resize rows"
                        };
                        let preview_background = self.theme.popover;
                        let preview_foreground = self.theme.foreground;
                        let preview_border = self.theme.border;
                        let separator = div()
                            .id(SharedString::from(format!("splitter-{split_key}-{index}")))
                            .flex_none()
                            .when(horizontal, |separator| separator.w(px(4.0)).h_full())
                            .when(!horizontal, |separator| separator.h(px(4.0)).w_full())
                            .flex()
                            .items_center()
                            .justify_center()
                            .cursor(if horizontal {
                                CursorStyle::ResizeLeftRight
                            } else {
                                CursorStyle::ResizeUpDown
                            })
                            .child(
                                div()
                                    .when(horizontal, |line| line.w(px(1.0)).h_full())
                                    .when(!horizontal, |line| line.h(px(1.0)).w_full())
                                    .bg(self.theme.border.opacity(0.68)),
                            )
                            .on_drag(drag, move |_, _, _, cx| {
                                cx.new(|_| DragPreview {
                                    label: label.to_string(),
                                    background: preview_background,
                                    foreground: preview_foreground,
                                    border: preview_border,
                                })
                            })
                            .on_drag_move(cx.listener(
                                |app, event: &DragMoveEvent<SplitResizeDrag>, _, cx| {
                                    app.resize_split_from_drag(event, cx);
                                },
                            ));
                        container = container.child(separator);
                    }
                    let mut child_path = path.clone();
                    child_path.push(index);
                    let child_element = self.render_panel_node(child, child_path, cx);
                    container = container.child(
                        div()
                            .min_h_0()
                            .min_w_0()
                            .flex_basis(relative(split.ratios[index]))
                            .flex_grow()
                            .flex_shrink()
                            .child(child_element),
                    );
                }
                container.into_any_element()
            }
        }
    }

    fn render_panel_leaf(
        &mut self,
        panel_id: PanelId,
        view: &TerminalPaneView,
        focused: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme.clone();
        let terminal_id = view.terminal_id().map(str::to_string);
        let terminal = terminal_id.as_deref().and_then(|terminal_id| {
            active_snapshot(&self.snapshots, &self.selection)
                .and_then(|snapshot| snapshot.mux_terminals.iter().find(|item| item.id == terminal_id))
                .cloned()
        });
        let title = terminal_id
            .as_deref()
            .and_then(|terminal_id| self.terminal_views.get(terminal_id))
            .map(|state| state.title.clone())
            .or_else(|| terminal.as_ref().map(|terminal| terminal.title.clone()))
            .unwrap_or_else(|| "Empty pane".to_string());
        let can_zoom = self.terminal_workspace.pane_count() > 1;
        let zoomed = self.terminal_workspace.zoomed_panel_id == Some(panel_id);

        let title_drag = terminal_id.clone().map(|terminal_id| PaneDrag {
            terminal_id,
            title: title.clone(),
        });
        let mut title_area = div()
            .id(SharedString::from(format!("pane-title-{}", panel_id.id)))
            .min_w_0()
            .flex_1()
            .h_full()
            .px_1()
            .flex()
            .items_center()
            .gap(px(7.0))
            .child(Self::render_icon(
                "icons/terminal.svg",
                13.0,
                if focused {
                    theme.foreground
                } else {
                    theme.muted_foreground.opacity(0.68)
                },
            ))
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .text_size(px(11.0))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(if focused {
                        theme.foreground
                    } else {
                        theme.muted_foreground.opacity(0.72)
                    })
                    .child(title.clone()),
            );
        if let Some(drag) = title_drag {
            let preview_background = theme.popover;
            let preview_foreground = theme.foreground;
            let preview_border = theme.border;
            title_area = title_area
                .cursor(CursorStyle::OpenHand)
                .on_drag(drag, move |drag, _, _, cx| {
                    cx.new(|_| DragPreview {
                        label: drag.title.clone(),
                        background: preview_background,
                        foreground: preview_foreground,
                        border: preview_border,
                    })
                });
        }

        let split_right = div()
            .id(SharedString::from(format!("split-right-{}", panel_id.id)))
            .size(px(22.0))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(theme.metrics.control_radius_px))
            .cursor_pointer()
            .text_color(theme.muted_foreground)
            .hover(|style| style.bg(theme.accent).text_color(theme.foreground))
            .on_click(cx.listener(move |app, _: &ClickEvent, _, cx| {
                app.split_panel_and_create(panel_id, Edge::Right, cx);
            }))
            .child(Self::render_icon(
                "icons/panel-right.svg",
                13.0,
                theme.muted_foreground,
            ));
        let split_down = div()
            .id(SharedString::from(format!("split-down-{}", panel_id.id)))
            .size(px(22.0))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(theme.metrics.control_radius_px))
            .cursor_pointer()
            .text_color(theme.muted_foreground)
            .hover(|style| style.bg(theme.accent).text_color(theme.foreground))
            .on_click(cx.listener(move |app, _: &ClickEvent, _, cx| {
                app.split_panel_and_create(panel_id, Edge::Bottom, cx);
            }))
            .child(Self::render_icon(
                "icons/panel-bottom.svg",
                13.0,
                theme.muted_foreground,
            ));
        let zoom = div()
            .id(SharedString::from(format!("zoom-pane-{}", panel_id.id)))
            .size(px(22.0))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(theme.metrics.control_radius_px))
            .when(can_zoom, |button| {
                button
                    .cursor_pointer()
                    .hover(|style| style.bg(theme.accent))
                    .on_click(cx.listener(move |app, _: &ClickEvent, _, cx| {
                        app.toggle_panel_zoom(panel_id, cx);
                    }))
            })
            .when(!can_zoom, |button| button.opacity(0.30))
            .child(Self::render_icon(
                if zoomed {
                    "icons/minimize.svg"
                } else {
                    "icons/maximize.svg"
                },
                13.0,
                theme.muted_foreground,
            ));
        let close = div()
            .id(SharedString::from(format!("close-pane-{}", panel_id.id)))
            .size(px(22.0))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(theme.metrics.control_radius_px))
            .cursor_pointer()
            .hover(|style| style.bg(theme.accent))
            .on_click(cx.listener(move |app, _: &ClickEvent, _, cx| {
                app.close_panel(panel_id, cx);
            }))
            .child(Self::render_icon(
                "icons/x.svg",
                12.0,
                theme.muted_foreground,
            ));
        let chrome = div()
            .h(px(theme.metrics.pane_chrome_height_px))
            .min_h(px(theme.metrics.pane_chrome_height_px))
            .px(px(5.0))
            .flex()
            .items_center()
            .gap(px(2.0))
            .border_b_1()
            .border_color(theme.border.opacity(0.58))
            .bg(theme.background.opacity(0.42))
            .child(title_area)
            .child(split_right)
            .child(split_down)
            .child(zoom)
            .child(close);

        let content = match view {
            TerminalPaneView::Empty => self.render_empty_terminal_pane(panel_id, cx),
            TerminalPaneView::Terminal { mux_terminal_id } => {
                self.render_terminal_pane(mux_terminal_id, terminal.as_ref(), focused, cx)
            }
        };
        let leaf = div()
            .id(SharedString::from(format!("terminal-pane-{}", panel_id.id)))
            .relative()
            .size_full()
            .min_h_0()
            .min_w_0()
            .flex()
            .flex_col()
            .overflow_hidden()
            .bg(theme.background)
            .border_1()
            .border_color(if focused {
                theme.primary.opacity(0.48)
            } else {
                theme.border.opacity(0.46)
            })
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |app, _: &MouseDownEvent, window, cx| {
                    app.focus_panel(panel_id, window, cx);
                }),
            )
            .on_key_down(cx.listener(Self::handle_terminal_key_down))
            .child(chrome)
            .child(content)
            .child(self.render_panel_drop_zone(panel_id, Some(Edge::Left), cx))
            .child(self.render_panel_drop_zone(panel_id, Some(Edge::Right), cx))
            .child(self.render_panel_drop_zone(panel_id, Some(Edge::Top), cx))
            .child(self.render_panel_drop_zone(panel_id, Some(Edge::Bottom), cx))
            .child(self.render_panel_drop_zone(panel_id, None, cx));
        leaf.into_any_element()
    }

    fn render_empty_terminal_pane(
        &self,
        panel_id: PanelId,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme.clone();
        div()
            .min_h_0()
            .flex_1()
            .flex()
            .items_center()
            .justify_center()
            .child(
                div()
                    .id(SharedString::from(format!("create-terminal-{}", panel_id.id)))
                    .h(px(32.0))
                    .px_3()
                    .flex()
                    .items_center()
                    .gap_2()
                    .rounded(px(theme.metrics.control_radius_px))
                    .bg(theme.secondary)
                    .cursor_pointer()
                    .text_size(px(12.0))
                    .font_weight(FontWeight::MEDIUM)
                    .hover(|style| style.bg(theme.accent))
                    .on_click(cx.listener(move |app, _: &ClickEvent, _, cx| {
                        app.create_terminal_in_panel(panel_id, cx);
                    }))
                    .child(Self::render_icon("icons/plus.svg", 14.0, theme.foreground))
                    .child("New terminal"),
            )
            .into_any_element()
    }

    fn render_terminal_pane(
        &self,
        mux_terminal_id: &str,
        terminal: Option<&MuxTerminal>,
        focused: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme.clone();
        let state = self.terminal_views.get(mux_terminal_id);
        let snapshot = state
            .and_then(|state| state.semantic.snapshot())
            .cloned();
        let content = if let Some(snapshot) = snapshot {
            self.render_terminal_snapshot(&snapshot, focused)
                .into_any_element()
        } else {
            let (title, detail) = match state.map(|state| &state.load_state) {
                Some(TerminalLoadState::Loading) => (
                    "Opening terminal…".to_string(),
                    "Waiting for the owner-published screen.".to_string(),
                ),
                Some(TerminalLoadState::Unavailable(message)) => {
                    ("Terminal unavailable".to_string(), message.clone())
                }
                Some(TerminalLoadState::Ready) => (
                    "Terminal is empty".to_string(),
                    "Waiting for the first semantic frame.".to_string(),
                ),
                None => (
                    "Terminal unavailable".to_string(),
                    terminal.map_or_else(
                        || "The terminal is no longer in this Window.".to_string(),
                        status_message,
                    ),
                ),
            };
            div()
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .max_w(px(420.0))
                        .px_4()
                        .text_center()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(
                            div()
                                .text_size(px(12.0))
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(title),
                        )
                        .child(
                            div()
                                .text_size(px(11.0))
                                .text_color(theme.muted_foreground)
                                .child(detail),
                        ),
                )
                .into_any_element()
        };
        let entity = cx.entity();
        let input_entity = entity.clone();
        let terminal_id = mux_terminal_id.to_string();
        let measure = canvas(
            |_, _, _| (),
            move |bounds, _, window, cx| {
                entity.update(cx, |app, app_cx| {
                    app.record_terminal_bounds(&terminal_id, bounds, app_cx);
                });
                if focused {
                    let focus_handle = input_entity.read(cx).focus_handle.clone();
                    window.handle_input(
                        &focus_handle,
                        ElementInputHandler::new(bounds, input_entity.clone()),
                        cx,
                    );
                }
            },
        )
        .absolute()
        .inset_0();
        div()
            .relative()
            .min_h_0()
            .min_w_0()
            .flex_1()
            .overflow_hidden()
            .bg(theme.background)
            .child(content)
            .child(measure)
            .into_any_element()
    }

    fn render_panel_drop_zone(
        &self,
        panel_id: PanelId,
        edge: Option<Edge>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let theme = self.theme.clone();
        let mut zone = div()
            .absolute()
            .drag_over::<PaneDrag>(move |style, _, _, _| {
                style.bg(theme.primary.opacity(0.16))
            })
            .on_drop(cx.listener(move |app, drag: &PaneDrag, _, cx| {
                app.dock_terminal(&drag.terminal_id, panel_id, edge, cx);
            }));
        zone = match edge {
            Some(Edge::Left) => zone.left_0().top(relative(0.22)).bottom(relative(0.22)).w(relative(0.22)),
            Some(Edge::Right) => zone.right_0().top(relative(0.22)).bottom(relative(0.22)).w(relative(0.22)),
            Some(Edge::Top) => zone.top_0().left(relative(0.22)).right(relative(0.22)).h(relative(0.22)),
            Some(Edge::Bottom) => zone.bottom_0().left(relative(0.22)).right(relative(0.22)).h(relative(0.22)),
            None => zone
                .top(relative(0.22))
                .right(relative(0.22))
                .bottom(relative(0.22))
                .left(relative(0.22)),
        };
        zone
    }

    fn render_terminal_snapshot(
        &self,
        snapshot: &TerminalSemanticSnapshot,
        focused: bool,
    ) -> gpui::Div {
        let theme = self.theme.clone();
        let mut cursor = snapshot.cursor.clone();
        if cursor.blinking {
            cursor.visible &= self.cursor_blink_on;
        }
        let font_size = self.terminal_font_size;
        let line_height = self.terminal_line_height;
        let rows = snapshot
            .screen_rows
            .iter()
            .enumerate()
            .map(|(row_index, row)| {
                let (text, highlights) = terminal_line(
                    &row.cells,
                    row_index,
                    &cursor,
                    theme.primary,
                    theme.primary_foreground,
                );
                div()
                    .h(px(line_height))
                    .min_h(px(line_height))
                    .w_full()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .font_family(MONO_FONT)
                    .text_size(px(font_size))
                    .line_height(px(line_height))
                    .text_color(theme.foreground)
                    .child(StyledText::new(text).with_highlights(highlights))
            })
            .collect::<Vec<_>>();
        let mut screen = div()
            .id("terminal-screen")
            .relative()
            .size_full()
            .overflow_hidden()
            .p(px(TERMINAL_PADDING_PX))
            .children(rows);
        if focused && !self.ime_composition.is_empty() {
            let left = TERMINAL_PADDING_PX + snapshot.cursor.x as f32 * self.terminal_cell_width;
            let top = TERMINAL_PADDING_PX + snapshot.cursor.y as f32 * line_height;
            screen = screen.child(
                div()
                    .absolute()
                    .left(px(left))
                    .top(px(top))
                    .h(px(line_height))
                    .px(px(1.0))
                    .font_family(MONO_FONT)
                    .text_size(px(font_size))
                    .line_height(px(line_height))
                    .text_color(theme.foreground)
                    .bg(theme.popover)
                    .border_b_1()
                    .border_color(theme.primary)
                    .child(self.ime_composition.clone()),
            );
        }
        div()
            .min_h_0()
            .flex_1()
            .bg(theme.background)
            .child(screen)
    }

    fn render_settings(&mut self, cx: &mut Context<Self>) -> gpui::Div {
        let theme = self.theme.clone();
        let metrics = &theme.metrics;
        let scheme = theme.scheme;
        let host_url = self.config.base_url.clone();
        let dark_active = scheme == ColorScheme::Dark;
        let light_active = scheme == ColorScheme::Light;

        let theme_option = |id: &'static str,
                            label: &'static str,
                            detail: &'static str,
                            active: bool,
                            target: ColorScheme,
                            cx: &mut Context<Self>| {
            div()
                .id(id)
                .h(px(58.0))
                .w_full()
                .px_3()
                .flex()
                .items_center()
                .gap_3()
                .rounded(px(metrics.control_radius_px))
                .border_1()
                .border_color(if active {
                    theme.primary.opacity(0.55)
                } else {
                    theme.border.opacity(0.65)
                })
                .bg(if active {
                    theme.accent
                } else {
                    theme.secondary.opacity(0.35)
                })
                .cursor_pointer()
                .hover(|style| style.bg(theme.accent.opacity(0.78)))
                .on_click(cx.listener(move |app, _: &ClickEvent, _, cx| {
                    if app.theme.scheme != target
                        && let Ok(next) = NativeTheme::load(target)
                    {
                        app.theme = next;
                        app.bump_motion();
                        cx.notify();
                    }
                }))
                .child(
                    div()
                        .size(px(28.0))
                        .rounded(px(999.0))
                        .border_1()
                        .border_color(if target == ColorScheme::Dark {
                            theme.border
                        } else {
                            theme.muted_foreground.opacity(0.35)
                        })
                        .bg(if target == ColorScheme::Dark {
                            gpui::rgb(0x0e151b)
                        } else {
                            gpui::rgb(0xeaf1f8)
                        }),
                )
                .child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .flex()
                        .flex_col()
                        .gap(px(2.0))
                        .child(
                            div()
                                .text_size(px(12.0))
                                .font_weight(FontWeight::MEDIUM)
                                .child(label),
                        )
                        .child(
                            div()
                                .text_size(px(11.0))
                                .text_color(theme.muted_foreground)
                                .child(detail),
                        ),
                )
                .when(active, |row| {
                    row.child(div().size(px(7.0)).rounded(px(999.0)).bg(theme.primary))
                })
        };

        let dialog = div()
            .w(px(840.0))
            .max_w(gpui::relative(0.90))
            .h(px(560.0))
            .max_h(gpui::relative(0.88))
            .overflow_hidden()
            .rounded(px(metrics.menu_radius_px))
            .border_1()
            .border_color(theme.light_edge)
            .bg(theme.floating)
            .shadow(vec![BoxShadow {
                color: theme.foreground.opacity(0.34),
                blur_radius: px(76.0),
                spread_radius: px(-28.0),
                offset: point(px(0.0), px(30.0)),
            }])
            .flex()
            .flex_col()
            .child(
                div()
                    .h(px(52.0))
                    .min_h(px(52.0))
                    .px_4()
                    .flex()
                    .items_center()
                    .border_b_1()
                    .border_color(theme.border.opacity(0.65))
                    .child(
                        div()
                            .flex_1()
                            .text_size(px(14.0))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Settings"),
                    )
                    .child(
                        div()
                            .id("close-settings")
                            .size(px(28.0))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(999.0))
                            .cursor_pointer()
                            .hover(|style| style.bg(theme.accent))
                            .on_click(cx.listener(|app, _: &ClickEvent, _, cx| {
                                app.set_settings_open(false, cx);
                            }))
                            .child(Self::render_icon(
                                "icons/x.svg",
                                14.0,
                                theme.muted_foreground,
                            )),
                    ),
            )
            .child(
                div()
                    .min_h_0()
                    .flex_1()
                    .flex()
                    .child(
                        div()
                            .w(px(196.0))
                            .min_w(px(196.0))
                            .p_3()
                            .border_r_1()
                            .border_color(theme.border.opacity(0.60))
                            .bg(theme.card.opacity(0.38))
                            .child(
                                div()
                                    .h(px(36.0))
                                    .px_3()
                                    .flex()
                                    .items_center()
                                    .gap_2()
                                    .rounded(px(metrics.control_radius_px))
                                    .bg(theme.accent)
                                    .text_size(px(12.0))
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(Self::render_icon(
                                        "icons/settings.svg",
                                        15.0,
                                        theme.primary,
                                    ))
                                    .child("Appearance"),
                            ),
                    )
                    .child(
                        div()
                            .id("settings-content")
                            .min_w_0()
                            .flex_1()
                            .overflow_y_scroll()
                            .p_6()
                            .flex()
                            .flex_col()
                            .gap_5()
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap_1()
                                    .child(
                                        div()
                                            .text_size(px(14.0))
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .child("Appearance"),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(12.0))
                                            .text_color(theme.muted_foreground)
                                            .child("Tune the theme and typography across the app."),
                                    ),
                            )
                            .child(div().h(px(1.0)).w_full().bg(theme.border.opacity(0.65)))
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap_2()
                                    .child(
                                        div()
                                            .text_size(px(12.0))
                                            .font_weight(FontWeight::MEDIUM)
                                            .child("Color scheme"),
                                    )
                                    .child(theme_option(
                                        "theme-dark",
                                        "Default Dark",
                                        "Near-black silver-blue with white-frost chrome.",
                                        dark_active,
                                        ColorScheme::Dark,
                                        cx,
                                    ))
                                    .child(theme_option(
                                        "theme-light",
                                        "Default Light",
                                        "Milky silver-blue with system-blue focus.",
                                        light_active,
                                        ColorScheme::Light,
                                        cx,
                                    )),
                            )
                            .child(
                                div()
                                    .mt_2()
                                    .p_3()
                                    .rounded(px(metrics.control_radius_px))
                                    .border_1()
                                    .border_color(theme.border.opacity(0.55))
                                    .bg(theme.secondary.opacity(0.30))
                                    .flex()
                                    .flex_col()
                                    .gap_1()
                                    .child(
                                        div()
                                            .text_size(px(12.0))
                                            .font_weight(FontWeight::MEDIUM)
                                            .child("Connected host"),
                                    )
                                    .child(
                                        div()
                                            .font_family(MONO_FONT)
                                            .text_size(px(11.0))
                                            .text_color(theme.muted_foreground)
                                            .child(host_url),
                                    ),
                            ),
                    ),
            );

        let overlay = div()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .bg(gpui::rgba(0x0a10207a))
            .child(dialog.with_animation(
                SharedString::from(format!(
                    "settings-dialog-transition-{}",
                    self.motion_revision
                )),
                self.motion(if self.settings_closing {
                    theme.motion.hot_ms
                } else {
                    theme.motion.panel_ms
                }),
                {
                    let closing = self.settings_closing;
                    move |element, delta| {
                        if closing {
                            element.opacity(1.0 - delta).mt(px(10.0 * delta))
                        } else {
                            element.opacity(delta).mt(px(10.0 * (1.0 - delta)))
                        }
                    }
                },
            ));

        div().absolute().inset_0().child(overlay.with_animation(
            SharedString::from(format!(
                "settings-scrim-transition-{}",
                self.motion_revision
            )),
            self.motion(if self.settings_closing {
                theme.motion.hot_ms
            } else {
                theme.motion.overlay_ms
            }),
            {
                let closing = self.settings_closing;
                move |element, delta| element.opacity(if closing { 1.0 - delta } else { delta })
            },
        ))
    }
}

impl NativeTheme {
    fn control_radius(&self) -> f32 {
        self.metrics.control_radius_px
    }
}

impl Render for DesktopApp {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme.clone();
        self.terminal_line_height = self.terminal_font_size * 1.25;
        let run = TextRun {
            len: 1,
            font: font(MONO_FONT),
            color: theme.foreground,
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        self.terminal_cell_width = window
            .text_system()
            .shape_line("M".into(), px(self.terminal_font_size), &[run], None)
            .width
            / px(1.0);
        let mut root = div()
            .relative()
            .track_focus(&self.focus_handle)
            .on_key_down(cx.listener(Self::handle_terminal_key_down))
            .on_action(cx.listener(|app, _: &ZoomIn, _, cx| {
                app.terminal_font_size = stepped_terminal_font_size(app.terminal_font_size, 1.0);
                app.bump_motion();
                cx.notify();
            }))
            .on_action(cx.listener(|app, _: &ZoomOut, _, cx| {
                app.terminal_font_size = stepped_terminal_font_size(app.terminal_font_size, -1.0);
                app.bump_motion();
                cx.notify();
            }))
            .on_action(cx.listener(|app, _: &ResetZoom, _, cx| {
                app.terminal_font_size = DEFAULT_TERMINAL_FONT_SIZE;
                app.bump_motion();
                cx.notify();
            }))
            .on_action(cx.listener(|app, _: &PasteTerminal, _, cx| {
                if !app.settings_open && !app.session_switcher_open {
                    app.paste_terminal(cx);
                }
            }))
            .on_action(cx.listener(|app, _: &SplitPaneRight, _, cx| {
                if !app.settings_open && !app.session_switcher_open {
                    let panel = app.terminal_workspace.focused_panel_id;
                    app.split_panel_and_create(panel, Edge::Right, cx);
                }
            }))
            .on_action(cx.listener(|app, _: &SplitPaneDown, _, cx| {
                if !app.settings_open && !app.session_switcher_open {
                    let panel = app.terminal_workspace.focused_panel_id;
                    app.split_panel_and_create(panel, Edge::Bottom, cx);
                }
            }))
            .on_action(cx.listener(|app, _: &TogglePaneZoom, _, cx| {
                if !app.settings_open && !app.session_switcher_open {
                    let panel = app.terminal_workspace.focused_panel_id;
                    app.toggle_panel_zoom(panel, cx);
                }
            }))
            .size_full()
            .min_w_0()
            .min_h_0()
            .overflow_hidden()
            .flex()
            .flex_col()
            .font_family(UI_FONT)
            .text_size(px(theme.metrics.root_font_size_px))
            .text_color(theme.foreground)
            .bg(theme.background)
            .child(self.render_header(cx))
            .child(self.render_workspace(window, cx));
        if self.session_switcher_open {
            root = root.child(self.render_session_switcher(cx));
        }
        if self.settings_open {
            root = root.child(self.render_settings(cx));
        }
        root.with_animation(
            "desktop-shell-enter",
            self.motion(theme.motion.panel_ms),
            |element, delta| element.opacity(0.84 + 0.16 * delta),
        )
    }
}

impl EntityInputHandler for DesktopApp {
    fn text_for_range(
        &mut self,
        range_utf16: Range<usize>,
        actual_range: &mut Option<Range<usize>>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<String> {
        let utf16_len = self.ime_composition.encode_utf16().count();
        let start = range_utf16.start.min(utf16_len);
        let end = range_utf16.end.min(utf16_len).max(start);
        actual_range.replace(start..end);
        Some(utf16_slice(&self.ime_composition, start..end))
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        let cursor = self.ime_composition.encode_utf16().count();
        Some(UTF16Selection {
            range: cursor..cursor,
            reversed: false,
        })
    }

    fn marked_text_range(
        &self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Range<usize>> {
        self.ime_marked_range.clone()
    }

    fn unmark_text(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        let committed = std::mem::take(&mut self.ime_composition);
        self.ime_marked_range = None;
        if !committed.is_empty() {
            self.send_terminal_input(committed, cx);
        }
        cx.notify();
    }

    fn replace_text_in_range(
        &mut self,
        _range: Option<Range<usize>>,
        text: &str,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.ime_composition.clear();
        self.ime_marked_range = None;
        if !text.is_empty() {
            self.send_terminal_input(text.to_string(), cx);
        }
        cx.notify();
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        _range: Option<Range<usize>>,
        new_text: &str,
        _new_selected_range: Option<Range<usize>>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.ime_composition.clear();
        self.ime_composition.push_str(new_text);
        self.ime_marked_range = (!new_text.is_empty())
            .then(|| 0..new_text.encode_utf16().count());
        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        _range_utf16: Range<usize>,
        element_bounds: Bounds<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let cursor = self
            .focused_terminal_id()
            .and_then(|terminal_id| self.terminal_views.get(terminal_id))
            .and_then(|state| state.semantic.snapshot())
            .map(|snapshot| snapshot.cursor.clone())?;
        Some(Bounds::new(
            point(
                element_bounds.left()
                    + px(TERMINAL_PADDING_PX + cursor.x as f32 * self.terminal_cell_width),
                element_bounds.top()
                    + px(TERMINAL_PADDING_PX + cursor.y as f32 * self.terminal_line_height),
            ),
            gpui::size(px(self.terminal_cell_width), px(self.terminal_line_height)),
        ))
    }

    fn character_index_for_point(
        &mut self,
        _point: Point<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        Some(0)
    }
}

impl Render for DragPreview {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .max_w(px(240.0))
            .h(px(30.0))
            .px_3()
            .flex()
            .items_center()
            .rounded(px(8.0))
            .border_1()
            .border_color(self.border)
            .bg(self.background)
            .text_size(px(11.0))
            .font_weight(FontWeight::MEDIUM)
            .text_color(self.foreground)
            .shadow_lg()
            .child(self.label.clone())
    }
}

impl Drop for DesktopApp {
    fn drop(&mut self) {
        self.realtime.shutdown();
    }
}

fn utf16_slice(value: &str, range: Range<usize>) -> String {
    String::from_utf16_lossy(
        &value
            .encode_utf16()
            .skip(range.start)
            .take(range.end.saturating_sub(range.start))
            .collect::<Vec<_>>(),
    )
}

fn terminal_key_data(keystroke: &Keystroke, modes: &TerminalModes) -> Option<String> {
    let key = keystroke.key.as_str();
    let modifiers = keystroke.modifiers;
    if keystroke.is_ime_in_progress() {
        return None;
    }

    if modifiers.shift
        && !modifiers.alt
        && !modifiers.control
        && !modifiers.platform
        && key == "enter"
    {
        return Some("\n".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        if !modifiers.shift && !modifiers.control {
            if modifiers.alt && !modifiers.platform {
                match key {
                    "left" => return Some("\u{1b}b".to_string()),
                    "right" => return Some("\u{1b}f".to_string()),
                    "backspace" => return Some("\u{1b}\u{7f}".to_string()),
                    _ => {}
                }
            }
            if modifiers.platform && !modifiers.alt {
                match key {
                    "left" => return Some("\u{1}".to_string()),
                    "right" => return Some("\u{5}".to_string()),
                    "backspace" => return Some("\u{15}".to_string()),
                    _ => return None,
                }
            }
        }
    }

    if modifiers.control && !modifiers.platform {
        let character = keystroke
            .key_char
            .as_deref()
            .unwrap_or(key)
            .chars()
            .next()?;
        let control = match character.to_ascii_lowercase() {
            '@' | ' ' => 0,
            'a'..='z' => character.to_ascii_lowercase() as u8 - b'a' + 1,
            '[' => 27,
            '\\' => 28,
            ']' => 29,
            '^' => 30,
            '_' => 31,
            '?' => 127,
            _ => return special_terminal_key(key, modifiers, modes),
        };
        let mut data = String::new();
        if modifiers.alt {
            data.push('\u{1b}');
        }
        data.push(char::from(control));
        return Some(data);
    }

    if let Some(special) = special_terminal_key(key, modifiers, modes) {
        return Some(special);
    }

    if modifiers.alt && !modifiers.platform {
        let text = keystroke.key_char.as_deref().unwrap_or(key);
        if text.chars().count() == 1 {
            return Some(format!("\u{1b}{text}"));
        }
    }
    None
}

fn special_terminal_key(
    key: &str,
    modifiers: gpui::Modifiers,
    modes: &TerminalModes,
) -> Option<String> {
    let modifier = 1
        + usize::from(modifiers.shift)
        + usize::from(modifiers.alt) * 2
        + usize::from(modifiers.control) * 4
        + usize::from(modifiers.platform) * 8;
    let modified = modifier > 1;
    let cursor = |normal: char, application: char| {
        if modified {
            format!("\u{1b}[1;{modifier}{normal}")
        } else if modes.application_cursor_keys {
            format!("\u{1b}O{application}")
        } else {
            format!("\u{1b}[{normal}")
        }
    };
    match key {
        "enter" => Some("\r".to_string()),
        "escape" => Some("\u{1b}".to_string()),
        "backspace" => Some("\u{7f}".to_string()),
        "tab" if modifiers.shift => Some("\u{1b}[Z".to_string()),
        "tab" => Some("\t".to_string()),
        "up" => Some(cursor('A', 'A')),
        "down" => Some(cursor('B', 'B')),
        "right" => Some(cursor('C', 'C')),
        "left" => Some(cursor('D', 'D')),
        "home" if modified => Some(format!("\u{1b}[1;{modifier}H")),
        "home" => Some("\u{1b}[H".to_string()),
        "end" if modified => Some(format!("\u{1b}[1;{modifier}F")),
        "end" => Some("\u{1b}[F".to_string()),
        "insert" => Some(csi_tilde(2, modifier)),
        "delete" => Some(csi_tilde(3, modifier)),
        "pageup" => Some(csi_tilde(5, modifier)),
        "pagedown" => Some(csi_tilde(6, modifier)),
        "f1" if !modified => Some("\u{1b}OP".to_string()),
        "f2" if !modified => Some("\u{1b}OQ".to_string()),
        "f3" if !modified => Some("\u{1b}OR".to_string()),
        "f4" if !modified => Some("\u{1b}OS".to_string()),
        "f1" => Some(format!("\u{1b}[1;{modifier}P")),
        "f2" => Some(format!("\u{1b}[1;{modifier}Q")),
        "f3" => Some(format!("\u{1b}[1;{modifier}R")),
        "f4" => Some(format!("\u{1b}[1;{modifier}S")),
        "f5" => Some(csi_tilde(15, modifier)),
        "f6" => Some(csi_tilde(17, modifier)),
        "f7" => Some(csi_tilde(18, modifier)),
        "f8" => Some(csi_tilde(19, modifier)),
        "f9" => Some(csi_tilde(20, modifier)),
        "f10" => Some(csi_tilde(21, modifier)),
        "f11" => Some(csi_tilde(23, modifier)),
        "f12" => Some(csi_tilde(24, modifier)),
        _ => None,
    }
}

fn csi_tilde(code: usize, modifier: usize) -> String {
    if modifier > 1 {
        format!("\u{1b}[{code};{modifier}~")
    } else {
        format!("\u{1b}[{code}~")
    }
}

fn split_path_key(path: &[usize]) -> String {
    if path.is_empty() {
        "root".to_string()
    } else {
        path.iter()
            .map(usize::to_string)
            .collect::<Vec<_>>()
            .join(".")
    }
}

fn stepped_terminal_font_size(current: f32, direction: f32) -> f32 {
    (current + direction * TERMINAL_FONT_SIZE_STEP)
        .clamp(MIN_TERMINAL_FONT_SIZE, MAX_TERMINAL_FONT_SIZE)
}

fn status_message(terminal: &MuxTerminal) -> String {
    match terminal.output.process_state.as_str() {
        "starting" => "The terminal is still starting.".to_string(),
        "restoring" => "The terminal is restoring its process.".to_string(),
        "interrupted" => {
            "The terminal was interrupted. Restart it from the web client.".to_string()
        }
        "orphaned" => "The terminal process is unavailable.".to_string(),
        "failed" => "The terminal failed to start.".to_string(),
        _ => format!("The terminal is {}.", terminal.status),
    }
}

fn terminal_line(
    cells: &[TerminalCell],
    row_index: usize,
    cursor: &crate::model::TerminalCursor,
    cursor_color: Hsla,
    cursor_foreground: Hsla,
) -> (SharedString, Vec<(Range<usize>, HighlightStyle)>) {
    let mut text = String::new();
    let mut highlights = Vec::with_capacity(cells.len());
    for (column, cell) in cells.iter().enumerate() {
        let start = text.len();
        if cell.text.is_empty() {
            text.push(' ');
        } else {
            text.push_str(&cell.text);
        }
        let end = text.len();
        let cursor_here = cursor.visible && cursor.y == row_index && cursor.x == column;
        highlights.push((
            start..end,
            cell_highlight(cell, cursor_here, cursor_color, cursor_foreground),
        ));
    }
    if text.is_empty() {
        text.push(' ');
    }
    (text.into(), highlights)
}

fn cell_highlight(
    cell: &TerminalCell,
    cursor_here: bool,
    cursor_color: Hsla,
    cursor_foreground: Hsla,
) -> HighlightStyle {
    let mut foreground = terminal_color(cell.foreground);
    let mut background = terminal_color(cell.background);
    if cell.inverse {
        std::mem::swap(&mut foreground, &mut background);
    }
    if cursor_here {
        foreground = cursor_foreground;
        background = cursor_color;
    }
    let underline_color = cell
        .underline_color
        .map(terminal_color)
        .unwrap_or(foreground);
    HighlightStyle {
        color: Some(if cell.invisible {
            foreground.opacity(0.0)
        } else {
            foreground
        }),
        font_weight: cell.bold.then_some(FontWeight::BOLD),
        font_style: cell.italic.then_some(FontStyle::Italic),
        background_color: Some(background),
        underline: (cell.underline > 0).then_some(UnderlineStyle {
            thickness: px(1.0),
            color: Some(underline_color),
            wavy: false,
        }),
        strikethrough: cell.strikethrough.then_some(StrikethroughStyle {
            thickness: px(1.0),
            color: Some(foreground),
        }),
        fade_out: cell.faint.then_some(0.45),
    }
}

fn terminal_color(color: TerminalColor) -> Hsla {
    let alpha = if color.a > 1.0 {
        color.a / 255.0
    } else {
        color.a
    };
    Rgba {
        r: (color.r / 255.0).clamp(0.0, 1.0),
        g: (color.g / 255.0).clamp(0.0, 1.0),
        b: (color.b / 255.0).clamp(0.0, 1.0),
        a: alpha.clamp(0.0, 1.0),
    }
    .into()
}

fn ansi_replay_snapshot(
    attached: &crate::model::TerminalAttachResult,
    scheme: ColorScheme,
) -> Option<TerminalSemanticSnapshot> {
    let rows = attached.rows.unwrap_or(24).clamp(1, u16::MAX as usize) as u16;
    let cols = attached.cols.unwrap_or(80).clamp(1, u16::MAX as usize) as u16;
    let mut parser = vt100::Parser::new(rows, cols, 0);
    for chunk in &attached.output_chunks {
        parser.process(chunk.as_bytes());
    }
    if !attached.output.is_empty() {
        parser.process(attached.output.as_bytes());
    }
    let screen = parser.screen();
    let screen_rows = (0..rows)
        .map(|row| TerminalRow {
            row_id: format!("replay-{row}"),
            cells: (0..cols)
                .map(|col| {
                    let cell = screen.cell(row, col);
                    let foreground = cell
                        .map(|value| ansi_color(value.fgcolor(), scheme, true))
                        .unwrap_or_else(|| ansi_default_color(scheme, true));
                    let background = cell
                        .map(|value| ansi_color(value.bgcolor(), scheme, false))
                        .unwrap_or_else(|| ansi_default_color(scheme, false));
                    TerminalCell {
                        text: cell
                            .map(|value| value.contents().to_string())
                            .unwrap_or_default(),
                        wide: u8::from(cell.is_some_and(vt100::Cell::is_wide)),
                        foreground,
                        background,
                        underline_color: None,
                        bold: cell.is_some_and(vt100::Cell::bold),
                        faint: cell.is_some_and(vt100::Cell::dim),
                        italic: cell.is_some_and(vt100::Cell::italic),
                        blink: false,
                        inverse: cell.is_some_and(vt100::Cell::inverse),
                        invisible: false,
                        strikethrough: false,
                        overline: false,
                        underline: u8::from(cell.is_some_and(vt100::Cell::underline)),
                        hyperlink_id: None,
                    }
                })
                .collect(),
            is_wrap_continuation: false,
            wraps_to_next: false,
        })
        .collect();
    let (cursor_row, cursor_col) = screen.cursor_position();
    Some(TerminalSemanticSnapshot {
        schema_version: 1,
        cols: usize::from(cols),
        rows: usize::from(rows),
        active_screen: "primary".to_string(),
        revision: 0,
        cursor: TerminalCursor {
            x: usize::from(cursor_col),
            y: usize::from(cursor_row),
            visible: !screen.hide_cursor(),
            blinking: true,
            style: 1,
        },
        screen_rows,
        scrollback: Default::default(),
        modes: Default::default(),
        title: attached.title.clone(),
        palette: Vec::new(),
        hyperlinks: Vec::new(),
    })
}

fn ansi_default_color(scheme: ColorScheme, foreground: bool) -> TerminalColor {
    match (scheme, foreground) {
        (ColorScheme::Dark, true) => terminal_rgb(238, 242, 247),
        (ColorScheme::Dark, false) => terminal_rgb(14, 21, 27),
        (ColorScheme::Light, true) => terminal_rgb(21, 27, 35),
        (ColorScheme::Light, false) => terminal_rgb(234, 241, 248),
    }
}

fn ansi_color(color: vt100::Color, scheme: ColorScheme, foreground: bool) -> TerminalColor {
    match color {
        vt100::Color::Default => ansi_default_color(scheme, foreground),
        vt100::Color::Rgb(red, green, blue) => terminal_rgb(red, green, blue),
        vt100::Color::Idx(index) if index < 16 => {
            let palette = match scheme {
                ColorScheme::Dark => DARK_ANSI,
                ColorScheme::Light => LIGHT_ANSI,
            };
            let [red, green, blue] = palette[usize::from(index)];
            terminal_rgb(red, green, blue)
        }
        vt100::Color::Idx(index) if index < 232 => {
            let cube = index - 16;
            let channel = |value: u8| if value == 0 { 0 } else { 55 + value * 40 };
            terminal_rgb(
                channel(cube / 36),
                channel((cube % 36) / 6),
                channel(cube % 6),
            )
        }
        vt100::Color::Idx(index) => {
            let gray = 8 + (index - 232) * 10;
            terminal_rgb(gray, gray, gray)
        }
    }
}

const DARK_ANSI: [[u8; 3]; 16] = [
    [4, 7, 11],
    [253, 115, 109],
    [71, 190, 139],
    [232, 181, 67],
    [89, 166, 255],
    [201, 148, 255],
    [72, 183, 189],
    [228, 232, 237],
    [127, 135, 144],
    [255, 128, 121],
    [93, 209, 158],
    [245, 194, 82],
    [102, 179, 255],
    [214, 161, 255],
    [93, 203, 209],
    [252, 252, 252],
];

const LIGHT_ANSI: [[u8; 3]; 16] = [
    [38, 38, 41],
    [204, 40, 39],
    [19, 119, 56],
    [199, 107, 0],
    [31, 79, 204],
    [125, 47, 200],
    [0, 116, 122],
    [246, 247, 248],
    [98, 98, 108],
    [215, 52, 49],
    [41, 134, 70],
    [219, 125, 36],
    [42, 92, 218],
    [140, 65, 217],
    [0, 131, 136],
    [255, 255, 255],
];

fn terminal_rgb(red: u8, green: u8, blue: u8) -> TerminalColor {
    TerminalColor {
        r: f32::from(red),
        g: f32::from(green),
        b: f32::from(blue),
        a: 1.0,
    }
}

#[cfg(test)]
mod tests {
    use anyhow::Result;

    use super::*;
    use crate::model::{TerminalColor, TerminalCursor};

    fn cell(text: &str) -> TerminalCell {
        TerminalCell {
            text: text.to_string(),
            wide: 1,
            foreground: TerminalColor {
                r: 229.0,
                g: 231.0,
                b: 235.0,
                a: 1.0,
            },
            background: TerminalColor {
                r: 0.0,
                g: 0.0,
                b: 0.0,
                a: 1.0,
            },
            underline_color: None,
            bold: false,
            faint: false,
            italic: false,
            blink: false,
            inverse: false,
            invisible: false,
            strikethrough: false,
            overline: false,
            underline: 0,
            hyperlink_id: None,
        }
    }

    #[test]
    fn terminal_zoom_bindings_parse() {
        assert_eq!(zoom_key_bindings().len(), 4);
    }

    #[test]
    fn terminal_zoom_steps_and_clamps() {
        assert_eq!(stepped_terminal_font_size(12.0, 1.0), 13.0);
        assert_eq!(stepped_terminal_font_size(12.0, -1.0), 11.0);
        assert_eq!(
            stepped_terminal_font_size(MAX_TERMINAL_FONT_SIZE, 1.0),
            24.0
        );
        assert_eq!(
            stepped_terminal_font_size(MIN_TERMINAL_FONT_SIZE, -1.0),
            8.0
        );
    }

    #[test]
    fn terminal_line_keeps_empty_cells_and_cursor_run() -> Result<()> {
        let theme = NativeTheme::load(ColorScheme::Dark)?;
        let cursor = TerminalCursor {
            x: 1,
            y: 0,
            visible: true,
            blinking: false,
            style: 1,
        };
        let (text, highlights) = terminal_line(
            &[cell("a"), cell("")],
            0,
            &cursor,
            theme.primary,
            theme.primary_foreground,
        );
        assert_eq!(text.to_string(), "a ");
        assert_eq!(highlights.len(), 2);
        assert_eq!(highlights[1].1.background_color, Some(theme.primary));
        Ok(())
    }
}
