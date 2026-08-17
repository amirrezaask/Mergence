# Plan 002: Finish, harden, and optimize the WebGL2 Neovim client for production use

> **Executor instructions**: Read this plan fully before editing. Follow it in
> order and run every verification gate before continuing. Preserve all
> unrelated working-tree changes. Do not commit, push, or open a PR unless the
> operator explicitly asks. If a STOP condition occurs, stop and report it; do
> not weaken protocol validation, remove bounds, add a Canvas fallback, or
> optimize without measurements.
>
> **Drift check (run first)**:
>
> ```sh
> git diff --stat 832539c..HEAD -- \
>   apps/host-server/src/neovim apps/host-server/src/tools/neovim-driver.ts \
>   apps/host-server/src/tools/service.test.ts apps/host-server/mocks/mock-neovim-server.mjs \
>   packages/yaade-ui/src/panels/neovim packages/yaade-ui/package.json \
>   packages/yaade-app/src/agent-bridge.ts packages/yaade-app/src/tools/ToolSessionApp.tsx \
>   packages/yaade-app/src/tools/renderers/NeovimToolView.tsx \
>   packages/yaade-app/src/tools/renderers/SearchToolView.tsx \
>   tests/electron/neovim-tool.electron.spec.ts tests/bench/neovim-render.bench.ts \
>   tests/bench/budgets.json .github/workflows/ci.yml README.md AGENTS.md packages/yaade-ui/AGENTS.md
> git diff --stat -- \
>   apps/host-server/src/neovim apps/host-server/src/tools/neovim-driver.ts \
>   apps/host-server/src/tools/service.test.ts apps/host-server/mocks/mock-neovim-server.mjs \
>   packages/yaade-ui/src/panels/neovim packages/yaade-ui/package.json \
>   packages/yaade-app/src/agent-bridge.ts packages/yaade-app/src/tools/ToolSessionApp.tsx \
>   packages/yaade-app/src/tools/renderers/NeovimToolView.tsx \
>   packages/yaade-app/src/tools/renderers/SearchToolView.tsx \
>   tests/electron/neovim-tool.electron.spec.ts tests/bench/neovim-render.bench.ts \
>   tests/bench/budgets.json .github/workflows/ci.yml README.md AGENTS.md packages/yaade-ui/AGENTS.md
> ```
>
> This plan was written against commit `832539c` plus the uncommitted Plan 001
> Neovim implementation and unrelated liquid-material/Session-shell work. The
> Neovim files are not committed at the planned-at SHA, so the second command is
> mandatory. Do not reset, stash, rewrite, or reformat unrelated changes. If the
> live Neovim implementation differs materially from the excerpts below, stop
> and refresh this plan before coding.

## Status

- **Priority**: P1
- **Effort**: XL (land as measured vertical slices)
- **Risk**: HIGH — the work touches an untrusted binary protocol, browser input,
  process/socket lifetime, typography, and GPU resource ownership
- **Depends on**: the Plan 001 baseline already present in the working tree;
  Plan 001 itself is superseded and must not be re-executed
- **Category**: correctness / performance / tests / production hardening
- **Status**: TODO
- **Planned at**: commit `832539c`, 2026-08-16, plus the uncommitted baseline
  described above

## Goal

Turn the current proof-complete standalone Neovim ToolUse into a production-grade
browser GUI client that is correct with real Neovim 0.10+, remains responsive
under sustained redraw/input load, and has bounded CPU, GPU, host, and browser
memory over long sessions.

The target remains deliberately narrow:

```text
Neovim process (one per ToolUse)
  -> bounded raw Msgpack-RPC WebSocket lease
  -> validated ext_linegrid transaction reducer
  -> compact retained cell packets
  -> four WebGL2 instanced passes
  -> one browser canvas + hidden native input surface
```

“Fully working” for this plan means the normal single-grid Neovim experience is
reliable: user config/plugins render through Neovim's own grid, Unicode and wide
text are correct, keyboard/IME/mouse/clipboard/focus work, Search opens files
safely, reconnects do not replace the process, crashes and unsupported browsers
have actionable recovery, and real end-to-end latency/memory gates pass. It does
**not** mean externalizing Neovim's command line, popup menu, messages, tabline,
or windows; those continue to render into grid 1 with `ext_multigrid=false`.

## Non-negotiable outcomes

1. Keep exactly one host Neovim process per live Neovim ToolUse. React and
   browser reconnects only acquire UI leases.
2. Keep the final renderer WebGL2. Canvas/OffscreenCanvas may rasterize glyphs,
   but there is no Canvas 2D display fallback.
3. Keep redraw/editor text outside React state, SQLite, EventHub, and generic
   JSON transport.
4. Validate external Msgpack/API/redraw values and keep every queue, cache,
   grid, atlas, process diagnostic, timer, and registry bounded.
5. Preserve `Mod-k`, shell command interception, bare Escape, Vim mappings,
   AltGraph/macOS Option text, IME, paste, visual copy, mouse, and Search reuse.
6. Use one authoritative line-grid model and `flush` as the transaction boundary.
   Multiple flushes before one animation frame may coalesce without losing dirty
   rows, cursor state, or visual-bell transitions.
7. Remove `preserveDrawingBuffer`; correctness must not depend on retaining an
   old default framebuffer between browser composites.
8. Move semantic highlight resolution, CSS color parsing, font-string assembly,
   and glyph canvas creation out of the per-cell redraw loop.
9. Render with a fixed small number of instanced draws. No per-cell/per-glyph
   draw calls, DOM nodes, React updates, or unbounded animation loop.
10. Measure true input-to-next-paint latency, protocol/reducer CPU, packet-build
    CPU, atlas raster/upload CPU, bytes uploaded, draw calls, optional GPU time,
    resource bytes, reconnects, and idle frames. Do not label renderer CPU time
    as end-to-end latency.
11. Verify against the deterministic mock and pinned real Neovim compatibility
    runs. A mock-only client is not complete.
12. Preserve the current YAADE semantic theme/material/motion system and the
    user's Neovim configuration; do not inject a colorscheme or replace config.

## Why this matters

