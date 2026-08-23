# YAADE Desktop

Native Rust + GPUI client for the existing YAADE host.

The desktop application is a client, not a second host runtime. It connects to
`http://127.0.0.1:4747` by default, hydrates Sessions → Windows → terminals over
the existing typed RPC boundary, and renders the host's Ghostty-backed semantic
terminal snapshot. PTY bytes remain owned by the server terminal runtime.

```bash
vp run dev:server
cargo run --manifest-path apps/desktop/Cargo.toml
```

Use another host or bearer token with:

```bash
YAADE_HOST_URL=https://devbox.example.com \
YAADE_HOST_TOKEN=replace-me \
  cargo run --manifest-path apps/desktop/Cargo.toml
```

## Visual parity

`design-contract.json` is generated from the incumbent web tokens and metrics:

```bash
node scripts/export-desktop-design-contract.mjs
node scripts/export-desktop-design-contract.mjs --check
```

For deterministic visual captures, launch with
`YAADE_DESKTOP_PREVIEW=session-switcher` or `YAADE_DESKTOP_PREVIEW=settings`.
These values only choose the initially open overlay; normal interaction remains
unchanged.

The GPUI shell bundles static Geist and Geist Mono faces plus matching Lucide
SVG geometry. The current slice includes real host hydration, animated Session
and Window selection/creation, terminal attachment, semantic screen rendering,
ANSI replay fallback for pre-semantic PTYs, cursor and overlay motion, theme
switching, loading/empty/error states, reduced-motion fallback, and native
macOS title-bar integration. Use `⌘/Ctrl` + `+` or `-` to zoom terminal text and
`⌘/Ctrl` + `0` to reset it; these shortcuts remain available while the terminal
has focus. Live terminal patches, input, resize, tiling, and full settings
parity are the next slice.
