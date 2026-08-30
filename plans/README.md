# Terminal Rendering Implementation Plans

Generated on 2026-08-30 at commit `717ed49f`, extended after the resize/TUI
audit at commit `f21fcdf4`, extended with close-latency Plan 013 against
`4341fd51`, incremental-submission Plan 014 at `7276f526`, and Ghostty
performance Plans 015–021 at `7276f526`. These plans modernize the shared
browser/Tauri terminal and its host lifecycle without creating a desktop-only
implementation. Execute them
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
| [013](013-immediate-terminal-window-close.md) | Make terminal and Window close feedback immediate and bounded | — | P1 | L | 007, 008 | TODO |
| [014](014-incremental-webgl-scene-submission.md) | Make retained WebGL scene submission incremental | — | P1 | L | 007, 009, 010, 011 | TODO |
| [015](015-byte-native-terminal-stream.md) | Keep terminal output byte-native from PTY read to Ghostty WASM | SolPro P0-1 | P1 | L | — | TODO |
| [016](016-recyclable-render-buffer-ring.md) | Recycle a bounded three-slot render-update buffer ring | SolPro P0-2 | P1 | M | 015 | TODO |
| [017](017-isolated-socket-writer-and-terminal-fanout.md) | Isolate socket writing and fan out output only to attached clients | SolPro P0-4/5 | P1 | L | 015 | TODO |
| [018](018-asynchronous-binary-terminal-history.md) | Move terminal history behind a bounded asynchronous binary pipeline | SolPro P0-6 | P1 | L | 013, 015 | TODO |
| [019](019-owned-terminal-runtime-mailboxes.md) | Give each terminal one state/control owner with bounded mailboxes | SolPro P0-3 | P1 | L | 012, 015, 017, 018 | TODO |
| [020](020-native-libghostty-vt-server-state.md) | Make native libghostty-vt the server terminal-state authority | SolPro P1-7/8 | P2 | L | 019 | TODO |
| [021](021-terminal-worker-scheduling-and-build-budgets.md) | Suppress unnecessary worker frames and make terminal builds measurable | SolPro P1-9/10 + build/bench | P2 | L | 014, 015, 016 | TODO |

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

Plan 013 addresses the next observed interaction bottleneck outside rendering:
terminal and Window close currently wait on serial host teardown, full-state
persistence, and synchronous history finalization. It adds immediate local
feedback while preserving explicit-close process termination and authoritative
revision ordering.

Plan 014 turns the retained WebGL scene into an actually incremental submission
path. Cursor-only frames perform no terminal-scene transfer, stable-topology
row updates patch exact GPU ranges, and topology/barrier changes retain a
bounded full-compaction fallback.

Plans 015–021 turn the SolPro Ghostty comparison into executable ownership and
measurement work. They remove terminal-text round trips, return transferred
render buffers, activate isolated socket mailboxes and attached-only fan-out,
move durable history off the PTY path, give each terminal an actor owner, adopt
the same pinned libghostty-vt revision on the server, and suppress hidden/
synchronized worker frame preparation while verifying build choices.

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
- **012 after renderer/residency work:** resize coordination relies on stable
  residency, cheap full-scene composition, packed model application, and
  presented-frame measurement.
- **013 after 007/008:** close latency needs trustworthy next-paint measurement
  and the resident-session lifecycle seam so optimistic placement removal never
  becomes PTY disposal by accident.
- **014 after 010/011:** incremental GPU ranges depend on the retained row scene
  and packed lazy viewport. Plan 009 remains the semantic guard; Plan 007 owns
  presented-frame measurement.
- **015 before 016/017/018/019:** byte ownership must be explicit before worker
  transfer recycling, socket fan-out, history ownership, or terminal actors
  remove their current string-shaped seams.
- **016 after 015:** both change the worker protocol; finish byte commands first,
  then add render-buffer return without restoring string writes.
- **017 after 015:** attached-only subscribers share one immutable byte frame;
  the active socket mailbox must not encode terminal strings again.
- **018 after 013/015:** Plan 013 establishes kill-before-history close and a
  close-finalization seam; Plan 015 establishes exact binary records. Plan 018
  deepens both into the full asynchronous ingest/compression/index pipeline.
- **019 after 017/018:** a terminal actor can publish nonblocking to isolated
  subscribers and enqueue history without retaining socket or disk work.
- **020 after 019:** native Ghostty handles are thread-confined to the terminal
  owner rather than put behind another shared parser mutex.
- **021 after 014/015/016:** hidden/synchronized suppression relies on byte
  commands, recyclable render slots, and the final retained-renderer counters.

## Recommended execution waves

1. Run Plans 007 and 009; they can proceed in parallel after the completed
   worker/scheduler work and removed WebGPU experiment settle in the working tree.
2. Run Plans 008 and 010; they touch different ownership layers but coordinate
   through Plan 007 lifecycle/frame IDs.
3. Run Plan 011.
4. Run Plan 012 and re-run all resize, multiplexer, compatibility, and benchmark
   suites as the renderer/resize integration gate.
5. Run Plan 013 independently of further renderer experiments; it touches the
   mux control plane, PTY teardown, persistence, and history finalization.
6. Run Plan 014 against the stabilized Plan 010/011 renderer. It has no code
   dependency on Plan 013, but execute serially in one working tree because both
   update the plan index and benchmark evidence.
7. Run Plan 015 first among the Ghostty review work.
8. After 015, run Plans 016 and 017 in parallel only in isolated worktrees; one
   is browser-worker ownership and the other server transport/fan-out.
