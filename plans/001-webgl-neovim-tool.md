# Plan 001: Add a standalone WebGL2 Neovim ToolUse backed by one host process per tool

> **Executor instructions (LUNA)**: Read this plan fully before editing. Implement
> it in the stated order and run every gate before continuing. Preserve all
> unrelated work already present in the working tree. Do not commit, push, or
> open a PR unless the operator explicitly asks. If a STOP condition occurs,
> stop and report it; do not improvise around the architecture.
>
> **Drift check (run first)**:
>
> ```sh
> git diff --stat 1c80ddd..HEAD -- \
>   packages/yaade-rpc packages/yaade-workspace packages/yaade-host-client \
>   apps/host-server packages/yaade-ui packages/yaade-app tests README.md AGENTS.md
> git diff --stat -- \
>   packages/yaade-rpc packages/yaade-workspace packages/yaade-host-client \
>   apps/host-server packages/yaade-ui packages/yaade-app tests README.md AGENTS.md
> ```
>
> This plan was written while the working tree already contained uncommitted
> liquid-material/theme and split-controls-only changes in `README.md`,
> `packages/yaade-app/src/tools/ToolTilingWorkspace.tsx`,
> `packages/yaade-shared/src/theme/shadcn-tokens.ts`,
> `packages/yaade-ui/AGENTS.md`, `packages/yaade-ui/src/mux/MuxPaneChrome.tsx`,
> `packages/yaade-ui/src/styles/globals.css`, and
> `packages/yaade-ui/src/theme/shadcn.ts`. Those edits are intentional current
> design work. Preserve them exactly and build on their new material variables;
> never restore the `1c80ddd` versions.

## Status

- **Priority**: P1
- **Effort**: XL (multi-week; land as reviewable vertical slices)
- **Risk**: HIGH — process lifetime, binary RPC, keyboard semantics, text rendering, and GPU resource ownership all meet here
- **Depends on**: none
- **Category**: direction / architecture / performance
- **Planned at**: commit `1c80ddd`, 2026-08-16, plus the uncommitted liquid-material changes listed above

## Goal

Add `"neovim"` as a first-class `ToolKind`, alongside `"git"` and `"search"`.
Creating a Neovim ToolUse immediately launches exactly one Neovim server on the
host for that ToolUse. The browser attaches as a remote UI, applies Neovim's
`ext_linegrid` redraw protocol to a compact client model, and renders the model
with a direct WebGL2 glyph-atlas renderer. It must not render Neovim through a
PTY, Canvas 2D, Monaco, DOM rows, WebGPU, Electron, Rust, or a native wrapper.

The final user flow is:

```text
New Neovim ToolUse
  -> host resolves that ToolUse's project/worktree
  -> host starts nvim --headless --listen <private endpoint>
  -> browser opens /ws/neovim/<tool-use>?generation=<n>
  -> browser sends Msgpack-RPC nvim_ui_attach(..., ext_linegrid=true)
  -> redraw notifications update a line-grid model
  -> one WebGL2 surface paints the grid
```

A ToolUse is the lifetime identity. Moving the ToolUse to another pane does not
start another server. React mounting or remounting never starts a server. Two
separate Neovim ToolUses always receive separate Neovim processes, even if they
point at the same checkout.

## Non-negotiable outcomes

1. `ToolKind` gains `"neovim"`; do **not** rename or repurpose the currently
   disabled `"editor"` kind.
2. One host Neovim process exists per live Neovim ToolUse, not per browser
   component mount and not per project.
3. Browser reload, Session switch, Window switch, pane retile, and theme switch
   do not kill the Neovim process.
4. Closing/cancelling the ToolUse, changing its project/worktree, or host
   shutdown terminates its server and cleans its private socket/pipe.
5. The visible editor is WebGL2. Canvas 2D may rasterize glyphs into an atlas,
   but it may not be the final display renderer or fallback renderer.
6. Neovim redraw data and editor text never enter React state or the generic
   `ToolSessionStore`. React owns lifecycle/status only.
7. The surface follows current `YaadeTheme`, `theme.highlights`, `--font-mono`,
   semantic colors, liquid-material radii, reduced transparency, and motion
   tokens. No hardcoded palette, font size, radius, or duration values in the
   feature.
8. The shell prefix remains `Mod-k`; Neovim does not receive matched shell
   commands. Bare Escape, ordinary Neovim keys, IME input, mouse input, paste,
   and the double-prefix literal path do reach Neovim.
9. Search remains its own ToolUse. Opening a Search result reuses or creates a
   separate standalone Neovim ToolUse; it no longer embeds a hidden auxiliary
   Neovim PTY inside Search once the new path is proven.
10. Startup, typing, redraw, and long-session memory behavior have measured
    budgets and regression tests.

## Why this matters

YAADE currently has a durable ToolUse model and a sophisticated browser terminal,
but file editing is temporarily disabled and Search opens Neovim inside an
auxiliary terminal PTY. A first-class Neovim tool fits the product's
agent-first, task-centric model better: users keep their real Neovim config and
editing semantics while YAADE owns process durability, checkout identity,
layout, navigation, theming, and remote presentation. The direct line-grid path
also avoids terminal escape parsing and PTY rendering overhead for the editor
surface.

## Current state

### Product and shell

- `packages/yaade-rpc/src/tool-session.ts:23` defines the closed ToolKind union as
  `agent | terminal | search | git | editor`.
- `packages/yaade-rpc/src/tool-session.ts:148`, `:211`, and `:270` maintain
  separate input/output unions plus a kind-pairing filter. Any new kind must be
  added to all three locations.
- `apps/host-server/src/tools/registry.ts:4` duplicates the closed list and
  rejects an incomplete driver registry.
- `apps/host-server/src/tools/service.ts:39`, `:80`, `:647`, and `:694` own
  pending output, driver construction, input pairing, and default titles.
- `apps/host-server/src/tool-session-store.ts:98-105` has explicit persisted
  input/output schema unions. The SQLite table is already generic JSON; this
  feature needs no new table and no destructive DB migration.
- `packages/yaade-app/src/tools/tool-registry.tsx:83-126` lazy-loads one React
  renderer per kind.