Plan 001 established the correct product architecture and a functioning vertical
slice. The remaining work is concentrated in the places where a demo can look
finished while a daily-driver editor is not: reconnect races, international
input, real protocol drift, framebuffer correctness, glyph clipping, hot-path
allocation, oversized GPU allocations, and benchmarks that measure the wrong
interval.

The current implementation already reports roughly 406 ms to first frame, about
0.3 ms renderer CPU for a small input repaint, and about 6.7 ms renderer CPU for
a 10k-cell redraw on the development machine. Those are useful observations,
not yet production claims: input-to-paint currently reports only
`lastFrameCpuMs`, first-frame has one sample, GPU/memory are not measured, and
real Neovim is only a manual smoke test.

## Current state and confirmed gaps

### Baseline that must be preserved

- `apps/host-server/src/neovim/host.ts` owns one process per ToolUse, private
  endpoints, bounded stderr, generations, UI lease supersession, and shutdown.
- `apps/host-server/src/neovim/ws-proxy.ts` is a dedicated binary-only bridge
  with a 2 MiB bound in both directions. Redraw bytes do not enter EventHub.
- `packages/yaade-ui/src/panels/neovim/line-grid.ts` uses typed arrays for hot
  cells and cold maps for glyph/highlight metadata.
- `packages/yaade-ui/src/panels/neovim/webgl-renderer.ts` has background, glyph,
  decoration, and cursor instanced passes.
- `packages/yaade-ui/src/panels/neovim/surface.ts` owns the imperative browser
  lifecycle, hidden textarea, RPC, input, ResizeObserver, theme/font updates,
  context restore, and reconnect.
- `packages/yaade-app/src/tools/renderers/NeovimToolView.tsx` is a thin React
  status/lifecycle adapter; high-frequency editor data stays outside React.
- Search already creates/reuses a matching-checkout standalone Neovim ToolUse.

### Baseline verification must first be made truthful

`apps/host-server/src/tools/service.test.ts` now verifies context restart but
compares a non-canonical macOS temporary path against the canonical cwd:

```ts
const secondProject = host.runtime.db.addProject(secondRoot)
// ... context restart ...
assert.equal(host.runtime.neovim.get(created.id)?.cwd, secondRoot)
```

On macOS the actual cwd begins with `/private/var/...` while `secondRoot` begins
with `/var/...`. The implementation restarted in the right directory; the test
must compare canonical paths. This currently leaves `pnpm test` with one known
failure.

`pnpm validate:keybindings` is not currently a meaningful Neovim gate: the
legacy validator reads the removed
`packages/yaade-workspace/data/jet-vscode-command-map.json`. The active Tool
Session catalog and keymap tests are the authoritative Neovim shortcut checks.
Do not recreate a stale VS Code map merely to make this feature green.

### The current renderer's partial-frame contract is costly and fragile

At `packages/yaade-ui/src/panels/neovim/webgl-renderer.ts:391`:

```ts
canvas.getContext("webgl2", {
  alpha: false,
  antialias: false,
  preserveDrawingBuffer: true,
})
```

Dirty cells are compacted into the start of CPU instance arrays, uploaded from
byte zero, and only those instances are drawn. This requires preserved old
pixels. It also repeatedly blends transparent highlight backgrounds over prior
pixels, can accumulate color error, and uses a path that browsers commonly
optimize less aggressively.

The hot loop at `webgl-renderer.ts:644-715` resolves highlight regexes and CSS
colors, assembles font strings, builds atlas string keys, and allocates color
arrays per dirty cell. `ensureData()` also reallocates the tiny cursor GPU buffer
on every render, `entriesInUse()` creates an array every frame, and `gl.flush()`
is unconditional.

The default atlas reserves up to four 2048x2048 R8 layers per surface (up to
16 MiB GPU memory before cell buffers), creates a new canvas for every uncached
glyph, and keeps every uploaded glyph bitmap in CPU memory. Four or six Neovim
surfaces multiply that cost.

### The model allocates at each protocol flush and has unbounded interning

At `packages/yaade-ui/src/panels/neovim/line-grid.ts:418-438`, every `flush`
creates a `GridFrame` and copies `dirtyRows`, even though `surface.ts` only checks
whether a flush happened and then pulls a fresh frame during rAF:

```ts
private makeFrame(consumeDirty: boolean): GridFrame {
  const dirtyRows = this.dirtyRows.slice()
  // ...
}
```

`decodeRedrawEvents()` also allocates an event object and sliced argument array
for every grouped redraw call. Glyph strings are interned until a clear/resize;
a long editing session that continually sees new clusters can grow the map even
when those glyphs are no longer visible. The 2,000,000-cell protocol cap can
force hundreds of MiB of CPU/GPU buffers, far beyond a plausible browser pane.

### Connection and input correctness still need production hardening

- `surface.ts` uses a fixed 350 ms reconnect timer without a connection epoch.
  A generation update can overlap a pending reconnect or a stale asynchronous
  attach and allow old work to update new connection state.
- The client does not call `nvim_ui_set_focus`, so FocusGained/FocusLost behavior
  and plugins do not receive proper GUI focus state.
- Printable Ctrl+Alt/AltGraph and macOS Option text need explicit handling to
  avoid keydown/input duplication or turning international text into an Alt
  mapping.
- Visual-selection copy errors are swallowed, and its exact range semantics have
  not been tested against real Neovim characterwise/linewise/blockwise modes.
- Wheel handling sends one vertical step per DOM event and ignores horizontal
  deltas and trackpad magnitude.
- `openLocation()` forwards a Search column as a Neovim byte column without a
  documented conversion contract. Non-ASCII lines can land at the wrong byte.
- The status UI merges WebGL unavailability, protocol incompatibility, process
  failure, and temporary connection loss into one message and always offers
  “Restart Neovim,” even when restarting the process cannot fix the problem.

### Existing benchmarks do not prove the stated metrics

At `tests/bench/neovim-render.bench.ts:99-109`, the benchmark timestamps input
but returns `lastFrameCpuMs` whenever diagnostics exist:

```ts
const started = Date.now()
await dispatchInput(page, toolUseId, "z")
await waitForPaint(page, toolUseId, before)
return page.evaluate(
  id => window.__yaadeAgent!.getNeovimDiagnostics(id)?.lastFrameCpuMs
    ?? Date.now() - started,
  toolUseId,
)
```