9. After Plan 013 and 015, run Plan 018. Then run Plan 019 after both 017 and 018.
10. Run Plan 020 after the terminal actor owns parser state. It requires green
    Linux, macOS, and Windows ABI/build jobs before completion.
11. Run Plan 021 after Plans 014–016. It may proceed in parallel with server-only
    Plans 017–020 in isolated worktrees, but serialize changes to shared docs,
    CI, benchmarks, and the plan index.

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
13. Explicit close removes local placement immediately but is complete only
    after the host has accepted PTY termination and committed authoritative mux
    state; history IO may not delay or prevent process termination.
14. WebGL dirty rows govern CPU scene rebuilding and GPU buffer transfer, while
    every present still clears and draws the complete GPU-resident scene; no
    optimization may depend on preserved default-framebuffer pixels.
15. Terminal output is opaque ordered bytes through generic transport, replay,
    history, scheduling, and worker seams; only protocol parsers decode text.
16. A transferred render buffer has exactly one owner and returns through one of
    three bounded worker slots; parsing never waits for slot return.
17. Each WebSocket has one sink owner and bounded reliable/raw/semantic lanes;
    raw output overflow uses replay recovery, never latest-wins replacement.
18. Terminal output fan-out considers only attached subscribers and shares one
    immutable payload allocation across them.
19. History queues, staging, compression, and indexes are byte-bounded and
    non-lossy; accepted work has explicit written/durable shutdown barriers.
20. The blocking PTY reader only reads and submits bytes; one terminal owner
    owns mutable PTY/parser/control state and guarantees final resize/lifecycle.
21. Native and WASM Ghostty builds use one exact revision. Private Ghostty memory
    is never a YAADE persistence or wire format.
22. Hidden/synchronized terminals continue parsing and ACKing while frame
    extraction is suppressed; safety timeout and show emit bounded catch-up.

## Existing evidence and baseline

- `packages/ghostty-react/src/surface.ts` owns DOM input/selection/scrolling and
  presentation, while a worker-backed runtime proxy owns the default Ghostty
  parser path.
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
  native renderer. It now retains row batches and uses a non-preserved default
  framebuffer, but every dirty frame concatenates all retained rows into global
  batches and uploads the complete scene. Even an empty dirty-row set currently
  marks the scene for re-upload, so cursor blink/focus-only frames repeat that work.
- A 2026-08-30 method probe at commit `4341fd51` confirmed the static cost: an
  idle focused 180×44 terminal uploaded two 163,176-byte retained scenes plus a
  32-byte cursor in 1.25 seconds. Ten one-row updates coalesced into five
  presents, but each still uploaded a 170,612–171,132-byte complete scene
  (855,140 scene bytes total). Codify this probe before changing submission.
- A dirty row allocates three fresh typed-array batches. Row construction also
  creates per-cell color tuples and empty underline arrays, despite Plan 010's
  allocation target. WebGL counters do not expose scene-copy/upload bytes through
  the lifecycle/test bridge, so the existing benchmark cannot attribute this cost.
- Worker packed updates are validated once in `protocol.ts` and again in
  `GhosttyViewportModel.apply()`. Transferring the builder buffers detaches them,
  but `releaseRenderUpdate()` does not recycle them to the worker, so default
  worker frames allocate fresh transfer storage. Ghostty extraction still builds
  compatibility cells before UTF-8 repacking.
- The Rust PTY path decodes reads to `String`, clones text into replay, emits
  terminal bytes through `HostEvent.args`, and writes gzip-compressed JSON
  history under one archive-state mutex. Browser framing then decodes the raw
  payload to a string before the worker encodes it for Ghostty again.
- The active socket loop awaits outbound sends in the same `tokio::select!` that
  reads commands, even though `outbound_mailbox.rs` already models bounded
  reliable/raw/semantic lanes. Every socket subscribes to the global terminal
  broadcast and filters attachment locally.
- `TerminalEntry` shares writer, master, child, and state through mutexes while
  the reader performs replay/scanning/parsing/checkpoint/history/event work.
  The server still depends on `vt100`; browser WASM uses pinned libghostty-vt.
- Surface-level hidden and DEC 2026 suppression happens after the worker has
  already built/transferred updates. The WASM build is fixed to `ReleaseSmall`
  and CI does not assert SIMD instructions in the shipped artifact.
- Resident hidden surfaces keep their WebGL contexts and per-terminal atlases;
  there is no document-wide context/atlas budget or hidden-runtime update
  suppression. Atlas capacity pressure resets the whole atlas and retained scene.
- The current backend E2E proves equal retained text, dimensions, and coarse
  non-background pixel counts, not same-machine structural pixel parity.
- Presented-frame clocks now gate terminal benchmarks, but the dashboard case
  reports only total command duration and renderer generation. WebGL scene-copy,
  instance-upload, atlas, model-apply, and per-frame distributions are not yet
  available through the test bridge.

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
- **Persisting Ghostty page memory as a checkpoint:** rejected. The pinned C ABI
  exposes render traversal but no public versioned parser-state restore. Plan 020
  must not persist private pages, pointers, offsets, or allocator state.
- **Treating a compact render snapshot as restorable terminal state:** rejected
  until libghostty-vt exposes matching public export/import or YAADE chooses a
  different terminal-state authority. The current synthetic bootstrap remains a
  documented transitional compatibility path during Plan 020.