- `packages/yaade-app/src/tools/ToolSessionApp.tsx:559` creates tools, but
  `:566` explicitly disables `editor`. Preserve that behavior and add a new
  Neovim branch instead.
- `packages/yaade-app/src/tools/SessionEmptyState.tsx:20`,
  `ToolTilingWorkspace.tsx:73`, `ToolUseTabStrip.tsx:88,236,633`, and
  `ToolUseSwitcher.tsx:7` contain closed icon/launcher maps.
- `packages/yaade-app/src/keybindings.ts:70` is the only key assignment source.
  `n` already means New Window, so Neovim must use the available mnemonic `e`.

### Process and transport patterns

- `apps/host-server/src/tools/model.ts` defines the Effect-returning `ToolDriver`
  contract. Match it; do not introduce a second lifecycle framework.
- `apps/host-server/src/host-runtime.ts` owns long-lived host services and runs
  final shutdown.
- `apps/host-server/src/server.ts:122` applies the origin gate before all WS
  upgrades. `:1496` handles the generic EventHub socket; `:1582` proxies LSP.
  The Neovim socket must be a sibling dedicated binary route, not an EventHub
  channel.
- `apps/host-server/src/events.ts` deliberately excludes terminal paint data
  from replay. Neovim redraw bytes must likewise never enter EventHub history.
- `packages/yaade-host-client/src/web-transport.ts` is optimized for generic
  events and PTY frames. Do not force raw Neovim Msgpack traffic through this
  JSON/EventHub layer.

### Renderer and design patterns

- `packages/yaade-ui/src/panels/ghostty/surface.ts` is the best lifecycle
  exemplar: imperative surface, hidden textarea, font loading, ResizeObserver,
  DPR tracking, input/IME handling, explicit disposal, dirty rendering, and an
  E2E registry outside React state.
- `packages/yaade-ui/src/panels/TerminalPanel.tsx:714` uses the shared root-style
  observer to apply theme/font changes without remounting.
- `packages/yaade-shared/src/theme/theme-types.ts` exposes `YaadeTheme.colors`,
  `YaadeTheme.highlights`, terminal colors, and semantic tokens. GPU colors must
  come from these compatibility sRGB values or `toSrgbColor`; WebGL does not
  consume authored OKLCH strings directly.
- The current uncommitted `globals.css` work introduces
  `--yaade-pane-radius`, `--yaade-control-radius`, `--yaade-pill-radius`,
  `--yaade-material-fill*`, `--yaade-material-stroke`,
  `--yaade-material-highlight`, `--yaade-material-shadow`, and liquid-material
  pane selectors. Use those values; do not create a second material vocabulary.
- Motion stays on the existing `yaadeMotion` and `--yaade-motion-*` tokens.
  Actions commit immediately. Loading/reconnect/error/ready overlays animate;
  typing, cursor movement, split dragging, and grid resize do not wait for
  animation.

### Existing Search/Neovim behavior

- `packages/yaade-app/src/tools/renderers/SearchToolView.tsx` starts a Neovim
  terminal and swaps Search's content for that terminal.
- `search-neovim.ts` builds Ex commands; `search-neovim-sessions.ts` stores
  auxiliary PTY ids in a module-level map.
- After the standalone integration passes, delete those two helpers and make a
  Search result open/reuse a standalone Neovim ToolUse in another pane.

## Architecture decision

### Host process: native Neovim server, not embedded stdio

Launch:

```text
nvim --headless --listen <private endpoint>
```

Use `child_process.spawn` with an argument array and `shell: false`. Set
`cwd = toolUse.context.checkoutPath`. Preserve the user's normal Neovim config;
add only non-invasive environment markers such as `YAADE_NVIM=1` and true-color
hints. Do not set `NVIM_APPNAME`, inject a colorscheme, rewrite user config, or
run the process in a PTY.

Use a short private Unix socket under a mode-0700 temp directory on POSIX, and a
named pipe on Windows. Unix-domain socket paths have small platform limits, so
hash ToolUse id + generation into a short filename; never concatenate a long
`dataDir` path blindly. Delete stale endpoints before spawn and after exit.

The host must probe the configured binary once and cache its version. Support an
optional `YAADE_NVIM_BIN` executable override for tests and nonstandard installs.
Require an API version that supports linegrid (`nvim >= 0.10` is the compatibility
floor); use API metadata at attach time for feature checks rather than assuming
the newest local binary. Missing/old Neovim produces an actionable failed
ToolUse, not a host crash.

### Browser connection: dedicated raw binary WebSocket proxy

Add:

```text
/ws/neovim/<ToolUseId>?generation=<positive integer>
```

The existing origin check remains mandatory. On upgrade:

1. Decode and validate ToolUse id and generation.
2. Require a live Neovim runtime with that exact generation.
3. Supersede any prior browser UI lease for that ToolUse. One ToolUse has one
   authoritative browser UI at a time; a reload wins over its stale socket.
4. Connect a new Node `net.Socket` to the private Neovim endpoint.
5. Proxy WS binary messages to the socket and socket chunks back as WS binary
   frames without JSON conversion.
6. Bound each message and queued/buffered bytes. Close with 1013 if either side
   exceeds 2 MiB rather than growing memory without bound.
7. On WS close, close only this RPC channel. The Neovim server process survives.
   Because the UI channel closes, Neovim detaches that UI; the next client gets
   a complete initial redraw after attaching.

Do not publish these bytes through `runtime.events`, do not persist them, and do
not expose the private socket path in ToolUse output.

### Browser RPC

Use `@msgpack/msgpack` directly. Add it as a direct `@yaade/ui` dependency and a
host-server dev dependency for the mock server. Implement a streaming decoder
that accepts fragmented and coalesced WS chunks. The client owns monotonically
increasing request ids, a bounded pending-request map, timeout/rejection, and
full cleanup on close.

On each connection:

1. call `nvim_get_api_info` and validate required methods/events;
2. call `nvim_set_client_info` with YAADE/version metadata;
3. call `nvim_ui_attach(cols, rows, options)` with:
   - `rgb: true`
   - `ext_linegrid: true`
   - `ext_hlstate: true` when metadata says it is supported
   - `ext_multigrid: false`
   - `ext_cmdline: false`
   - `ext_popupmenu: false`
   - `ext_messages: false`
   - `ext_tabline: false`