That is renderer CPU, not input-to-paint. First-frame uses one measured sample,
the 10k test also returns only renderer CPU, and there are no dirty-row,
scroll/flood, idle-frame, multi-surface, GPU-time, allocation, or memory-plateau
gates. The current context-loss E2E dispatches synthetic DOM events rather than
using `WEBGL_lose_context`, so it does not prove real GPU resource restoration.

## Target data flow and renderer shape

### Protocol/reducer

```text
WebSocket binary chunks
  -> bounded streaming Msgpack decoder
  -> validate redraw groups in-place
  -> mutate typed line-grid arrays
  -> flush result: counters/flags only, no frame copy
  -> one pending rAF consumes dirty row runs
```

`LineGridModel.apply()` should return a compact result such as flush count,
visual-bell generation, and state-change flags. It must not allocate a full
frame descriptor or copy dirty rows for each flush. The renderer consumes the
model's dirty rows once, after all flushes coalesced into that browser frame.

Keep hot cell state compact and contiguous. Keep strings, highlight metadata,
mode metadata, diagnostics, and protocol errors in cold side tables. Bound the
grid by an explicit renderer byte budget, not a permissive cell count that can
allocate hundreds of MiB.

### GPU packet layout

Implement and benchmark a fixed-slot, GPU-retained cell packet. The preferred
shape is one interleaved 24-32 byte record per visible cell:

```text
cell index (implicit through gl_InstanceID)
  background RGBA8
  foreground RGBA8
  special RGBA8
  atlas x/y/w/h as packed unsigned values
  atlas layer + cell span
  decoration flags/parameters
```

The vertex shader derives row/column from `gl_InstanceID` and a `uGridWidth`
uniform. Dirty contiguous row runs update their exact byte ranges with
`bufferSubData`; unchanged cells stay resident. Each flush clears the default
framebuffer and draws the full visible grid in the existing fixed passes. Cursor
blink/focus changes redraw from retained GPU packets without rebuilding or
uploading cell data.

Before replacing the current path, benchmark this fixed-slot design against a
minimal full-grid Float32 prototype. Keep the packed path only if it wins or
materially reduces memory without violating readability. Regardless of packet
format, `preserveDrawingBuffer` must be false and partial pixel retention must
not be the correctness mechanism.

### Style cache

Resolve each Neovim highlight id into a packed style once when:

- `hl_attr_define` changes that id;
- default colors change;
- YAADE theme changes; or
- font metrics/style generation changes.

Per-cell packet updates should perform an id lookup and numeric writes only. No
regex, `toSrgbColor`, CSS parsing, font-string construction, or color-array
allocation belongs in the cell loop.

### Atlas lifetime

Use one reusable raster canvas/context per surface. Measure glyph bounds and
bearings so italic overhangs, combining marks, Nerd Font symbols, and wide glyphs
are not clipped. Keep a bounded pending-upload queue; release CPU bitmaps after
`texSubImage3D`. Size atlas storage from measured glyph dimensions and an
explicit per-surface GPU budget rather than always allocating the maximum four
layers. Atlas clear/rebuild must repopulate all visible glyph packets before the
next draw.

## Performance budgets

Record hardware, OS, Chromium version/channel, DPR, viewport, Neovim version,
font, theme, build mode, and commit in benchmark output. Budgets apply to a
production frontend build after warmup on the repository's CI class; alert at
80% in local reports.

| Budget | Median | p95 | p99 | Notes |
| --- | ---: | ---: | ---: | --- |
| Host start request -> socket ready | 150 ms | 250 ms | 400 ms | mock and real separately |
| Tool create -> first painted real grid | 300 ms | 500 ms | 750 ms | at least 10 samples, cold/warm labeled |
| DOM input event -> next Neovim paint | 12 ms | 24 ms | 40 ms | true elapsed interval, not renderer CPU |
| Input -> paint during 100k-cell/s redraw flood | 24 ms | 40 ms | 64 ms | no lost/duplicated input |
| 10k-cell protocol+reduce+packet+submit CPU | 8 ms | 16 ms | 24 ms | stage timings also reported |
| 1k dirty cells packet upload CPU | 2 ms | 4 ms | 8 ms | contiguous and disjoint row fixtures |
| Scroll next paint | 12 ms | 20 ms | 32 ms | 200x80 grid |
| Warm theme repaint | 16 ms | 32 ms | 50 ms | no process restart |

Resource budgets for a 200x80 grid at DPR 2:

- Cell-model + CPU packet capacity: <= 2 MiB per surface.
- Estimated GPU cell buffers: <= 2 MiB per surface.
- Glyph atlas allocation: target <= 8 MiB per surface; hard cap 16 MiB only for
  high-DPR/large-font cases with diagnostics explaining the choice.
- CPU-resident pending glyph bitmaps: <= 2 MiB and return near zero after upload.
- Draw calls: <= 4 for a normal frame, plus at most one documented auxiliary
  pass if profiling proves it necessary.
- Idle hidden/blurred surface: zero scheduled frames over 2 seconds.
- Focused blinking surface: only cursor-mode blink frames, no perpetual rAF.
- Fifty mount/connect/disconnect cycles: zero host processes/endpoints after
  close and <= 10 MiB retained browser-heap delta after forced GC in the test
  environment.
- Four visible 200x80 surfaces: no WebGL context eviction and aggregate resource
  estimate stays within the declared per-surface caps.

