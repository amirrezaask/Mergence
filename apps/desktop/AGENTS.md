# YAADE Desktop

- This crate is a GPUI client for the existing TypeScript host. Do not spawn or own PTYs here.
- Keep Session → Window → terminal terminology and wire behavior aligned with `@yaade/rpc`.
- Store semantic terminal snapshots/patches in view state; never put raw PTY byte streams in general application state.
- Network and decoding work runs off the GPUI render thread. UI callbacks only update bounded state and request repaint.
- `design-contract.json` is generated from the web theme/CSS sources. Never hand-edit it; run `node scripts/export-desktop-design-contract.mjs`.
- Use bundled Geist/Geist Mono and embedded Lucide SVGs. Do not substitute Unicode glyphs for icons.
- Actions update state immediately; motion is visual feedback and must not block input.
- First-party verification commands:
  - `cargo fmt --manifest-path apps/desktop/Cargo.toml -- --check`
  - `cargo test --manifest-path apps/desktop/Cargo.toml`
  - `cargo clippy --manifest-path apps/desktop/Cargo.toml --all-targets -- -D warnings`
  - `node scripts/export-desktop-design-contract.mjs --check`