Keeping the externalized extensions off is deliberate for v1: Neovim draws
command line, popup menu, messages, tabs, windows, and floating plugin UI into
one authoritative grid. This sharply reduces correctness risk while retaining
normal Neovim behavior and plugin compatibility. Multigrid/externalized chrome
is a later project, not an excuse to block this feature.

### Process lifetime contract

| Event | Neovim server |
| --- | --- |
| Create ToolUse | Start one process before returning `running` |
| React renderer mounts | Attach UI only; never spawn |
| Renderer unmounts / Session or Window switch | UI socket may close; process survives |
| Browser reload/reconnect | New UI socket attaches; same process/generation survives |
| ToolUse moved or pane retiled | Same process survives |
| ToolUse project/worktree changes | Stop old process, persist new context, start generation + 1 |
| Restart ToolUse | Stop old process, clean endpoint, start generation + 1 |
| Cancel/close ToolUse | Stop process; clean endpoint |
| `:qa` / process exits | ToolUse becomes succeeded/failed with restart affordance |
| Host shutdown | Stop all Neovim processes before DB/runtime close |
| Host restart | Persisted live Neovim ToolUse becomes `disconnected`; do not pretend it survived |

Terminate with SIGTERM, wait a short bounded grace period, then SIGKILL. Process
stderr is a bounded 64 KiB diagnostic ring used in the ToolUse error; never log
or retain it without a bound.

## Data model

Add these schema members in `packages/yaade-rpc/src/tool-session.ts`:

```ts
NeovimToolInput {
  _tag: "NeovimToolInput"
  kind: "neovim"
}

NeovimToolOutput {
  _tag: "NeovimToolOutput"
  kind: "neovim"
  serverInstanceId: string       // opaque; never an endpoint path
  generation: number             // positive integer
  processState: ProcessState
  version?: string
  exitCode?: number
}
```

Do not persist cursor, buffers, text, highlights, redraw events, socket paths,
WebGL state, or browser connection state. Neovim itself owns editor state while
its process is alive; ToolUse persistence owns only lifecycle identity.

Add a `NeovimToolDriver` that delegates process ownership to a host-level
`NeovimHost`. Driver operations return typed `Effect`s and wrap spawn/socket
failures as the existing `ToolDriverFailure`. Use `Effect.fn` for named
start/stop/restart operations and scoped acquire/release where a socket or child
handle has a bounded lifetime. Keep `Effect.runPromise` at the existing
ToolService/server boundary; do not create local Effect runtimes per request.

## Client line-grid model

Create pure, testable code under `packages/yaade-ui/src/panels/neovim/`.
Suggested files:

```text
rpc.ts                 Msgpack-RPC request/response/notification client
protocol.ts            unknown -> validated redraw tuple decoding
line-grid.ts           authoritative grid/highlight/mode/cursor reducer
input.ts               key, modifier, IME, paste, and mouse encoding
font.ts                font loading and cell metrics
atlas.ts               glyph keys and texture-array row packing
webgl-renderer.ts      WebGL2 resources, shaders, buffers, draw passes
surface.ts             imperative lifecycle and browser connection
registry.ts            bounded E2E/search imperative access by ToolUse id
NeovimPanel.tsx        React lifecycle/status adapter only
*.test.ts              pure protocol, reducer, input, atlas, packing tests
```

### Hot data

Use compact fixed-size arrays sized `rows * cols`:

- interned glyph/cluster id: `Uint32Array`
- highlight id: `Uint32Array`
- cell width/continuation flags: `Uint8Array`
- dirty rows: `Uint8Array`
- renderer instance arrays reused across frames

Keep cold data in side tables:

- interned glyph strings and reverse map
- highlight attributes keyed by Neovim highlight id
- highlight metadata/group names for theme remapping
- mode metadata and diagnostics counters
- title, errors, API metadata

Do not create one JS object per visible cell. Do not use React state for the
model. A typical 200x80 grid must remain bounded and cheap to clear/resize.

### Required redraw handling

Implement and unit-test at least:

- `set_title`, `set_icon`
- `mode_info_set`, `mode_change`
- `mouse_on`, `mouse_off`
- `busy_start`, `busy_stop`
- `bell`, `visual_bell`
- `flush`
- `default_colors_set`
- `hl_attr_define`
- `option_set`
- `grid_resize`, `grid_clear`, `grid_destroy`
- `grid_cursor_goto`
- `grid_line`, including omitted highlight id and repeat counts
- `grid_scroll`, including overlapping positive and negative copies

Unknown forward-compatible events are counted and ignored; malformed known
events close the client with a visible protocol error. Only `flush` publishes a
coherent render snapshot. Multiple redraw notifications before `flush` are one
frame transaction.

## WebGL2 renderer design

### Rendering pipeline

Use direct WebGL2, not a large scene-graph dependency.

1. **Background pass** — fixed one instance per visible cell, with packed sRGB
   background and reverse/blend flags.
2. **Glyph pass** — fixed one instance per cell/cluster, sampling an alpha glyph
   atlas and applying foreground color in the fragment shader.
3. **Decoration pass** — underline variants, undercurl approximation,
   strikethrough, and underdot/dash from compact flags.
4. **Cursor pass** — block, vertical, horizontal, and hollow-unfocused cursor.

Use one static unit quad, instanced draws, and a small fixed number of draw calls.
Never issue one draw call per glyph or cell. Create shaders, VAOs, buffers, and
textures once per surface; grow buffers geometrically and reuse them. Upload only
dirty row ranges with `bufferSubData` after a flush. A full repaint is allowed
for resize, theme/font change, context restore, and visibility restore.

### Glyph atlas

Canvas 2D/OffscreenCanvas is permitted only to rasterize a glyph/cluster into an
alpha bitmap. Upload alpha data into a WebGL2 `R8` `TEXTURE_2D_ARRAY` with a
bounded number of 2048x2048 layers (derive the actual cap from GL limits). Pack
rows deterministically, batch texture uploads before drawing, and rebuild on
font-family/font-size/DPR changes. Glyph color does not belong in the atlas key;
font family, size, weight, italic, text cluster, and cell span do.