If CI variance makes a threshold unstable, improve fixture isolation and sample
count before loosening the threshold. Do not replace p95/p99 with averages.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Host focused tests | `pnpm --filter @yaade/host-server test` | all pass; no child/socket leaks |
| UI focused tests | `pnpm --filter @yaade/ui test` | all Neovim protocol/input/atlas/renderer tests pass |
| App keymap/routing tests | `pnpm --filter @yaade/app test` | active Tool Session keymap and Search routing pass |
| Typecheck | `pnpm -r typecheck` | exit 0, no errors |
| Scoped lint | `pnpm exec oxlint apps/host-server/src/neovim apps/host-server/src/tools/neovim-driver.ts packages/yaade-ui/src/panels/neovim packages/yaade-app/src/tools/renderers/NeovimToolView.tsx tests/electron/neovim-tool.electron.spec.ts tests/bench/neovim-render.bench.ts --deny-warnings` | exit 0 |
| Neovim E2E | `pnpm exec playwright test --project=web-e2e tests/electron/neovim-tool.electron.spec.ts` | all scenarios pass, no skips |
| Neovim bench | `pnpm exec playwright test --project=bench tests/bench/neovim-render.bench.ts` | all budgets pass with sample output |
| Full unit suite | `pnpm test` | exit 0 |
| Build | `pnpm build` | SPA and server build exit 0 |
| Full E2E regression | `pnpm test:e2e` | exit 0, or exact pre-existing non-Neovim failure recorded separately before this plan starts |
| Diff hygiene | `git diff --check && git status --short` | no whitespace errors; only intentional files plus preserved pre-existing work |

Unit tests use `node:test` through `tsx`, not Vitest. Add new test files to the
explicit package test scripts. `launchWeb()` serves `apps/yaade/dist`, so run
`pnpm --filter yaade build` immediately before every recorded browser benchmark
to prevent stale frontend JavaScript from invalidating measurements. Keep
`Effect.runPromise` at existing host boundaries and use existing Effect driver
conventions; do not create a new runtime or introduce unsafe `any`, casts,
`@ts-ignore`, or `namespace`.

`pnpm validate:keybindings` remains a known stale legacy command until its
separate workspace-map cleanup is done. For this plan, the authoritative gate is
`@yaade/app`'s active Tool Session keymap test. Do not modify legacy Mission
Control or reconstruct the deleted command-map data in this plan.

## Suggested executor toolkit

- Use `effect-ts` for host resource lifetime, interruption, and typed driver
  failures. The vendored Effect source exists at `./.repos/effect`.
- Use the TypeScript/React performance guidance for allocation, bounded memory,
  imperative surface ownership, and narrow React invalidation.
- Use GPU performance guidance for retained buffers, dirty-range uploads,
  instancing, timer queries, and release-mode measurement.
- Read installed Neovim help before protocol/input changes: `:h ui`,
  `:h api-ui-events`, `:h ui-linegrid`, `:h msgpack-rpc`,
  `:h nvim_ui_attach()`, `:h nvim_ui_set_focus()`, `:h nvim_input()`,
  `:h nvim_paste()`, and `:h nvim_input_mouse()`.
- Use Playwright runtime state/console/network assertions and real screenshot
  review for every visible change.

## Scope

### In scope

Primary production files:

- `apps/host-server/src/neovim/endpoint.ts`
- `apps/host-server/src/neovim/host.ts`
- `apps/host-server/src/neovim/ws-proxy.ts`
- sibling Neovim host tests and mock server
- `apps/host-server/src/tools/neovim-driver.ts`
- `apps/host-server/src/tools/service.test.ts` for lifecycle/context coverage
- `packages/yaade-ui/src/panels/neovim/{protocol,rpc,line-grid,input,atlas,webgl-renderer,surface,registry}.ts`
- sibling Neovim UI tests
- `packages/yaade-app/src/tools/renderers/NeovimToolView.tsx`
- `packages/yaade-app/src/agent-bridge.ts` only for bounded diagnostics/test hooks
- `tests/electron/neovim-tool.electron.spec.ts`
- `tests/bench/neovim-render.bench.ts`
- `tests/bench/budgets.json`
- package test scripts only when new test files are added
- `.github/workflows/ci.yml` only for a pinned real-Neovim compatibility job
- `README.md`, `AGENTS.md`, and `packages/yaade-ui/AGENTS.md`
- `plans/002-production-webgl-neovim-client.md` and `plans/README.md`

Secondary app routing files may change only if a regression test proves a Search
location/focus bug in the current standalone workflow:

- `packages/yaade-app/src/tools/ToolSessionApp.tsx`
- `packages/yaade-app/src/tools/renderers/SearchToolView.tsx`

### Out of scope

- Rust, Cargo, Tauri, Electron, WebGPU, a native wrapper, or a browser extension.
- Canvas 2D as a final display renderer or fallback.
- Legacy `App.tsx`, project landing, or `MuxApp.tsx` compatibility surfaces.
- Re-enabling/deleting Monaco's disabled `editor` ToolKind.
- `ext_multigrid`, external popup menu/cmdline/messages/tabline, custom editor
  toolbar, minimap, semantic code model, or YAADE LSP integration.
- Replacing the user's Neovim config, colorscheme, clipboard provider, statusline,
  plugins, or keymaps.
- Host-restart survival through a new daemon.
- Multiple simultaneous browser controllers for one ToolUse.
- Remote authentication; keep the existing local-only security posture and
  origin gate.
- General repository lint cleanup, missing legacy VS Code command-map data, and
  unrelated legacy Session E2E migration.
- Optimizing other YAADE panes while touching shared code.

## Git workflow

- Work on the operator's current branch unless told otherwise.
- Preserve all pre-existing uncommitted Session-shell, appearance, liquid-glass,
  and plan changes.
- Do not commit unless explicitly asked.
- Before each step, inspect `git diff -- <step files>` so an optimization does
  not overwrite concurrent work.
- Keep measured architecture changes in reviewable slices: baseline/instrument,
  reducer, renderer packets, atlas, input/lifecycle, tests/docs.

## Implementation steps

### Step 1: Restore a truthful baseline and freeze compatibility contracts

1. Fix the macOS canonical-path assertion in
   `apps/host-server/src/tools/service.test.ts` by comparing the runtime cwd to
   the canonical path returned by the project catalog or `fs.realpathSync`.
   Keep the generation-3 and archive cleanup assertions.
2. Run the host, UI, app, full unit, focused E2E, and existing benchmark once.
   Save raw benchmark samples plus machine/browser details in the test artifact
   or plan execution notes; do not edit budgets yet.
3. Extend the mock protocol fixture to identify every input, paste, resize,
   focus, mouse, and location request deterministically without echoing arbitrary
   user content into logs.
4. Add a pinned real-Neovim compatibility harness for supported 0.10 and current
   stable API metadata. Prefer CI-downloaded official artifacts with checksum
   verification over the Ubuntu package if the package is below 0.10. The real
   harness must start with isolated test config (`--clean` or a dedicated test
   wrapper), attach linegrid, edit Unicode text, scroll, change mode, and exit.
   It must not read the operator's plugins/config.
