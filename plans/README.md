# Terminal Rendering Implementation Plans

Generated on 2026-08-30 at commit `717ed49f`. These plans modernize the shared
browser/Tauri terminal renderer without creating a desktop-only implementation.
Execute them in the order below. Each executor must read its plan fully, preserve
pre-existing working-tree changes, honor STOP conditions, and update its status.

## Execution order and status

| Plan | Title | Maps to proposal item | Priority | Effort | Depends on | Status |
|---|---|---:|---|---|---|---|
| [001](001-terminal-render-frame-seam.md) | Introduce a packed render-frame seam | 3 | P1 | L | — | DONE |
| [002](002-webgl2-terminal-renderer.md) | Add WebGL2 as the preferred renderer | 1 | P1 | L | 001 | DONE |
| [003](003-terminal-renderer-recovery.md) | Make renderer failure and recovery explicit | 6 | P1 | M | 002 | DONE |
| [004](004-worker-terminal-runtime.md) | Move Ghostty parsing off the main thread | 2 | P2 | L | 001, 003 | TODO |
| [005](005-terminal-frame-scheduler.md) | Unify scheduling and end-to-end backpressure | 5 | P2 | L | 004 | TODO |
| [006](006-webgpu-terminal-experiment.md) | Add a gated experimental WebGPU adapter | 4 | P3 | L | 002, 003, 005 | TODO |

Status values: `TODO`, `IN PROGRESS`, `DONE`, `BLOCKED (<reason>)`, or
`REJECTED (<reason>)`.

Plan 002 result: WebGL2 is the `auto` default after a capability self-test,
with Canvas fallback and recovery. After batching same-style text into atlas
runs, three Apple M4 runs measured stream medians of 271.5/283.0/266.5 ms,
flood medians of 77.6/76.4/76.6 ms, idle typing medians of 11.7 ms, and
under-flood typing medians of 8.7/8.4/11.9 ms. WebGL is the default by explicit
operator direction; no benchmark budget was loosened.

## Dependency notes

- **001 before 002:** WebGL2 must consume a renderer-neutral packed update, not
  couple directly to `GhosttySnapshot` or duplicate Canvas traversal logic.
- **003 before 004:** context-loss and adapter replacement need to work before a
  worker introduces another failure domain.
- **004 before 005:** scheduling ownership can only be finalized after the
  parser's thread and message acknowledgement points are known.
- **006 last:** WebGPU is an optional adapter and must reuse the proven frame,
  fallback, recovery, scheduler, and benchmark contracts.

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