If the bounded atlas fills, clear and rebuild from glyphs currently visible;
do not add an unbounded LRU map. Expose atlas rebuilds and occupancy through
diagnostics.

### Metrics, resize, and DPR

Load the currently selected `--font-mono` face and style variants before final
measurement. Use the root appearance font size and
`--yaade-editor-line-height`; do not inline pixel values. Track DPR changes and
size the backing store to CSS size x DPR. A ResizeObserver calculates rows/cols,
coalesces changes to one resize per animation frame, updates the local viewport,
and calls `nvim_ui_try_resize` without a 150 ms editor lag. Split dragging is an
instant functional resize; only surrounding pane chrome may animate.

### Scheduling and visibility

Render on demand only:

- Neovim `flush`
- resize/DPR/font/theme change
- cursor blink phase
- visual bell
- WebGL context restore
- hidden -> visible transition

No perpetual `requestAnimationFrame` loop. Hidden panes continue consuming RPC
and updating the line-grid model but skip GPU work. Showing one performs a full
repaint from the authoritative model.

Listen for `webglcontextlost`/`webglcontextrestored`. Prevent default on loss,
release JS references, rebuild all GPU resources on restore, and repaint from
the line-grid model. If WebGL2 is unavailable, show an actionable error with a
Restart button. Do not silently fall back to Canvas 2D.

## Theme and visual specification

The editor is an instrument inside the current liquid-material pane, not a
second app shell.

- Pane chrome remains the current split-controls-only liquid material from the
  uncommitted design work.
- The WebGL canvas is clipped by the pane's `--yaade-pane-radius` and clears to
  the theme work-surface background. It adds no independent rounded card,
  gradient, toolbar, or shadow.
- Font comes from `--font-mono`; the bundled symbol fallback remains available.
- Resolve default editor colors from `YaadeTheme.colors` and syntax from
  `YaadeTheme.highlights`.
- With `ext_hlstate`, remap standard highlight group names locally:
  - `Normal` -> background/foreground
  - `LineNr` -> muted foreground
  - `CursorLineNr`/cursor -> primary
  - `Visual` -> selection/secondary
  - `Search`/`IncSearch` -> warning/primary contrast pair
  - `Pmenu`/`PmenuSel` -> card/accent
  - status lines/floats -> card/popover
  - separators -> border
  - diagnostics -> destructive/warning/info/success
  - syntax groups -> the corresponding `theme.highlights` role
- Preserve explicit plugin colors when no recognized group is available. Theme
  remapping is renderer-local; never mutate the user's Neovim colorscheme.
- Parse all GPU colors to sRGB through existing compatibility helpers.
- Ready/reconnect/error overlays use semantic `background`, `card`, `popover`,
  `muted-foreground`, `destructive`, `info`, and existing primitives.
- Use `AnimatePresence`, `motion/react-m`, and `yaadeMotion` only for overlay
  enter/exit and reconnect feedback. Do not animate typed text, cursor movement,
  grid scroll, or resize. Reduced motion uses opacity only; reduced transparency
  uses the existing opaque material fallback.
- Icons are Lucide only. Use `FileCode2` (or the existing closest Lucide code
  icon) consistently for Neovim launchers/switchers.

The signature element is the true Neovim grid rendered as a crisp GPU text plane
inside YAADE's rounded liquid pane. Spend visual character there; do not add a
bespoke editor toolbar or decorative chrome.

## Keyboard, IME, clipboard, and mouse

### Keyboard

Implement a pure `KeyboardEvent -> Neovim input notation | browser action`
encoder and table-driven tests. Cover printable text, `<LT>`, Escape, Enter,
Tab/Shift-Tab, Backspace, Delete, arrows, Home/End, Page keys, Insert, F1-F12,
and Ctrl/Alt/Shift/Meta combinations. Use Neovim's accepted key notation and
`nvim_replace_termcodes` only when required by metadata; do not manually inject
terminal escape sequences.

Generalize the Tool Session's terminal-only focus check around
`ToolSessionApp.tsx:1095` to a native input-surface check that includes:

```text
[data-yaade-terminal-input]
[data-yaade-terminal-canvas]
[data-yaade-neovim-input]
[data-yaade-neovim-canvas]
```

Matched shell bindings still call both `preventDefault()` and
`stopPropagation()`. Bare Escape reaches focused Neovim. Pressing the prefix
then prefix again calls the registered Neovim surface with the literal control
key rather than the terminal API. Add no direct browser-reserved chord.

Add `Mod-k e` -> `tool.newNeovim` to the canonical keybinding catalog and HUD.
Do not change `Mod-k n` (New Window).

### IME and paste

Mirror the terminal hidden-textarea composition discipline: composition text is
committed once, duplicate `input` is suppressed, autocorrect/spellcheck are off,
and textarea position follows the cursor for candidate windows.

- macOS Cmd-V and non-macOS Ctrl-Shift-V read browser clipboard text and call
  `nvim_paste` with a single complete paste phase.
- Do not steal Ctrl-V from Neovim visual-block mode.
- When the tracked mode is visual and the platform copy chord is used, query the
  selected text via a typed RPC/Lua call with arguments (no source interpolation)
  and write it to the browser clipboard. Outside visual mode, preserve Neovim's
  normal Ctrl-C behavior.

### Mouse

Convert canvas coordinates to grid row/column and call `nvim_input_mouse` for
press, release, drag, and wheel. Use grid id 1 while multigrid is disabled.
Respect focus, pointer capture, DPR, and out-of-bounds clamping. A ResizeObserver
or pointer handler must not read/write layout repeatedly in a loop.

## Search integration

After the standalone Neovim lifecycle, renderer, and E2E tests pass:

1. Add an app-level `openLocationInNeovim({path,line,column,checkoutPath})`
   workflow.
2. Prefer a live Neovim ToolUse in the active Window with the same checkout.
3. Otherwise create a new `neovim` ToolUse using the Search ToolUse's exact
   project/worktree context; the existing pane algorithm opens it beside Search.