5. Store compact checked test fixtures for API metadata/redraw sequences only
   when needed for deterministic reducer tests. Do not commit raw user buffers,
   socket paths, or machine-specific output.

**Verify**:

```sh
pnpm --filter @yaade/host-server test
pnpm --filter @yaade/ui test
pnpm --filter @yaade/app test
pnpm test
pnpm --filter yaade build
pnpm exec playwright test --project=web-e2e tests/electron/neovim-tool.electron.spec.ts
pnpm exec playwright test --project=bench tests/bench/neovim-render.bench.ts
```

Expected: all commands pass; host teardown leaves no mock child or socket; raw
baseline numbers are recorded without claims that renderer CPU is end-to-end
latency.

### Step 2: Make protocol reduction allocation-aware and strictly bounded

1. Replace per-flush `GridFrame`/`dirtyRows.slice()` creation with a compact
   `ApplyResult` and one renderer-side dirty-row consumption per rAF. Preserve
   every flush counter and visual-bell generation.
2. Decode grouped redraw calls without `rawEvent.slice(1)` and one object per
   sub-event. Keep explicit guards at the wire boundary and readable per-event
   reducer functions.
3. Coalesce dirty rows into contiguous runs. The reducer owns the dirty bitset;
   the renderer consumes/clears it only after packet writes succeed.
4. Replace the 2,000,000-cell limit with explicit dimension and byte budgets
   that cannot allocate more than the declared model/packet caps. Validate width,
   height, multiplication overflow, and decoder array limits consistently.
5. Bound glyph interning across long sessions. Use rare flush-time compaction:
   scan live cell glyph ids, rebuild/remap the table only after a threshold, and
   keep the common write path O(1). Do not add reference-count work to every
   scroll/copy unless profiling proves compaction inadequate.
6. Bound highlight metadata and mode tables. Protocol-fail with an actionable
   error before an untrusted stream can exhaust memory.
7. Replace `ChunkQueue.shift()` with a head-index/ring discipline so fragmented
   input does not repeatedly move arrays. Compact the queue only on a cold
   threshold.
8. Add diagnostics for decoded bytes/messages, flushes coalesced, dirty runs,
   model bytes, interning compactions, peak glyph/highlight counts, and rejected
   bounds.

**Tests** in `line-grid.test.ts`, `rpc.test.ts`, and `protocol.test.ts`:

- many flushes before one consume preserve the union of dirty rows;
- malformed resize cannot allocate;
- one redraw near each valid bound succeeds and one beyond fails before growth;
- 100k changing glyph clusters compact and plateau;
- scroll/copy after glyph compaction preserves text/flags/highlights;
- fragmented queue stress remains ordered and bounded;
- real 0.10/current redraw fixtures produce equivalent visible state.

**Verify**:

```sh
pnpm --filter @yaade/ui test
pnpm --filter @yaade/ui typecheck
pnpm exec oxlint packages/yaade-ui/src/panels/neovim/{protocol,rpc,line-grid}.ts packages/yaade-ui/src/panels/neovim/{rpc,line-grid}.test.ts --deny-warnings
```

Expected: tests pass; a protocol flush performs no dirty-row/full-frame copy;
long-session interning plateaus within the documented bound.

### Step 3: Add stage-level instrumentation before changing renderer architecture

1. Extend diagnostics with monotonic timings/counters for:
   - socket receive and queued bytes;
   - Msgpack decode;
   - redraw validation/reduction;
   - dirty packet build;
   - atlas raster and texture upload;
   - cell-buffer upload;
   - draw submission;
   - first mount/socket/API attach/redraw/paint milestones;
   - latest input event -> first subsequent painted flush;
   - CPU/GPU resource-byte estimates and peak values.
2. Use `performance.mark/measure` for cold milestones and fixed-size numeric
   accumulators/ring samples for hot events. Do not append unbounded arrays or
   format strings per frame.
3. Add optional `EXT_disjoint_timer_query_webgl2` timing with a small query ring.
   Never block or call `getQueryParameter` until availability reports true; mark
   GPU timing unavailable when the extension is absent.
4. Add a test-only imperative method that dispatches input inside the page and
   resolves after the correlated painted flush. The benchmark must not include
   Playwright round trips in the measured interval.
5. Count scheduled rAFs separately from rendered frames so idle behavior is
   observable.

**Verify**:

```sh
pnpm --filter @yaade/ui test
pnpm --filter @yaade/app test
pnpm exec playwright test --project=bench tests/bench/neovim-render.bench.ts
```

Expected: the benchmark prints each stage and true input-to-paint elapsed time;
all diagnostic sample buffers have fixed capacities.

### Step 4: Replace preserved pixels with retained packed cell packets

1. Build a minimal benchmark-only prototype comparing:
   - current compact dirty instances + preserved framebuffer;
   - full-grid retained Float32 instances + dirty-range uploads; and
   - the proposed 24-32 byte packed interleaved cell record.
2. Keep the simplest layout that meets the budgets. Prefer the packed fixed-slot
   record if it materially reduces upload/resource bytes without increasing
   packet-build CPU or obscuring invariants.
3. Compute cell position from `gl_InstanceID` and grid width. Keep the four
   existing passes and derive blank/continuation/decoration behavior from packed
   flags rather than compacting visible instances every frame.
4. Upload only contiguous dirty-row byte ranges at their stable GPU offsets.
   Draw the full grid from retained packets after clearing the framebuffer.
5. Create/grow cell buffers only on grid-capacity changes. Allocate the cursor
   buffer once; do not call `bufferData` for it per frame.
6. Remove `preserveDrawingBuffer: true`. Remove unconditional `gl.flush()` unless
   measurements on a named browser/hardware show a repeatable latency benefit.
7. Make cursor blink/focus redraw use existing GPU cell packets with zero cell
   rebuild/upload. A theme/font/atlas generation change is allowed to rebuild.
8. Pre-resolve every highlight into a packed style cache. Theme/default/highlight
   changes invalidate only the necessary style and dirty rows. The cell packet
   loop must contain no regex, CSS conversion, font-string assembly, or color
   array allocation.
