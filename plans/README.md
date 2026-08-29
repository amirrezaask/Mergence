# Terminal Rendering Implementation Plans

Generated on 2026-08-30 at commit `717ed49f` and extended after the resize/TUI
audit at commit `f21fcdf4`. These plans modernize the shared browser/Tauri
terminal renderer without creating a desktop-only implementation. Execute them
in the order below unless the dependency waves say otherwise. Each executor must
read its plan fully, preserve pre-existing working-tree changes, honor STOP
conditions, and update its status.

## Execution order and status

| Plan | Title | Maps to proposal item | Priority | Effort | Depends on | Status |
|---|---|---:|---|---|---|---|
| [001](001-terminal-render-frame-seam.md) | Introduce a packed render-frame seam | 3 | P1 | L | — | DONE |
| [002](002-webgl2-terminal-renderer.md) | Add WebGL2 as the preferred renderer | 1 | P1 | L | 001 | DONE |
| [003](003-terminal-renderer-recovery.md) | Make renderer failure and recovery explicit | 6 | P1 | M | 002 | DONE |
| [004](004-worker-terminal-runtime.md) | Move Ghostty parsing off the main thread | 2 | P2 | L | 001, 003 | DONE |
| [005](005-terminal-frame-scheduler.md) | Unify scheduling and end-to-end backpressure | 5 | P2 | L | 004 | DONE |
| [006](006-webgpu-terminal-experiment.md) | Add a gated experimental WebGPU adapter | 4 | P3 | L | 002, 003, 005 | REJECTED (removed after blank WKWebView output) |
| [007](007-terminal-present-latency-benchmarks.md) | Measure resize, zoom, TUI, and presented-frame latency | — | P1 | M | 004, 005 | DONE |
| [008](008-resident-terminal-surfaces.md) | Keep terminal runtimes resident across layout changes | — | P1 | L | 004, 005, 007 | DONE |
| [009](009-complex-tui-renderer-conformance.md) | Enforce complex-TUI renderer conformance | — | P1 | L | 003 | DONE |
| [010](010-retained-gpu-scene-and-glyph-cache.md) | Add a retained GPU scene and stable glyph cache | — | P1 | L | 007, 009 | DONE |
| [011](011-packed-viewport-hot-path.md) | Keep viewport data packed through rendering | — | P2 | L | 004, 005, 010 | DONE |
| [012](012-transactional-terminal-resize.md) | Make resize and DPR changes transactional | — | P1 | L | 007, 008, 010, 011 | DONE |

Status values: `TODO`, `IN PROGRESS`, `DONE`, `BLOCKED (<reason>)`, or
`REJECTED (<reason>)`.

Plan 002 result: WebGL2 remains the fallback default after its self-test. After
batching same-style text into atlas runs, three Apple M4 runs measured stream
medians of 271.5/283.0/266.5 ms, flood medians of 77.6/76.4/76.6 ms, idle typing
medians of 11.7 ms, and under-flood typing medians of 8.7/8.4/11.9 ms.

Plans 004 and 005 now run by default by explicit operator direction. The worker
pool transfers packed updates, ACKs only parsed sequences, recovers through
host replay, and feeds a bounded scheduler that measures received, posted,
parsed, and presented stages. The local benchmark did not show a p95 gain, so
no performance claim or budget change accompanies the rollout.

Plan 006 was removed after a real WKWebView run produced a blank terminal despite
successful capability initialization. WebGL2 and Canvas remain the complete
renderer ladder until WebGPU has reliable cross-WebView presentation tests.
See `docs/terminal-renderers.md` for measurements and compatibility details.

Plans 007–012 now share one presented-frame clock, resident terminal placement,
backend-neutral decoration/cursor geometry, a retained WebGL row scene with
stable cluster caching, a packed lazy viewport, and one generation-aware
geometry coordinator. WebGL capture uses a test-only framebuffer while the
production context keeps `preserveDrawingBuffer` disabled. Responsive and pane
layout changes move the existing surface without PTY/runtime/renderer reattach;
local and host geometry commits are coalesced latest-wins.

## Dependency notes

- **001 before 002:** WebGL2 must consume a renderer-neutral packed update, not
  couple directly to `GhosttySnapshot` or duplicate Canvas traversal logic.
- **003 before 004:** context-loss and adapter replacement need to work before a
  worker introduces another failure domain.
- **004 before 005:** scheduling ownership can only be finalized after the
  parser's thread and message acknowledgement points are known.
- **006 result:** WebGPU was removed after blank WKWebView output. Plans 009 and
  010 target the shipped WebGL/Canvas ladder; any future adapter must first pass
  its own browser/Tauri compatibility gate and then join these contracts.
- **007 before performance fixes:** current benchmarks can complete before GPU
  presentation; later plans need a trustworthy presented-frame endpoint.
- **008 after 007:** terminal residency needs lifecycle IDs/counters that prove a
  layout move did not recreate, reattach, or replay the terminal.
- **009 before 010:** atlas/model changes are unsafe until decorations, cursor,
  wide/combining glyphs, and fractional-DPR geometry have differential guards.
- **010 before 011:** packed hot-path access should target the final retained
  scene interface, not force two renderer-model migrations.
- **012 last:** resize coordination relies on stable residency, cheap full-scene
  composition, packed model application, and presented-frame measurement.

## Recommended execution waves

1. Run Plans 007 and 009; they can proceed in parallel after the completed
   worker/scheduler work and removed WebGPU experiment settle in the working tree.
2. Run Plans 008 and 010; they touch different ownership layers but coordinate
   through Plan 007 lifecycle/frame IDs.