4. Keep only the newest pending location per Neovim ToolUse in a bounded
   imperative registry until its UI attaches.
5. Open paths through structured Neovim API calls (`nvim_cmd` when available,
   otherwise a Lua call with path in the argument array) and then
   `nvim_win_set_cursor`. Never construct an Ex command by interpolating a path.
6. Focus/select the Neovim pane while leaving Search mounted and its result list
   intact.
7. Delete `search-neovim.ts`, `search-neovim-sessions.ts`, and their auxiliary
   PTY cleanup branches only after replacement E2E coverage passes.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Check Neovim | `nvim --version` | exit 0; first line reports supported Neovim |
| Add codec | `pnpm --filter @yaade/ui add @msgpack/msgpack` | manifest + lockfile updated |
| Add mock codec | `pnpm --filter @yaade/host-server add -D @msgpack/msgpack` | host dev dependency + lockfile updated |
| RPC tests | `pnpm --filter @yaade/rpc test` | all pass |
| Host tests | `pnpm --filter @yaade/host-server test` | all pass; no leaked child/socket |
| UI tests | `pnpm --filter @yaade/ui test` | all pass, including reducer/input/atlas tests |
| App tests | `pnpm --filter @yaade/app test` | all pass, including keymap/registry/search routing |
| Typecheck | `pnpm -r typecheck` | exit 0, no errors |
| Lint | `pnpm lint` | exit 0, no warnings/errors |
| Focused E2E | `pnpm exec playwright test --project=web-e2e tests/electron/neovim-tool.electron.spec.ts` | all Neovim scenarios pass |
| Session parity E2E | `pnpm exec playwright test --project=web-e2e tests/electron/tool-sessions.electron.spec.ts` | all active scenarios pass |
| Bench | `pnpm exec playwright test --project=bench tests/bench/neovim-render.bench.ts` | all new budgets pass |
| Full unit suite | `pnpm test` | all pass |
| Full E2E | `pnpm test:e2e` | all pass |
| Build | `pnpm build` | SPA and server build exit 0 |

Unit tests in this repo use `node:test` via `tsx`, not Vitest. Add every new test
file explicitly to its package's `test` script. Continue using Effect idioms in
production host code, but match this repository's `node:test` harness rather
than introducing `@effect/vitest` in this feature.

## Suggested executor toolkit

- Use the `effect-ts` guidance for the driver/resource lifetime and typed errors.
- Use `vercel-react-best-practices` to keep the renderer lazily loaded and all
  high-frequency data outside React.
- Use the local code-style/performance guidance: line-grid updates are a data
  transform, WebGL resources are retained, buffers are reused, and measurement
  precedes micro-optimization.
- Use `frontend-design` only to check that the surface follows the existing
  liquid-material direction rather than inventing generic editor chrome.
- Before implementing protocol handling, read the installed Neovim help for
  `:h ui`, `:h api-ui-events`, `:h ui-linegrid`, `:h msgpack-rpc`,
  `:h nvim_ui_attach()`, `:h nvim_input()`, and `:h nvim_input_mouse()`.

## Scope

### In scope

Existing files likely to change:

- `packages/yaade-rpc/src/tool-session.ts`
- `packages/yaade-rpc/src/tool-session.test.ts`
- `apps/host-server/src/host-runtime.ts`
- `apps/host-server/src/server.ts`
- `apps/host-server/src/tools/model.ts` only if the existing contract needs a
  documented Neovim-specific comment; do not redesign it
- `apps/host-server/src/tools/registry.ts`
- `apps/host-server/src/tools/service.ts`
- `apps/host-server/src/tools/service.test.ts`
- `apps/host-server/src/tools/errors.ts` only for typed lifecycle wrapping
- `apps/host-server/src/tool-session-store.ts`
- `apps/host-server/src/tool-session-store.test.ts`
- `apps/host-server/package.json`
- `packages/yaade-ui/package.json`
- `packages/yaade-ui/src/index.ts` and/or a new `neovim-entry.ts`
- `packages/yaade-ui/src/styles/globals.css` — preserve current uncommitted work
- `packages/yaade-ui/AGENTS.md` — preserve current uncommitted work and document
  the new public renderer contract
- `packages/yaade-app/src/keybindings.ts`
- `packages/yaade-app/src/tools/tool-session-keymap.test.ts`
- `packages/yaade-app/src/tools/tool-registry.tsx`
- `packages/yaade-app/src/tools/ToolSessionApp.tsx`
- `packages/yaade-app/src/tools/ToolTilingWorkspace.tsx` — preserve
  `splitControlsOnly`
- `packages/yaade-app/src/tools/SessionEmptyState.tsx`
- `packages/yaade-app/src/tools/ToolUseTabStrip.tsx`
- `packages/yaade-app/src/tools/ToolUseSwitcher.tsx`
- `packages/yaade-app/src/tools/tool-title.ts`
- `packages/yaade-app/src/tools/renderers/SearchToolView.tsx`
- `packages/yaade-app/src/agent-bridge.ts`
- package manifests/test scripts and `pnpm-lock.yaml`
- `tests/electron/tool-sessions.electron.spec.ts`
- `tests/bench/budgets.json`
- `README.md` — preserve current uncommitted appearance copy
- `AGENTS.md` architecture/key-file notes

New files/directories:

- `apps/host-server/src/neovim/` — host process registry, endpoint utilities,
  WS proxy helpers, and tests
- `apps/host-server/src/tools/neovim-driver.ts`
- `apps/host-server/mocks/mock-neovim-server.ts` plus a test executable helper
- `packages/yaade-ui/src/panels/neovim/` as listed above
- `packages/yaade-app/src/tools/renderers/NeovimToolView.tsx`
- optional small app workflow/registry adapter for Search -> Neovim location
- `tests/electron/neovim-tool.electron.spec.ts`
- `tests/bench/neovim-render.bench.ts`

### Out of scope

- Any Rust, Cargo, Tauri, Electron, native desktop wrapper, or browser extension.
- Legacy `App.tsx`, legacy Mission Control, `packages/yaade-app/src/project/`,
  and `packages/yaade-app/src/mux/MuxApp.tsx`. Do not extend those surfaces.