9. Premultiply/compose Neovim `blend` against the authoritative background once
   per resolved style so repeated redraws cannot accumulate alpha error.
10. Preserve context-loss reconstruction from the authoritative model and style
    cache.

**Tests**:

- packet packing/unpacking and byte offsets;
- dirty contiguous/disjoint upload ranges;
- blank, continuation, wide, underline, strike, reverse, blend, and cursor flags;
- repeated redraw of a blended cell produces identical pixels/packets;
- cursor blink changes no cell upload counter;
- resize/theme/context restore performs the required full rebuild exactly once.

**Verify**:

```sh
pnpm --filter @yaade/ui test
pnpm --filter @yaade/ui typecheck
pnpm exec playwright test --project=bench tests/bench/neovim-render.bench.ts
```

Expected: `preserveDrawingBuffer` is absent; normal frames use <=4 draws; dirty
updates upload only dirty packet ranges; all renderer CPU/resource budgets pass.

### Step 5: Make glyph rasterization fast, bounded, and typographically correct

1. Reuse one raster canvas and 2D context per surface. Resize only when the
   maximum glyph bitmap dimensions grow.
2. Measure `actualBoundingBoxLeft/Right/Ascent/Descent`; include bounded padding
   and bearings in atlas entries/packet geometry. Do not clip italic overhang,
   combining accents, underline/descenders, Nerd Font symbols, or double-width
   glyphs.
3. Keep font family/size/DPR/style/span in the atlas generation/key, but avoid
   rebuilding font strings and composite string keys in every cell update.
   Cache the four regular/bold/italic/bold-italic font descriptors per metrics
   generation.
4. Replace `entriesInUse()` frame scans and uploaded-marker strings with a
   bounded pending-upload queue emitted only on atlas misses.
5. Release CPU bitmap bytes after successful texture upload. Track pending and
   peak bitmap bytes.
6. Derive atlas width/layers from metrics, expected glyph capacity, GL limits,
   and the explicit <=8 MiB target. Fail clearly before exceeding the 16 MiB
   hard cap.
7. Rebuild from currently visible glyph/style/span combinations when full.
   Make rebuild atomic: never draw packets referring to stale atlas locations.
8. Optionally prewarm the common printable ASCII set after first ready paint via
   idle scheduling only if measurement reduces later jank without regressing
   first frame or memory. Delete the prewarm if it does not win.
9. Verify browser font readiness and DPR changes without repeatedly constructing
   measurement canvases. Track DPR explicitly and repaint on monitor changes.

**Tests/E2E fixture text**:

- ASCII regular/bold/italic/bold-italic;
- combining marks;
- CJK wide cells and empty continuation cells;
- emoji behavior documented as monochrome alpha when the font supplies color;
- Arabic/Indic clusters as emitted by Neovim;
- Nerd Font/private-use symbols;
- maximum legal font size/DPR;
- repeated atlas fill/rebuild with stable visible output and bounded memory.

**Verify**:

```sh
pnpm --filter @yaade/ui test
pnpm exec playwright test --project=web-e2e tests/electron/neovim-tool.electron.spec.ts --grep "Unicode|font|theme|context"
pnpm exec playwright test --project=bench tests/bench/neovim-render.bench.ts
```

Expected: visual fixtures are not clipped, atlas CPU bytes drain after upload,
and first-frame/atlas budgets pass.

### Step 6: Close input, focus, clipboard, mouse, and location correctness gaps

1. Add `nvim_ui_set_focus` to metadata validation when available and send true/
   false on hidden-textarea focus transitions. Gracefully support 0.10 metadata
   where the method differs or is absent, backed by the compatibility matrix.
2. Extend the pure keyboard event shape with AltGraph information and platform
   context. Mirror the repository's terminal input tests for:
   - AltGraph printable text;
   - macOS Option-produced text;
   - Ctrl/Alt/Meta mappings;
   - `<`, Space, function/navigation keys;
   - shell prefix capture/double-prefix literal;
   - no keydown + input duplication.
3. Verify visual copy against real Neovim for characterwise, linewise, and
   blockwise selections. Query active selection endpoints with typed RPC/Lua
   arguments and report clipboard permission failures through a non-blocking,
   actionable status instead of swallowing them.
4. Keep platform paste as one complete `nvim_paste` phase and preserve Ctrl-V
   visual-block behavior. Test multiline, CRLF, large bounded text, Unicode, and
   IME composition around paste.
5. Normalize wheel deltas into bounded vertical/horizontal Neovim wheel steps.
   Coalesce only redundant trackpad events within one animation frame and
   preserve press/drag/release ordering and pointer capture.
6. Define Search columns at the app boundary as character or byte columns.
   Convert to the UTF-8 byte column required by `nvim_win_set_cursor` using a
   typed RPC query of the opened line when necessary. Test a non-ASCII location.
7. Handle unknown Neovim server requests explicitly with an RPC error; never
   silently return success/undefined. Do not replace the user's clipboard
   provider in this plan.
8. Add best-effort `nvim_ui_detach` before an intentional socket close when the
   connection is healthy; EOF remains the crash fallback.

**Verify**:

```sh
pnpm --filter @yaade/ui test
pnpm --filter @yaade/app test
pnpm exec playwright test --project=web-e2e tests/electron/neovim-tool.electron.spec.ts --grep "input|IME|paste|mouse|Search|focus|clipboard"
```

Expected: all international input and selection modes pass without duplicates;
non-ASCII Search locations land on the requested character; shell keys do not
leak.

### Step 7: Make connection, generation, visibility, and errors race-safe

1. Introduce a monotonically increasing connection epoch. Every socket handler,
   receive chain, attach continuation, retry timer, and ready waiter must verify
   it still belongs to the current generation/epoch before mutating state.
2. Cancel a pending retry before an immediate generation reconnect. Guarantee at
   most one active socket/RPC client and one retry timer per surface.
3. Use bounded exponential reconnect backoff with jitter and reset after a
   successful attached flush. Pause retries while offline/hidden when the pane
   cannot be shown, but keep the host process alive.
4. Separate typed failure categories: WebGL unavailable/context restore failed,
   Neovim API incompatible, protocol malformed, temporary channel unavailable,
   process exited, and host lifecycle failed.
