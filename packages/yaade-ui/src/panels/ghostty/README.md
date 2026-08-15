# Ghostty web terminal

This directory is YAADE's browser adapter for the pinned `libghostty-vt` ABI.
It keeps the terminal parser and state in Ghostty WASM, while Canvas 2D owns the
browser presentation and the existing host PTY owns process lifetime.

- `runtime.ts` loads one WASM instance and installs the PTY callback trampoline.
- `core.ts` owns per-terminal Ghostty handles and converts render state to rows.
- `renderer.ts` paints cell backgrounds, graphemes, decorations, selection and cursor.
- `surface.ts` owns input, IME, selection, scrollback, sizing and frame scheduling.
- `vendor/VERSION` is the exact upstream Ghostty commit used by the artifact.
- `scripts/build-ghostty-wasm.sh` rebuilds both WASM assets reproducibly.

The parser's dirty flags are acknowledged only by the paint path. Debug and
agent buffer reads use non-consuming snapshots so inspection cannot suppress a
pending canvas repaint.