- Re-enabling or deleting the disabled `editor`/Monaco ToolKind.
- LSP integration in YAADE for this surface; Neovim/plugins own editor LSP.
- Neovim multigrid, external command line, external popup menu, external
  messages, GUI tabline, ligatures spanning cells, minimap, or custom editor
  chrome.
- Host-restart process survival. As with current PTYs, browser reload is in
  scope; a separate daemon/reboot persistence layer is not.
- Multiple simultaneous browser UIs controlling the same ToolUse.
- A Canvas 2D fallback. Show a clear unsupported state instead.
- Adding a new global direct key chord.
- Remote authentication. The new WS route must use the existing origin/path
  gates and be documented under the existing local-only security posture.

## Git workflow

- Work on the operator's current branch unless told otherwise.
- Do not discard, stash, reformat, or overwrite the pre-existing liquid-material
  edits.
- Keep changes reviewable as vertical slices, but do not make commits unless the
  operator explicitly asks.
- No drive-by refactors. Especially do not generalize all process drivers or all
  GPU surfaces before the Neovim path works.

## Implementation steps

### Step 1: Lock the contracts and fake server before production process code

1. Add `NeovimToolInput`, `NeovimToolOutput`, and `"neovim"` to every RPC union
   and the ToolUse pairing filter.
2. Extend contract tests to round-trip a Neovim ToolUse and reject mismatched
   input/output.
3. Extend the host store's explicit JSON schemas and add a round-trip test.
4. Create a deterministic mock Neovim executable/server for host and E2E tests.
   It must parse `--listen`, bind the requested socket/pipe, support the small
   RPC method set used by the client, emit an initial `redraw` containing a
   visible fixture string, echo test input through linegrid redraws, record
   resize/focus calls, and shut down cleanly.
5. Make the mock configurable via `YAADE_NVIM_BIN`; production defaults to
   `nvim`.

**Verify**:

```sh
pnpm --filter @yaade/rpc test
pnpm --filter @yaade/host-server test
pnpm -r typecheck
```

Expected: all pass; a persisted Neovim use decodes; the mock leaves no socket or
child process after teardown.

### Step 2: Implement host-owned Neovim lifecycle

1. Implement a single-authority `NeovimHost` keyed by ToolUse id. Store process,
   generation, opaque server instance id, endpoint, bounded stderr, status, and
   active UI lease.
2. Implement version probing, endpoint creation, readiness polling, spawn,
   graceful stop/kill, exit notification, stale endpoint cleanup, and `closeAll`.
3. Add `NeovimToolDriver` and register it in the closed registry.
4. Extend ToolService pending output, kind/input validation, create, restart,
   cancel, context change, process-exit handling, reconcile, and default title.
5. Route archive through ToolService so closing a Neovim ToolUse actually calls
   driver `close` before archiving. Reuse that path for Window/Session stop-tools
   without changing keep-running semantics for unrelated ToolUses.
6. Ensure host shutdown closes every Neovim runtime before the database/runtime
   disappears.
7. Add tests for two uses -> two processes/endpoints, reload-style UI detach ->
   process retained, restart -> generation increments, context change -> old
   process gone/new cwd, cancel/archive -> process gone, host close -> all gone,
   crash -> status update, and missing binary -> actionable failure.

**Verify**:

```sh
pnpm --filter @yaade/host-server test
pnpm --filter @yaade/host-server typecheck
```

Expected: all lifecycle tests pass and process/socket counts return to zero after
each test.

### Step 3: Add the dedicated binary WebSocket proxy

1. Add the upgrade route after the common origin gate.
2. Validate ToolUse/generation and reject missing, stale, archived, failed, or
   non-Neovim uses.
3. Proxy bytes with bounded messages/buffers and one active UI lease.
4. Close only the RPC channel on browser disconnect. Never stop the server from
   this handler.
5. Add server tests for origin rejection, malformed id/generation, stale
   generation, binary round trip, fragmented Msgpack, superseded lease,
   backpressure close, and server survival after WS close.

**Verify**:

```sh
pnpm --filter @yaade/host-server test
pnpm --filter @yaade/host-server typecheck
```

Expected: all tests pass; EventHub history contains no Neovim redraw payloads.

### Step 4: Implement Msgpack-RPC and the pure line-grid reducer

1. Add the direct codec dependency.
2. Build the streaming RPC client with request ids, response errors, server
   requests, notifications, timeouts, and cleanup.
3. Decode unknown values through explicit tuple guards. Add no `any`, unsafe
   assertions, `@ts-ignore`, or `namespace`.
4. Implement fixed-array line-grid state and all required redraw events.
5. Make `flush` the transaction boundary and expose a compact immutable frame
   descriptor/dirty-row view to the renderer without cloning the whole grid.
6. Add table/property-style tests for fragmented frames, combined frames,
   request/response ordering, repeated grid cells, Unicode clusters, wide
   cells, scroll overlap in all directions, resize preservation/clear,
   malformed events, unknown events, and reconnect reset.

**Verify**:

```sh
pnpm --filter @yaade/ui test
pnpm --filter @yaade/ui typecheck
```

Expected: all protocol/reducer tests pass; no browser/DOM dependency is needed
for reducer tests.

### Step 5: Build the WebGL2 renderer and glyph atlas

1. Implement pure atlas packing and glyph/instance packet builders first.
2. Implement the retained WebGL2 resources and four-pass instanced pipeline.
3. Add dirty-row GPU updates, full repaint triggers, bounded atlas rebuild,
   context loss/restore, DPR, and diagnostics counters.
4. Add shader compile/link errors with source labels, but do not dump arbitrary
   Neovim content into logs.
5. Test pure packing/color/instance logic under `node:test`. Test real WebGL in
   Playwright, not jsdom or a fake GL implementation.
6. Add diagnostics: frames, full frames, dirty rows, draw calls, bytes uploaded,
   atlas glyphs/layers/rebuilds, context losses, unknown redraw events, and last
   frame CPU duration.

**Verify**:

