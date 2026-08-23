use std::collections::HashMap;

use anyhow::{Context as _, Result, bail};
use gpui::{Hsla, Rgba, rgb};
use serde::Deserialize;

const DESIGN_CONTRACT: &str = include_str!("../design-contract.json");

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ColorScheme {
    Dark,
    Light,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignMetrics {
    pub root_font_size_px: f32,
    pub island_radius_px: f32,
    pub pane_radius_px: f32,
    pub control_radius_px: f32,
    pub menu_radius_px: f32,
    pub tab_bar_height_px: f32,
    pub tab_pill_height_px: f32,
    pub terminal_workspace_padding_px: f32,
    pub pane_chrome_height_px: f32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignMotion {
    pub hot_ms: u64,
    pub menu_ms: u64,
    pub overlay_ms: u64,
    pub panel_ms: u64,
    pub ease_out: String,
    pub ease_in_out: String,
    pub ease_drawer: String,
    pub press_scale: f32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContractTheme {
    semantic: HashMap<String, String>,
}

#[derive(Clone, Debug, Deserialize)]
struct ContractThemes {
    dark: ContractTheme,
    light: ContractTheme,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesignContract {
    schema_version: u32,
    metrics: DesignMetrics,
    motion: DesignMotion,
    themes: ContractThemes,
}

#[derive(Clone, Debug)]
pub struct NativeTheme {
    pub scheme: ColorScheme,
    pub metrics: DesignMetrics,
    pub motion: DesignMotion,
    pub background: Hsla,
    pub foreground: Hsla,
    pub card: Hsla,
    pub popover: Hsla,
    pub primary: Hsla,
    pub primary_foreground: Hsla,
    pub secondary: Hsla,
    pub secondary_foreground: Hsla,
    pub muted: Hsla,
    pub muted_foreground: Hsla,
    pub accent: Hsla,
    pub accent_foreground: Hsla,
    pub destructive: Hsla,
    pub success: Hsla,
    pub warning: Hsla,
    pub info: Hsla,
    pub border: Hsla,
    pub ring: Hsla,
    pub chrome: Hsla,
    pub content: Hsla,
    pub floating: Hsla,
    pub light_edge: Hsla,
    pub dark_edge: Hsla,
    pub specular: Hsla,
}

impl NativeTheme {
    pub fn load(scheme: ColorScheme) -> Result<Self> {
        let contract: DesignContract =
            serde_json::from_str(DESIGN_CONTRACT).context("invalid desktop design contract")?;
        if contract.schema_version != 1 {
            bail!(
                "unsupported desktop design contract schema {}",
                contract.schema_version
            );
        }
        let semantic = match scheme {
            ColorScheme::Dark => &contract.themes.dark.semantic,
            ColorScheme::Light => &contract.themes.light.semantic,
        };
        let color = |name: &str| -> Result<Hsla> {
            let value = semantic
                .get(name)
                .with_context(|| format!("design contract is missing {name}"))?;
            parse_hex(value)
        };

        let background = color("background")?;
        let foreground = color("foreground")?;
        let card = color("card")?;
        let popover = color("popover")?;
        let white = Hsla::from(rgb(0xffffff));
        let (chrome, floating, light_edge, specular) = match scheme {
            ColorScheme::Dark => (
                card.opacity(0.80),
                popover.opacity(0.38),
                white.opacity(0.12),
                white.opacity(0.22),
            ),
            ColorScheme::Light => (
                white.opacity(0.52),
                white.opacity(0.58),
                white.opacity(0.38),
                white.opacity(0.55),
            ),
        };

        Ok(Self {
            scheme,
            metrics: contract.metrics,
            motion: contract.motion,
            background,
            foreground,
            card,
            popover,
            primary: color("primary")?,
            primary_foreground: color("primaryForeground")?,
            secondary: color("secondary")?,
            secondary_foreground: color("secondaryForeground")?,
            muted: color("muted")?,
            muted_foreground: color("mutedForeground")?,
            accent: color("accent")?,
            accent_foreground: color("accentForeground")?,
            destructive: color("destructive")?,
            success: color("success")?,
            warning: color("warning")?,
            info: color("info")?,
            border: color("border")?,
            ring: color("ring")?,
            chrome,
            content: background.opacity(0.92),
            floating,
            light_edge,
            dark_edge: foreground.opacity(0.08),
            specular,
        })
    }

    pub fn toggled(&self) -> Result<Self> {
        Self::load(match self.scheme {
            ColorScheme::Dark => ColorScheme::Light,
            ColorScheme::Light => ColorScheme::Dark,
        })
    }
}

fn parse_hex(value: &str) -> Result<Hsla> {
    let value = value
        .strip_prefix('#')
        .with_context(|| format!("expected hex color, received {value}"))?;
    if value.len() != 6 {
        bail!("expected six-digit hex color, received #{value}");
    }
    let packed =
        u32::from_str_radix(value, 16).with_context(|| format!("invalid hex color #{value}"))?;
    let rgba = Rgba {
        r: ((packed >> 16) & 0xff) as f32 / 255.0,
        g: ((packed >> 8) & 0xff) as f32 / 255.0,
        b: (packed & 0xff) as f32 / 255.0,
        a: 1.0,
    };
    Ok(rgba.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_contract_loads_both_schemes() {
        let dark = NativeTheme::load(ColorScheme::Dark).expect("dark theme");
        let light = NativeTheme::load(ColorScheme::Light).expect("light theme");
        assert_eq!(dark.metrics.tab_bar_height_px, 42.25);
        assert_eq!(dark.metrics.control_radius_px, 8.125);
        assert_eq!(dark.scheme, ColorScheme::Dark);
        assert_eq!(light.scheme, ColorScheme::Light);
        assert_ne!(dark.background, light.background);
    }
}
