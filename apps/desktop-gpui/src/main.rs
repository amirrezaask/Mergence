mod app;
mod assets;
mod client;
mod model;
mod service;
mod terminal;
mod theme;

use std::borrow::Cow;

use app::YaadeApp;
use assets::YaadeAssets;
use gpui::{
    App, Application, Bounds, KeyBinding, WindowBounds, WindowOptions, actions, prelude::*, px,
    size,
};
use terminal::view::{Copy, Paste, SelectAll};

actions!(yaade, [NewSession, NewWindow, NewTerminal, CloseTerminal]);

fn main() {
    service::ensure_default_host();
    Application::new()
        .with_assets(YaadeAssets::bundled())
        .run(|cx: &mut App| {
            let _ = cx.text_system().add_fonts(vec![
                Cow::Borrowed(include_bytes!("../assets/fonts/Geist-Variable.ttf")),
                Cow::Borrowed(include_bytes!("../assets/fonts/GeistMono-Variable.ttf")),
            ]);
            cx.bind_keys([
                KeyBinding::new("cmd-a", SelectAll, None),
                KeyBinding::new("cmd-c", Copy, None),
                KeyBinding::new("cmd-v", Paste, None),
                KeyBinding::new("cmd-shift-n", NewSession, None),
                KeyBinding::new("cmd-n", NewWindow, None),
                KeyBinding::new("cmd-t", NewTerminal, None),
                KeyBinding::new("cmd-w", CloseTerminal, None),
            ]);

            let bounds = Bounds::centered(None, size(px(1440.0), px(900.0)), cx);
            cx.open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    window_min_size: Some(size(px(900.0), px(600.0))),
                    titlebar: Some(gpui::TitlebarOptions {
                        title: Some("YAADE".into()),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                |window, cx| {
                    let root = cx.new(|cx| YaadeApp::new(window, cx));
                    root.update(cx, |_, cx| {
                        cx.observe_window_bounds(window, |this, window, cx| {
                            this.resize_active_terminal(window, cx);
                        })
                        .detach();
                    });
                    root
                },
            )
            .expect("open YAADE window");
            cx.activate(true);
        });
}