```sh
pnpm --filter @yaade/ui test
pnpm --filter @yaade/ui typecheck
pnpm lint
```

Expected: pure tests pass; new source contains no per-cell object model or
per-glyph draw loop.

### Step 6: Build the imperative surface and React adapter

1. Create `NeovimSurface`: canvas, hidden textarea, RPC connection/reconnect,
   UI attach, reducer, renderer, input, mouse, ResizeObserver, font/theme
   subscription, visibility, focus, and disposal.
2. Add a bounded registry like `terminal-instance-registry.ts` for E2E and
   Search location calls. Expose buffer text, cursor, dimensions, diagnostics,
   focus, literal input, and open-location operations without reading pixels.
3. Create `NeovimPanel.tsx` as a thin lifecycle/status adapter. It receives the
   existing ToolUse output and never launches a process.
4. Animate starting -> ready, reconnect, failed, and exited overlays with current
   motion tokens. Add reduced-motion/reduced-transparency behavior.
5. Add explicit `data-yaade-neovim-*` hooks, including renderer=`webgl2`, status,
   generation, canvas, input, and surface.
6. Add package exports without changing existing source-based export rules.

**Verify**:

```sh
pnpm --filter @yaade/ui test
pnpm --filter @yaade/ui typecheck
```

Expected: unit tests pass; mounting/unmounting a panel only attaches/detaches a
UI channel.

### Step 7: Integrate the standalone ToolKind into the primary Session shell

1. Add the lazy renderer entry, icon maps, title fallback, launchers, context
   menu, switcher, empty tiles, and pane tiles.
2. Update `createTool` to construct `NeovimToolInput` and allow returning the
   created ToolUse for Search integration.
3. Add `Mod-k e` / `tool.newNeovim` in the canonical catalog and route it in
   `runPrefixCommand`. Update HUD/keymap tests; do not add aliases.
4. Generalize native input-surface detection and double-prefix literal dispatch.
5. Add Neovim registry methods to `window.__yaadeAgent` for deterministic E2E:
   `getNeovimText`, `getNeovimCursor`, `getNeovimDims`,
   `getNeovimDiagnostics`, and `focusNeovim`. Keep these buffer/model-backed,
   never pixel-scraped.
6. Keep `editor` disabled and hidden exactly as before.

**Verify**:

```sh
pnpm --filter @yaade/app test
pnpm --filter @yaade/app typecheck
pnpm validate:keybindings
```

Expected: all pass; the keymap has no reserved/risky new direct chord and all
closed `Record<ToolKind, ...>` maps are exhaustive.

### Step 8: Move Search file opening to the standalone Neovim tool

1. Implement the matching-checkout reuse/create/focus workflow.
2. Queue one newest location while a newly created surface attaches.
3. Replace Search's nested TerminalPanel path with the callback.
4. Delete old auxiliary PTY helper code and cleanup branches.
5. Update unit and E2E expectations: Search remains visible in one pane and the
   standalone Neovim ToolUse opens/reuses another pane/server.

**Verify**:

```sh
pnpm --filter @yaade/app test
pnpm exec playwright test --project=web-e2e tests/electron/neovim-tool.electron.spec.ts tests/electron/tool-sessions.electron.spec.ts
```

Expected: all pass; selecting a second Search hit reuses the same Neovim ToolUse
and generation rather than starting another process.

### Step 9: Add end-to-end, visual, and performance verification

Create `tests/electron/neovim-tool.electron.spec.ts` with these scenarios:

1. Launcher/HUD creates a `kind: "neovim"` ToolUse and WebGL2 surface.
2. Initial fake-server text is present in the model; canvas has nonzero size;
   no empty/error state is visible.
3. Keyboard typing and bare Escape reach Neovim; `Mod-k e` is captured by the
   shell; double prefix sends the literal control key.
4. IME commit does not duplicate; browser paste reaches `nvim_paste` once.
5. Resize changes Neovim grid dimensions; two pane Neovim ToolUses have distinct
   server instance ids/generations.
6. Session/Window switch and browser reload preserve the same server instance
   and reconnect to a full grid.
7. Project/worktree change restarts generation and uses the new checkout.
8. Closing the ToolUse removes the runtime; a clean `:qa`/mock exit shows an
   exited state and Restart works.
9. Search result opens/reuses standalone Neovim and preserves Search results.
10. Dark and light theme switches change model-resolved palette without
    restarting Neovim.
11. WebGL context loss/restore rebuilds and repaints.
12. WebGL2 unavailable renders an actionable semantic error, not Canvas fallback.

For every visible case, attach screenshots in dark and light at 1440x900 and at
least one 390x844 layout. Assert the resulting state as well as the interaction.
Capture console/page/request errors before navigation and require zero new
errors. Use model hooks for text/cursor and DOM selectors for chrome/status; do
not use OCR or query echoes as proof.

Add `tests/bench/neovim-render.bench.ts` and budgets:

| Budget name | median | p95 | p99 |
| --- | ---: | ---: | ---: |
| `neovim-first-frame` | 250 ms | 500 ms | 750 ms |
| `neovim-input-to-paint` | 16 ms | 24 ms | 32 ms |
| `neovim-redraw-10k-cells` | 16 ms | 32 ms | 50 ms |

Benchmark a production build or the repository's normal bench harness, warm the
shader and atlas before steady-state samples, record CPU frame time and uploaded
bytes, and assert that an idle Neovim surface schedules no continuous frames.

**Verify**:

```sh
pnpm exec playwright test --project=web-e2e tests/electron/neovim-tool.electron.spec.ts
pnpm exec playwright test --project=bench tests/bench/neovim-render.bench.ts
```

Expected: all scenarios and budgets pass without skips under the mock server.
Optionally run one manual smoke against real local Neovim, but kept tests must
not depend on the operator's config/plugins.

### Step 10: Documentation and full gates

1. Update `README.md`: Neovim in the tools table, WebGL2 rendering, `Mod-k e`,
   Search reuse behavior, Neovim version prerequisite, process lifetime, browser
   reload vs host restart, and current theme/font integration. Preserve the
   uncommitted liquid-material wording.
