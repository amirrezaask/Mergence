use std::borrow::Cow;

use anyhow::{Result, anyhow};
use gpui::{AssetSource, SharedString};

pub struct DesktopAssets;

impl AssetSource for DesktopAssets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        let bytes: &'static [u8] = match path {
            "icons/terminal.svg" => include_bytes!("../assets/icons/terminal.svg"),
            "icons/layers-3.svg" => include_bytes!("../assets/icons/layers-3.svg"),
            "icons/app-window.svg" => include_bytes!("../assets/icons/app-window.svg"),
            "icons/chevron-down.svg" => include_bytes!("../assets/icons/chevron-down.svg"),
            "icons/plus.svg" => include_bytes!("../assets/icons/plus.svg"),
            "icons/x.svg" => include_bytes!("../assets/icons/x.svg"),
            "icons/check.svg" => include_bytes!("../assets/icons/check.svg"),
            "icons/settings.svg" => include_bytes!("../assets/icons/settings.svg"),
            "icons/refresh-cw.svg" => include_bytes!("../assets/icons/refresh-cw.svg"),
            "icons/panel-right.svg" => include_bytes!("../assets/icons/panel-right.svg"),
            "icons/panel-bottom.svg" => include_bytes!("../assets/icons/panel-bottom.svg"),
            "icons/maximize.svg" => include_bytes!("../assets/icons/maximize.svg"),
            "icons/minimize.svg" => include_bytes!("../assets/icons/minimize.svg"),
            _ => return Ok(None),
        };
        Ok(Some(Cow::Borrowed(bytes)))
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        if path != "icons" {
            return Err(anyhow!("unknown embedded asset directory: {path}"));
        }
        Ok([
            "terminal.svg",
            "layers-3.svg",
            "app-window.svg",
            "chevron-down.svg",
            "plus.svg",
            "x.svg",
            "check.svg",
            "settings.svg",
            "refresh-cw.svg",
            "panel-right.svg",
            "panel-bottom.svg",
            "maximize.svg",
            "minimize.svg",
        ]
        .into_iter()
        .map(SharedString::from)
        .collect())
    }
}

pub fn embedded_fonts() -> Vec<Cow<'static, [u8]>> {
    vec![
        Cow::Borrowed(include_bytes!("../assets/fonts/Geist-Regular.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/Geist-Medium.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/Geist-SemiBold.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/Geist-Bold.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/GeistMono-Regular.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/GeistMono-Medium.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/GeistMono-SemiBold.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/GeistMono-Bold.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/GeistMono-Italic.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/GeistMono-BoldItalic.ttf")),
    ]
}
