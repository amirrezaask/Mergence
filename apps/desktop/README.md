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
SVG geometry. It hydrates the same Session → Window → terminal model as the web
client, consumes semantic terminal snapshots and patches over the realtime
socket, and falls back to bounded ANSI replay when a host cannot publish a
semantic screen. Terminal input, bracketed paste, IME composition, resize,
reconnect, tiling, pane drag-and-drop, pane zoom, rename controls, terminal
switching, session close confirmation, loading/empty/error states, reduced-motion
fallback, and native macOS title-bar integration are supported.

Useful controls:

- `⌘/Ctrl` + `+`, `-`, or `0` changes or resets terminal text size.
- `⌘/Ctrl` + `K` opens the terminal switcher.
- `⌘/Ctrl` + `Shift-N` creates a Session; `Shift-T` creates a Window; `T`
  creates a terminal; `W` closes the focused terminal.
- `⌘/Ctrl` + `D` and `Shift-D` split right and down; `Shift-Enter` toggles
  pane zoom.

These shortcuts remain available while a terminal has focus. The host remains
the owner of PTYs and persisted state; the desktop process never starts or
owns terminal processes itself.