2. Update root `AGENTS.md` with the new ToolKind, host service, WS route, renderer
   key files, invariants, tests, and diagnostics.
3. Update `packages/yaade-ui/AGENTS.md` with the Neovim public surface and GPU
   rules while preserving its uncommitted Apple-inspired material edits.
4. Run all gates and inspect screenshots, not just their existence.

**Verify**:

```sh
pnpm -r typecheck
pnpm lint
pnpm test
pnpm test:e2e
pnpm test:bench
pnpm build
git status --short
```

Expected: all commands exit 0. `git status` lists only intentional feature files,
this plan/index, and the operator's preserved pre-existing edits.

## Test plan

### Contract/unit tests

- RPC schema accepts Neovim input/output and rejects mismatch.
- SQLite generic store round-trips Neovim output and generation.
- Endpoint name is short, private, deterministic per generation, and cleaned.
- Lifecycle handles spawn-ready-exit-restart-cancel-archive-context-change-close.
- Msgpack streaming handles split and combined frames.
- RPC request ids/timeouts/errors/cleanup are bounded.
- Linegrid handles repeat/highlight carry, wide Unicode, scroll overlap, resize,
  clear, dirty rows, flush transactions, malformed/unknown events.
- Input maps platform modifiers, special keys, literal `<`, IME, paste, mouse.
- Atlas packing never overlaps, respects bounds, and rebuilds deterministically.
- Theme group mapping uses `YaadeTheme` roles and preserves unknown explicit
  plugin colors.

### Integration tests

- Dedicated WS origin and generation gates.
- Raw binary bytes make a round trip through the mock Neovim server.
- UI disconnect does not kill process; process exit does update ToolUse.
- Two ToolUses never share process identity.
- Backpressure closes and reconnects to a fresh complete redraw.

### E2E/visual tests

Use the twelve scenarios in Step 9. Follow repository policy: visible changes
must be verified in Playwright, keyboard actions use the shell-prefix helper,
and effects are asserted through model/host state, not only screenshots.

### Performance/memory tests

- First server-ready -> first painted flush.
- Key dispatch -> flush -> next paint.
- 10k-cell full redraw and 1k dirty-cell update.
- Repeated theme switch without atlas leak.
- 100 create/connect/disconnect cycles plateau after GC and leave zero host
  children/endpoints.
- Idle surface frame count stays flat.

## Done criteria

All must hold:

- [ ] `"neovim"` is a first-class ToolKind with matched schema input/output.
- [ ] Two live Neovim ToolUses produce two distinct host server instances.
- [ ] Renderer mount/unmount never calls process spawn.
- [ ] Browser reload preserves server instance id/generation and restores grid.
- [ ] Cancel/archive/context-change/host-close leave no Neovim child or endpoint.
- [ ] Neovim redraw bytes never enter EventHub, SQLite, React state, or
      `ToolSessionStore`.
- [ ] `data-yaade-neovim-renderer="webgl2"` is present in the running surface.
- [ ] No Canvas 2D final-display fallback exists.
- [ ] New WebGL code batches instanced draws and reuses buffers/textures.
- [ ] New caches/maps/queues all have explicit bounds or ToolUse-scoped cleanup.
- [ ] Theme/font changes repaint without restarting the server.
- [ ] New UI uses semantic/material/motion/type tokens and Lucide only.
- [ ] `Mod-k e` appears in the canonical HUD and no reserved direct chord was added.
- [ ] Bare Escape and normal Neovim input work in a focused surface.
- [ ] Search opens/reuses a standalone matching-checkout Neovim pane.
- [ ] `rg "search-neovim-sessions|nvimEditCommand" packages/yaade-app/src/tools`
      returns no matches after migration.
- [ ] Focused and full typecheck, lint, unit, E2E, bench, and build commands exit 0.
- [ ] Dark/light desktop and mobile screenshots were actually reviewed.
- [ ] No unrelated/pre-existing edits were reverted.
- [ ] `plans/README.md` marks this plan DONE only after every gate passes.

## STOP conditions

Stop and report instead of improvising if:

1. Any pre-existing uncommitted liquid-material or split-controls-only edit would
   need to be reverted or rewritten wholesale.
2. The implementation appears to require Rust, Electron, Tauri, WebGPU, a native
   wrapper, or a browser extension.
3. A proposed design starts Neovim from React or creates more than one process
   for one ToolUse because of remounts.
4. The only way forward seems to put redraw/editor text in React state,
   EventHub, JSON RPC, or SQLite.
5. The local Neovim API metadata contradicts the attach/event assumptions in
   this plan. Report the exact metadata/docs difference and update the protocol
   design before coding around it.
6. The private socket path cannot be made short/private on a supported platform.
7. WebGL2 is unavailable in the project's Chromium E2E environment. Do not add a
   Canvas fallback to make tests green; report environment details.
8. A step's verification fails twice after one focused correction.
9. Search integration would require extending legacy mux/project surfaces.
10. The change appears to need an out-of-scope global keybinding or browser-
    reserved direct chord.
11. A required codec or browser API cannot operate without unsafe `any`/casts at
    external boundaries. Simplify the boundary or add a proper decoder.
12. Full E2E reveals process leaks, duplicated input, stale grids after reconnect,
    or unbounded WS buffering.

## Maintenance notes

- `ext_multigrid`, external popup/cmdline/messages, and collaborative/multiple UI
  clients should be separate future plans. They change composition and focus
  semantics substantially.
- Keep the ToolUse id as the server lifetime key. Pane ids are layout details and
  may change during docking.
- A future authenticated remote mode must authenticate the dedicated Neovim WS
  upgrade exactly like HTTP and generic WS; origin checking alone is not remote
  security.
- A future host-surviving process daemon must replace the process owner beneath
  `NeovimHost` without changing ToolUse or renderer identity.
- Reviewers should scrutinize child cleanup, socket path security, WS bounds,
  Msgpack decoder bounds, grid scroll overlap, IME duplication, GL context loss,
  atlas growth, idle rAF behavior, and preservation of the operator's existing
  design edits.
- Do not infer performance from debug/dev mode. Keep raw benchmark numbers and
  hardware/browser details with the change when reporting completion.
