use gpui::{Rgba, rgb, rgba};

use crate::terminal::GhosttyRgb;

#[derive(Clone, Copy)]
pub struct YaadeTheme {
    pub background: Rgba,
    pub foreground: Rgba,
    pub card: Rgba,
    pub chrome: Rgba,
    pub content: Rgba,
    pub muted_foreground: Rgba,
    pub primary: Rgba,
    pub accent: Rgba,
    pub border: Rgba,
}

impl YaadeTheme {
    pub fn dark() -> Self {
        Self {
            background: rgb(0x0e151b),
            foreground: rgb(0xeef2f7),
            card: rgb(0x171d24),
            chrome: rgb(0x161c23),
            content: rgb(0x0f161c),
            muted_foreground: rgb(0xa8b2be),
            primary: rgb(0x006ade),
            accent: rgb(0x172a3e),
            border: rgba(0xffffff1f),
        }
    }

    pub fn alpha(color: Rgba, alpha: f32) -> Rgba {
        let mut value = color;
        value.a = alpha;
        value
    }

    pub fn terminal_foreground(self) -> GhosttyRgb {
        GhosttyRgb {
            r: 0xee,
            g: 0xf2,
            b: 0xf7,
        }
    }

    pub fn terminal_background(self) -> GhosttyRgb {
        GhosttyRgb {
            r: 0x0f,
            g: 0x16,
            b: 0x1c,
        }
    }
}
