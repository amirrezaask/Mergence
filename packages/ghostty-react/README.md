# `@yaade/ghostty-react`

A browser React component for rendering terminal sessions with the pinned
`libghostty-vt` WebAssembly parser and a Canvas 2D grid renderer.

The package owns terminal emulation, keyboard/IME input, selection, scrollback,
links, cursor rendering, font metrics, and resize measurement. It deliberately
does not own a PTY, transport, persistence, or application state.

```tsx
import {
  GhosttyTerminal,
  type GhosttyTerminalSurface,
  type GhosttyTheme,
} from "@yaade/ghostty-react"
import "@yaade/ghostty-react/fonts.css"

const terminalRef = useRef<GhosttyTerminalSurface | null>(null)

<GhosttyTerminal
  ref={terminalRef}
  theme={theme}
  onData={(data) => pty.write(data)}
  onResize={(cols, rows) => pty.resize(cols, rows)}
/>

// Feed PTY output after onReady or once the ref is populated.
terminalRef.current?.write(output)
```

`onData` is the only terminal-to-host data channel. Hosts can use
`linkMatcher` to provide application-specific link detection while keeping
link activation in the host.

The vendored Ghostty assets are pinned by `src/vendor/VERSION`. Rebuild them
with:

```sh
vp run --filter @yaade/ghostty-react build:ghostty-wasm
```