3. Run Plan 011.
4. Run Plan 012 and re-run all resize, multiplexer, compatibility, and benchmark
   suites as the final integration gate.

## Cross-plan invariants

1. PTY bytes never enter React state.
2. Browser and Tauri continue using the same `@yaade/app` and
   `@yaade/ghostty-react` implementation.
3. `libghostty-vt` remains the terminal-state authority.
4. Canvas 2D remains the correctness oracle and guaranteed fallback.
5. Renderer, worker, or GPU failure must not close, resize, or disconnect a PTY.
6. Existing replay acknowledgements occur only after bytes have been parsed;
   rendering may lag or recover independently.
7. IME, keyboard, selection, links, synchronized output, scrollback, wide
   graphemes, zoom, DPR changes, reduced motion, and hidden panes must retain
   existing semantics.
8. Every performance claim requires `vp run test:bench` results from a release
   web build on recorded hardware.
9. Pane zoom, responsive layout changes, and browser zoom must not recreate or
   reattach a resident terminal runtime.
10. Cache pressure is routine bounded policy; it must not be reported as GPU
    context/device failure or trigger renderer recovery.
11. Canvas and accelerated backends share tested terminal semantics for complex
    TUIs, including decorations, cursor glyphs, wide/combining cells, and DPR.
12. Resize has distinct local, runtime, host, and presented generations; stale
    completions may parse but may not replace newer visible geometry.

## Existing evidence and baseline

- `packages/ghostty-react/src/surface.ts` owns the DOM, Canvas 2D context,
  `GhosttyTerminalCore`, input, selection, scrolling, and frame scheduling.
- `packages/ghostty-react/src/renderer.ts` paints dirty rows with Canvas 2D
  `fillRect`, `fillText`, and `strokeRect` calls.
- `packages/ghostty-core/src/core.ts` reads Ghostty render state into mutable JS
  row/cell objects and reuses those objects across snapshots.
- `packages/yaade-ui/src/panels/terminal-output-writer.ts` already separates
  interactive microtask flushes from flood-mode animation-frame flushes and
  preserves replay acknowledgement semantics.
- `tests/bench/terminal-throughput.bench.ts` already covers stream throughput,
  TUI-like floods, idle typing, and typing during floods.
- At plan creation, relevant renderer files had uncommitted optimization work.
  Executors must not reset or overwrite it; first run `git status --short` and
  reconcile the live implementation with each plan's current-state notes.
- The 2026-08-30 resize recording shows blank terminal intervals, title fallback
  from the running TUI to the shell, responsive mobile controls appearing,
  intermediate `102×20` and `69×11` grids, and delayed partial TUI redraws.
- `use-mobile.ts` uses a 767 px CSS media query and `TerminalMultiplexer.tsx`
  replaces the desktop tree with `MobileTerminalView`; browser zoom can cross
  that breakpoint and remount `TerminalPanel`.
- Pane zoom in `TerminalTilingWorkspace.tsx` also replaces `PanelDockInDnd` with
  a separately rendered leaf, which remounts the terminal component.
- WebGL is a custom YAADE renderer over Ghostty terminal state, not Ghostty's
  native renderer. It currently caches whole changing row runs, uses
  `preserveDrawingBuffer: true`, and turns atlas rebuilds into recovery errors.
- The current backend E2E proves equal retained text and non-empty pixels, not
  Canvas/WebGL visual parity. WebGL currently collapses underline styles and
  omits Canvas's block-cursor glyph inversion and fractional-DPR edge snapping.
- Current stream and typing-under-flood benchmarks can finish before the relevant
  output is presented, so Plans 007–012 use a presented-frame endpoint.

## Global verification gates

Run after every plan unless the plan specifies a narrower intermediate command:

```bash
vp test packages/ghostty-core packages/ghostty-react packages/yaade-ui
vp run typecheck
vp run lint
vp exec playwright test --project=web-e2e tests/web/e2e/terminal-compatibility.web.spec.ts tests/web/e2e/terminal-multiplexer.web.spec.ts
vp run test:bench
```

Expected: all functional commands exit 0. Benchmark results must be recorded and
must satisfy `tests/bench/budgets.json`; compare medians and p95/p99 against the
pre-plan baseline rather than merely passing the existing ceilings.

## Explicitly rejected approaches

- **Replacing Ghostty with xterm.js:** xterm's renderer is not a clean adapter
  over Ghostty state and would replace the parser/compatibility authority.
- **Making WebGPU the only backend:** Tauri uses system WebViews, while YAADE's
  macOS minimum is 11. WebGPU availability is not universal across supported
  clients.
- **Removing Canvas after WebGL ships:** Canvas is needed for compatibility,
  recovery, tests, and differential rendering checks.
- **A desktop-only native renderer:** this would fork browser and desktop
  behavior and violate the shared-client architecture.
- **Treating WebGL/WebGPU alone as the native-Ghostty solution:** the parser/state
  authority is shared, but YAADE still owns custom CPU preparation, glyph
  rasterization, GPU batching, browser compositing, and lifecycle behavior.
- **Debouncing resize until interaction end:** this hides work by making the TUI
  stale. Plan 012 instead commits at most once per frame and guarantees the final
  host grid.
- **Using `preserveDrawingBuffer` as the capture/testing strategy:** it burdens
  every production frame. Plan 010 uses a retained scene and test-only capture.
- **Moving Canvas/WebGL to OffscreenCanvas before measurement:** deferred. Plans
  004/005 remove parser contention first; Plan 007 must show remaining renderer
  submission work before another worker/canvas failure domain is justified.
