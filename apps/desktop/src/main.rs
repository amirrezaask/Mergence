use gpui::{
    App, AppContext as _, Application, Bounds, TitlebarOptions, WindowAppearance, WindowBounds,
    WindowOptions, point, px, size,
};
use yaade_desktop::{
    app::{DesktopApp, desktop_key_bindings},
    assets::{DesktopAssets, embedded_fonts},
    host::HostConfig,
    theme::{ColorScheme, NativeTheme},
};

fn main() {
    let _ = env_logger::try_init();
    Application::new()
        .with_assets(DesktopAssets)
        .run(|cx: &mut App| {
            cx.bind_keys(desktop_key_bindings());
            cx.text_system()
                .add_fonts(embedded_fonts())
                .expect("could not load bundled Geist fonts");
            let scheme = match cx.window_appearance() {
                WindowAppearance::Dark | WindowAppearance::VibrantDark => ColorScheme::Dark,
                WindowAppearance::Light | WindowAppearance::VibrantLight => ColorScheme::Light,
            };
            let theme = NativeTheme::load(scheme).expect("could not load native design contract");
            let bounds = Bounds::centered(None, size(px(1440.0), px(900.0)), cx);
            cx.open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    titlebar: Some(TitlebarOptions {
                        title: Some("YAADE".into()),
                        appears_transparent: true,
                        traffic_light_position: Some(point(px(13.0), px(13.0))),
                    }),
                    window_min_size: Some(size(px(900.0), px(600.0))),
                    app_id: Some("dev.yaade.desktop".to_string()),
                    ..Default::default()
                },
                |window, cx| {
                    cx.new(|cx| DesktopApp::new(HostConfig::from_env(), theme, window, cx))
                },
            )
            .expect("could not open YAADE window");
            cx.on_window_closed(|cx| cx.quit()).detach();
            cx.activate(true);
        });
}