5. Give each category a useful action:
   - retry/recreate renderer for WebGL context failure;
   - reconnect UI for temporary channel failure;
   - restart Neovim only for process failure/exit;
   - copy concise diagnostics for protocol/API incompatibility.
6. Keep React state limited to low-frequency status/error category. Use current
   semantic tokens and `AnimatePresence`; do not animate grid content, typing,
   scroll, or resize.
7. Reconcile the surface registry bound with the actual live ToolUse/pane cap.
   Never evict a still-mounted surface without disposal or make it unreachable
   to Search/input. Keep pending locations newest-only and bounded.
8. Ensure host process/endpoint cleanup remains deterministic on context change,
   archive, crash, SIGTERM/SIGKILL fallback, and host close.

**Race tests**:

- generation changes while old API attach is awaiting a response;
- retry timer fires during generation change;
- two browser leases supersede in both orders;
- pane hides/shows during reconnect;
- process exits during attach;
- context loss during redraw;
- Search queues a location while reconnecting;
- dispose while Blob conversion/decode is pending.

**Verify**:

```sh
pnpm --filter @yaade/host-server test
pnpm --filter @yaade/ui test
pnpm --filter @yaade/app test
pnpm exec playwright test --project=web-e2e tests/electron/neovim-tool.electron.spec.ts --repeat-each=3
```

Expected: no flakes, duplicate sockets, stale status transitions, leaked timers,
children, endpoints, or unhandled rejections.

### Step 8: Replace smoke tests with correctness, stress, and real performance gates

1. Expand `tests/electron/neovim-tool.electron.spec.ts` while keeping each test
   isolated and scoped. Required scenarios:
   - create/ready/WebGL2/model pixels;
   - normal/insert/visual/command modes and cursor shapes;
   - Unicode/wide/combining/plugin highlight fixtures;
   - keyboard, AltGraph, Option, IME, paste, copy, mouse, wheel, focus;
   - resize, DPR, light/dark/font/theme without process restart;
   - two and four distinct processes/surfaces;
   - Session/Window/retile/reload durability;
   - context change to canonical new cwd and generation;
   - Search reuse and non-ASCII location;
   - clean/failed exit, restart, archive, host cleanup;
   - temporary disconnect/backoff and stale generation;
   - real context loss using `WEBGL_lose_context` and restore;
   - WebGL unavailable with renderer-specific recovery, no Canvas fallback.
2. Capture console/page/request failures before navigation and require no new
   failures. Replace arbitrary `waitForTimeout` calls with state/diagnostic
   conditions.
3. Replace synthetic context events with the real WebGL extension. If Chromium
   does not expose it in CI, keep a unit test for handler semantics and mark a
   separately named environment limitation; do not claim real restore coverage.
4. Rebuild `tests/bench/neovim-render.bench.ts` around in-page correlated marks.
   Use enough rounds for p95/p99 (minimum 20 steady-state samples; more for cheap
   interactions), warm shaders/atlas, and report raw samples/stages.
5. Add fixtures for full 10k cells, 1k contiguous/disjoint dirty cells, fast
   scroll, 100k cells/s flood with interleaved input, theme repaint, idle rAF,
   four surfaces, and reconnect cycles.
6. Add a browser memory stress check with explicit GC/CDP where supported. Track
   model bytes, packet capacity, atlas GPU estimate, pending bitmap bytes,
   listeners/timers/sockets, and host runtime/endpoint counts even when heap
   metrics are unavailable.
7. Verify visual screenshots at 1440x900 dark/light and 390x844. Review the
   actual images for clipping, contrast, cursor, decorations, overlay state,
   overflow, and mobile focus; do not only attach files.
8. Keep the deterministic mock for CI speed, plus a separate pinned real-Neovim
   compatibility job. The mock may not be changed to accept client bugs that
   real Neovim rejects.

**Verify**:

```sh
pnpm exec playwright test --project=web-e2e tests/electron/neovim-tool.electron.spec.ts --repeat-each=3
pnpm exec playwright test --project=bench tests/bench/neovim-render.bench.ts
```

Expected: all scenarios and budgets pass without skips; output includes raw
samples, stage timings, resource estimates, and environment metadata; reviewed
screenshots cover the stated matrix.

### Step 9: Document the stable v1 contract and run final gates

1. Update `README.md` with supported Neovim versions, single-grid compatibility,
   browser/host restart semantics, WebGL2 requirement, clipboard limitations,
   Search location behavior, diagnostics, and performance budgets.
2. Update `AGENTS.md` with connection epochs, model/packet/atlas bounds, real
   compatibility tests, resource diagnostics, and the no-preserved-framebuffer
   invariant.
3. Update `packages/yaade-ui/AGENTS.md` with the packed cell layout, style cache,
   atlas lifetime, dirty-range ownership, input/focus contract, and commands to
   profile before modifying the hot path.
4. Record any remaining deliberate limitations explicitly: single UI lease,
   single grid/external extensions off, no Canvas fallback, host restart does
   not preserve the process, and browser clipboard permission constraints.
5. Run all scoped and repository gates. Classify any full-suite failure by
   reproducing it against the pre-step baseline; never hide a Neovim regression
   as “pre-existing.”

**Verify**:

```sh
pnpm -r typecheck
pnpm exec oxlint apps/host-server/src/neovim apps/host-server/src/tools/neovim-driver.ts packages/yaade-ui/src/panels/neovim packages/yaade-app/src/tools/renderers/NeovimToolView.tsx tests/electron/neovim-tool.electron.spec.ts tests/bench/neovim-render.bench.ts --deny-warnings
pnpm test
pnpm build
pnpm exec playwright test --project=web-e2e tests/electron/neovim-tool.electron.spec.ts
pnpm exec playwright test --project=bench tests/bench/neovim-render.bench.ts
pnpm test:e2e
git diff --check
git status --short
```

Expected: all Neovim-scoped commands pass with zero warnings/skips; full unit and
build pass; any unrelated full-E2E baseline issue is separately evidenced and
has no changed Neovim outcome; status lists only intentional work plus preserved
pre-existing changes.

## Test plan summary

### Pure/unit

