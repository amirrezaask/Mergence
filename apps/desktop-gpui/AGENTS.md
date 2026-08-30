# YAADE Desktop GPUI

- This is a native GPUI client of the existing YAADE host. It never owns PTYs or launches coding agents directly.
- Keep host interaction behind the typed RPC and binary terminal WebSocket modules.
- Browser disconnect and app exit must only unsubscribe; explicit terminal close is the only UI action that kills a PTY.
- Terminal output belongs in the Ghostty terminal entity, never in the multiplexer shell state.
- Preserve visual parity with `@yaade/ui`: semantic palette, Geist typography, compact metrics, rounded terminal islands, and motion intent.
- The vendored renderer in `crates/gpui-ghostty-terminal` is Apache-2.0 upstream code. Keep its GPUI and Ghostty revisions pinned together.
- Keep network and parsing work off GPUI's render path; batch terminal output before notifying the view.
