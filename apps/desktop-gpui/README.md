# YAADE Desktop GPUI

A native Rust/GPUI client for the existing YAADE server multiplexer. The server remains the sole owner of PTYs and child processes; this app observes and controls them through `/api/v1/rpc` and the binary `/ws` terminal stream.

The visual metrics, Default Dark palette, Geist typography, chrome geometry, and terminal workspace material mirror the browser/Tauri client. Terminal parsing, cell state, input encoding, selection, and GPU rendering use Ghostty through the pinned `gpui-ghostty-terminal` crate in `crates/`.

## Prerequisites

- Latest stable Rust
- Full Xcode on macOS (GPUI compiles Metal shaders with `xcrun metal`)
- Zig 0.14.1 for the pinned Ghostty VT build
- A `yaade` server executable in `PATH`, or `YAADE_SERVER_BIN=/path/to/yaade`

```bash
vp run dev:desktop-gpui
vp run test:desktop-gpui
vp run build:desktop-gpui
```

The standard build and test commands compile the real Ghostty renderer; there is no alternate terminal implementation.

The application checks `127.0.0.1:7774` on startup and runs `yaade install` when the user service is unavailable. Closing the GPUI process only disconnects the client; it does not stop host PTYs.

## Current native surface

- Session and Window selection
- Session, Window, and terminal creation
- Window and terminal close actions
- Live binary terminal stream with replay, acknowledgements, and reconnect
- Host-owned resize and input
- Multiple terminal switching within a Window
- Ghostty VT parsing and GPUI rendering

Remote server management and the full settings overlay remain in the Tauri/browser client for now.