- Msgpack fragmentation/coalescing/bounds/request ordering/server-request errors.
- Redraw validation and all supported linegrid events against real fixtures.
- Dirty union/coalescing, flush transaction, resize/scroll/wide/continuation.
- Long-session glyph compaction and bounded metadata.
- Packed cell records, style invalidation, blend determinism, dirty byte ranges.
- Atlas packing/bearings/pending uploads/rebuild/resource caps.
- Keyboard/AltGraph/Option/IME/paste/mouse notation.
- Connection epoch and retry state machine with deterministic clocks.

### Host integration

- Distinct process/generation/cwd and canonical context switch.
- Version compatibility and actionable missing/old binary errors.
- Lease supersession, binary proxy bounds, stale generation, browser detach
  survival, process exit, archive, host close, endpoint cleanup.

### Browser E2E

Use the Step 8 scenarios. Assert model/host truth through stable agent hooks,
DOM semantics for statuses/actions, and WebGL pixels only for renderer existence
and visual correctness. Do not use query echoes as proof.

### Performance/memory

Use the budgets above. Keep before/after raw samples and a short cost-model note:
bytes per cell, dirty bytes per workload, atlas allocation, draw calls, and which
stage moved. Revert optimizations that do not improve the measured target.

## Done criteria

All must hold:

- [ ] Real Neovim 0.10 and current-stable compatibility runs pass with isolated
      config, in addition to the deterministic mock.
- [ ] One ToolUse still owns exactly one process; browser/React remount never
      spawns or kills it.
- [ ] Context change uses canonical new cwd, increments generation, and removes
      the old process/endpoint.
- [ ] Connection epochs prevent stale attach/retry/socket work from mutating the
      current generation.
- [ ] Model, glyph interning, highlight metadata, RPC queues, registries, atlas,
      GPU buffers, pending bitmaps, diagnostics, timers, and retries are bounded.
- [ ] No per-flush full-frame/dirty-row copy remains.
- [ ] `preserveDrawingBuffer` is absent and repeated blended redraws are stable.
- [ ] Normal rendering uses <=4 instanced draws and retained cell packets.
- [ ] Dirty packet uploads target exact contiguous row ranges.
- [ ] Cursor blink/focus performs zero cell packet rebuild/upload.
- [ ] Per-cell packet build contains no regex, CSS parsing, font-string assembly,
      canvas creation, or color-array allocation.
- [ ] Atlas uses one reusable raster context, releases uploaded CPU bitmaps, and
      stays within the declared GPU cap.
- [ ] Unicode, combining marks, wide cells, Nerd Font symbols, decorations,
      reverse/blend, and cursor shapes pass unit/E2E/visual checks.
- [ ] AltGraph, macOS Option, IME, paste, visual copy modes, mouse/wheel, focus,
      bare Escape, shell prefix, and double-prefix literal all pass.
- [ ] Search reuse opens ASCII and non-ASCII locations at the correct line/column.
- [ ] WebGL/API/protocol/channel/process failures show category-appropriate
      actions; no Canvas fallback exists.
- [ ] True input-to-paint, flood, full/dirty redraw, scroll, theme, first-frame,
      idle, multi-surface, reconnect, and memory gates pass.
- [ ] Real `WEBGL_lose_context` restore coverage passes or is explicitly marked
      unsupported by the CI browser without a false synthetic claim.
- [ ] Dark/light desktop and mobile screenshots are reviewed, not merely saved.
- [ ] `pnpm -r typecheck`, scoped lint, `pnpm test`, `pnpm build`, focused E2E,
      and focused benchmark exit 0.
- [ ] No unrelated working-tree changes are reverted or reformatted.
- [ ] `plans/README.md` marks Plan 002 DONE only after every applicable item
      above passes.

## STOP conditions

Stop and report instead of improvising if:

1. Live Neovim files materially differ from the “Current state” excerpts before
   implementation starts.
2. A required change would revert or rewrite unrelated Session/liquid-material
   working-tree edits.
3. Real 0.10/current API metadata contradicts the single-grid assumptions. Show
   the exact metadata/help difference and refresh the protocol design first.
4. Correctness appears to require editor text/redraw bytes in React state,
   EventHub, SQLite, generic JSON RPC, or a Canvas display fallback.
5. A proposed optimization has no reproducible baseline or does not improve its
   named metric after two measured attempts. Keep/revert based on data.
6. Packed packets require unsafe JS/TS boundary casts, unvalidated external
   values, or a layout whose byte invariants cannot be unit-tested.
7. Grid/atlas/resource caps reject an ordinary 1440x900 or 4K/DPR2 editor at the
   configured maximum font size. Report measured byte requirements before
   raising caps.
8. Real Neovim compatibility requires replacing the user's config, colorscheme,
   keymaps, plugins, or clipboard provider.
9. Input handling would require a browser-reserved global chord or swallowing
   bare Escape.
10. Full E2E reveals duplicated/lost input, stale grids, wrong generations,
    process/socket leaks, unbounded buffering, context-restore data loss, or
    memory that does not plateau.
11. A step's focused verification fails twice after one reasonable correction.
12. The work expands into ext_multigrid/externalized UI, host daemon persistence,
    remote auth, legacy shells, or Monaco. Split that into a later plan.

## Maintenance notes

- Reviewers should inspect data flow and byte ownership before style: wire
  values, reducer arrays, packed cell records, GPU buffer offsets, atlas entries,
  and disposal must tell one consistent story.
- Do not infer speed from dev mode, averages, or renderer CPU alone. Keep raw
  p50/p95/p99 samples and environment metadata.
- `gl_InstanceID` and fixed slots make full-grid draw count predictable; if a
  future ext_multigrid plan changes composition, preserve stable packet offsets
  per grid rather than reintroducing per-frame compaction by default.
- If Neovim adds redraw events, update metadata fixtures and reducer tests before
  accepting them. Unknown events remain counted/ignored only when they are truly
  forward-compatible and not required for visible correctness.
- A future browser clipboard-provider bridge must be a separate design: it must
  respect transient user activation and restore the user's provider on channel
  close. Do not inject one casually.
- A future authenticated remote mode must authenticate the dedicated Neovim WS
  route; origin checking is not remote authorization.
