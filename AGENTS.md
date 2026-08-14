# AGENTS.md — YAADE

Guide for AI agents and contributors working in this repo.

## What YAADE Is

**YAADE is a browser-only IDE for a local or remote machine.**

The app opens at `/` as a **Session shell**: top-level Session tabs, each an
ordered collection of **ToolUses** (Agent / Terminal / Search). Project and
checkout belong to each ToolUse. Opening a ToolUse mounts its renderer in the
main viewport — terminals keep PTYs alive on the host across tab switches and
reloads.

```
http://localhost:5174/                     → Session shell
http://localhost:5174/?s=ses-…&u=use-…     → Session + ToolUse deep link
http://localhost:5174/dev/yaade            → legacy project path (compat)
http://localhost:5174/dev/yaade?s=ses-…    → legacy project-session (compat)
```

Three consequences still drive every design decision:

1. **`/?s=&u=` is the Session identity.** One browser tab can hold many
   Sessions; each ToolUse owns its own project/checkout. Legacy
   “pathname = project” URLs remain for one release of compatibility.
2. **The browser is a hostile host.** It owns most keyboard chords, it can kill
   the tab at any moment, and it gives us no native window. See
   [Keyboard architecture](#keyboard-architecture) — this is the single most
   common source of bugs in this codebase.
3. **The host outlives the tab.** PTYs live in the host process, not the page.
   Closing or reloading a tab must not kill a shell.

**Hard policy: no Rust / no Tauri / no Electron.** The host is TypeScript
(`apps/host-server` + `@yaade/node-host`). Do not add `.rs`, `Cargo.toml`, Tauri
crates, or an Electron shell.

### Product status (2026-08)

The app pivoted from Mission Control → bare mux → project/session IDE →
**Tool Session shell** (Sessions + ToolUses). Consequences you will trip over:

| Thing | Status |
| --- | --- |
| `packages/yaade-app/src/AppRoot.tsx` | **Router.** `/` (+ home-relative legacy paths) → `ToolSessionApp`; `/_project/*` and HQ → legacy shell. |
| `packages/yaade-app/src/tools/` | **Primary shell.** Sessions, ToolUses, in-pane combobox config, renderers. |
| `packages/yaade-app/src/project/` | Legacy project landing — kept for `/_project` compat; do not extend. |
| `packages/yaade-app/src/mux/MuxApp.tsx` | Legacy session workspace — kept for `/_project` compat; do not extend. |
| `packages/yaade-app/src/App.tsx` (~3.3k lines) | **Legacy Mission Control. Not mounted.** Kept for reference; do not extend. |
| `tests/electron/tool-sessions.electron.spec.ts` | Required Session/ToolUse parity suite (19 scenarios). |
| `NEXT.md` | Migration plan; cutover deletes of project/mux wait until remaining legacy specs are retired. |

When a task touches something in the "legacy / dead" rows, ask before
extending it — deleting is usually the right answer.

---

## Monorepo Layout

```
yaade/
├── apps/
│   ├── yaade/                  Vite frontend shell (proxies /api, /ws to host)
│   └── host-server/            Effect host (HTTP/WS RPC + PTY Layers)
├── fixtures/
│   └── sample-workspace/       Fixture project for E2E
├── packages/
│   ├── yaade-rpc/              Effect Schema IPC + TaggedErrors + WorkspaceSession
│   ├── yaade-shared/           URIs, Emitter, panel primitives
│   ├── yaade-node-host/        Node FS/git/search/PTY (+ Effect terminal scope)
│   ├── yaade-host-client/      Effect HostClient + Promise shim → HTTP/WS
│   ├── yaade-panels/           PanelTree — splits, tabs, resize, serde
│   ├── yaade-workspace/        WorkspaceService, commands, keymaps, browser-reserved keys
│   ├── yaade-agent-telemetry/  Passive CLI agent telemetry + notifications
│   ├── yaade-agents/           Compatibility export for agent telemetry
│   ├── yaade-monaco/           Monaco editor host + model registry (lazy in mux)
│   ├── yaade-lsp/              Language server client pool → Monaco providers (lazy)
│   ├── yaade-ui/               Panel dock, TerminalPanel, overlays, themes
│   └── yaade-app/              Root React app — ToolSessionApp (+ legacy mux/project)
├── tests/
│   ├── electron/               E2E specs (Playwright `web-e2e` project)
│   ├── shell/                  launchWeb() against the TS host
│   └── bench/                  UX latency benchmarks
├── package.json                turbo scripts
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

`tests/electron/` is a historical directory name — there is no Electron. The
specs run in headless Chromium against the TS host.

### Package dependency direction

```
yaade-rpc + yaade-shared  ←  yaade-node-host, host-client, host-server
yaade-shared              ←  yaade-panels, yaade-workspace, yaade-node-host
yaade-workspace + yaade-panels + yaade-ui  ←  yaade-app
yaade-app + yaade-host-client              ←  apps/yaade (Vite)
yaade-node-host           ←  apps/host-server

```

Keep imports acyclic. Lower layers must not import React.

---

## Commands

```bash
pnpm install          # workspace install
pnpm dev              # host-server + Vite
pnpm -r typecheck     # all packages (TypeScript 7)
pnpm test             # unit tests (node:test via tsx) across packages
pnpm test:e2e         # Playwright web E2E (headless Chromium)
pnpm test:bench       # UX latency benchmarks (tests/bench/)
pnpm build            # SPA + dist/yaade server binary
```

Unit tests use **`node:test` + `node:assert/strict`**, run through `tsx --test`
— *not* vitest. `@yaade/app` lists its test files explicitly in `package.json`;
add new ones there or they will not run.

Monorepo uses **TypeScript 7** (`^7.0.2` at root; `pnpm.overrides` in
`pnpm-workspace.yaml` pins one version).

---

## The URL → workspace contract

`packages/yaade-app/src/url-workspace.ts` is the routing layer.

- The **project path** is `location.pathname`, interpreted **relative to `$HOME`**.
  `/dev/foo` → `{home}/dev/foo`. `/` → `$HOME`, unless the host `launchConfig`
  names a workspace.
- The **session id** is `?s=<id>` (`sessionIdFromSearch` / `pushSessionUrl` /
  `popToProjectUrl`). Bare pathname → ProjectPage; with `?s=` → SessionWorkspace
  (`MuxApp`). History API keeps PTYs alive across project ↔ session transitions.
- `isReservedWorkspacePathname()` excludes `/api`, `/ws`, `/health`, `/@`,
  `/node_modules`, `/src`, `/assets`, and single-segment asset filenames.
- `resolveHomeRelativePath()` collapses `..` so a pathname can never escape
  `$HOME`. The host independently enforces `allowedRoots` — do not rely on the
  client check alone.
- `urlPathForProjectRoot()` is the reverse, used by "open in new browser tab".
- SPA fallback: Vite in dev, `serveStatic` → `index.html` in prod
  (`apps/host-server/src/server.ts`).

**Known gaps (do not assume these work):**

- Paths **outside `$HOME` cannot be expressed in the URL** — `urlPathForProjectRoot`
  returns `/` for them, so "open in new tab" silently opens home instead.
- Changing the project via the CD overlay does not rewrite `pathname` (only
  session `?s=` uses history today), so a CD away from the URL project leaves
  the address bar stale for the project root.
- A nonexistent path is not validated at boot: the project page may load empty
  or MuxApp may fail to open the workspace folder.

### Session persistence

Primary store: SQLite `project_sessions` (see `apps/host-server/src/persistence.ts`).

Schema/types: `packages/yaade-rpc/src/project-session.ts`. Client:
`packages/yaade-app/src/project-session-client.ts` (debounced single-writer queue,
400 ms, backoff retry, `flush()` on `pagehide`).

- Keyed by session `id` (`ses-…`). Indexed by `(machine, project_path, updated_at)`.
- Each row has `cwd_path` (project root or worktree), optional
  `worktree_branch` / `worktree_path`, and a layout `payload_json`.
- The server **strips `ptyId` from every leaf on save** — a host restart
  invalidates them. Reattach across a reload only works while the PTY is still
  alive in host memory.
- Routes under `/api/v1/project-sessions` validate `project_path` and `cwd_path`
  with `pathAllowed()` (403 otherwise).
- One-time migration copies legacy `workspace_sessions` rows into
  `project_sessions` (`title = "Session 1"`). Legacy `GET/PUT /api/v1/workspace-session`
  remains for older clients but the mux shell writes project sessions only.

Worktrees live at `~/.yaade/worktrees/<project>/<branch>/`
(`apps/host-server/src/worktree-path.ts`). Creation is worktree-first, row-second.

---

## Shell architecture (mux)

Render tree, root to a terminal:

```
main.tsx → RegistryProvider → AppErrorBoundary → AppRoot
  ├─ ProjectPage          (?s= absent or present) — Overview / Worktrees menu / History; mux embeds in-page
  └─ MuxApp               embedded in ProjectPage when a worktree/Main session is open
       └─ TooltipProvider → AppShell (footer = WhichKeyPanel when a prefix is pending)
          └─ TabDndRoot → [data-yaade-shell="mux"]
             ├─ MuxWindowView → PanelDock → PanelLeaf
             │    ├─ MuxPaneChrome        (title / editor buffer tabs, drag, split/zoom/close)
             │    └─ TerminalSlot         ← empty placeholder, measured only
             │       OR GitWorkspace / MuxEditorPane (lazy Monaco)
             └─ MuxTerminalLayer          ← absolutely positioned over the slots
                  └─ TerminalPanel → xterm
```

**Terminals are not in the dock tree.** The dock renders empty measured slots;
`MuxTerminalLayer` paints real `TerminalPanel` hosts over them. This keeps xterm
mounted across `PanelDock` remounts (split, retile, drag) so a shell never
resets. A `MutationObserver` watches the dock only — never the xterm hosts — so
terminal DOM churn cannot thrash layout.

- Layout model is `YaadePanelTree` (`@yaade/workspace`) over
  `PanelTree` (`@yaade/panels`) — the same model the legacy shell used.
- `MAX_MOUNTED_TERMINALS = 6`, LRU over focused panes. Panes beyond that stay
  registered as sessions but their xterm is unmounted; unmeasured panes render
  at 0×0.
- Pane kinds are `terminal`, `git`, and `editor`. Zoom is a toggle (`mux.zoomPane`).
- **Editor panes are multi-tab groups.** Tab ids are `file://` / `untitled:` URIs.
  Quick open, project search, and LSP goto-definition activate or push a tab in
  the focused editor group (they do not always split a new pane). Terminal/git
  panes stay one tab each. Close buffer ≠ close pane; last buffer empties the group.
- Keyboard pane focus is geometric (`findFocusNeighbor` over measured slot boxes).

---

## Keyboard architecture

**Read this before touching any keybinding.** Getting it wrong produces
shortcuts that silently do nothing for real users while passing E2E.

### The three buckets

| Bucket | Examples | Rule |
| --- | --- | --- |
| **Reserved** — browser consumes it before the page sees a `keydown`, or ignores `preventDefault()` | `Mod-T/N/W/Q`, `Mod-Shift-N/T/W`, `Mod-L`, `Mod-1..9`, `Ctrl-Tab`, `Cmd-Opt-←/→`, `Mod-+/-/0`, F11, F12, `Mod-Opt-I` | **Never bind.** Binding one is a silent no-op. |
| **Risky** — Chromium delivers it, another browser or an expected behaviour takes it | `Mod-k` (Chrome omnibox), `Mod-Shift-p` (Firefox private window), `Mod-s/p/f/d/o/r/g` | Bind only with a deliberate reason. |
| **Free** | prefix chords, `Mod-,`, `Alt-*` | Fine. |

`packages/yaade-workspace/src/browser-reserved-keys.ts` encodes this.
`KeymapService.registerUser` / `registerExtension` **throw** on a reserved chord
outside production. If you hit that error, do not work around it — move the
action behind the prefix.

> **Playwright cannot catch this class of bug.** CDP `Input.dispatchKeyEvent`
> bypasses browser chrome, so a spec pressing `Meta+KeyT` passes while the real
> app does nothing. Never validate a chord's *availability* with an E2E test;
> that is what the reserved-key guard is for.

### The prefix key

Because nearly every chord a multiplexer wants is reserved, shell actions live
behind a tmux-style prefix. Press **`Ctrl-a`** twice inside xterm to send a
literal `^A` (tmux `send-prefix`).

**Canonical grammar** is the Tool Session shell. Source of truth:
`packages/yaade-app/src/tools/tool-session-keymap.ts`. One command → one
prefix key. Do not add aliases.

| `Ctrl-a` + | Action | | `Ctrl-a` + | Action |
| --- | --- | --- | --- | --- |
| `a` | New Agent | | `j` / `k` | Next / previous tool |
| `t` | New Terminal | | `u` | Switch tool (list) |
| `s` | New Search | | `w` | Switch session (list) |
| `e` | New Editor | | `1`–`9` | Jump tool by index |
| `g` | New Git | | `c` | New session |
| | | | `b` | Toggle navigation sidebar(s) |
| | | | `x` | Close tool |
| | | | `Shift-X` | Close session |
| | | | `,` | Settings |

Direct chords: **`Mod-,` only** (settings — OS convention). Settings is the
sole dual-path (`Ctrl-a ,` stays on the HUD). Context-local: `Mod-p` opens
Quick Open while Editor or Search is focused (VS Code muscle memory).

Do **not** bind `Mod-k` or `Mod-Shift-p` in the Tool Session shell. Both are
risky, and both were aliases of prefix commands (`u` / `w`).

`TOOL_SESSION_PREFIX_BINDINGS` feeds the WhichKey HUD, so on-screen hints
cannot drift from what is bound.

**Legacy mux** (`/_project`) keeps its own table in
`packages/yaade-app/src/mux/mux-keymap.ts` (`MUX_PREFIX_BINDINGS`). Direct
chords there remain `Mod-Shift-p` (palette) and `Mod-,` (settings). Do not
extend that table — the mux shell is compat-only.

### Dispatch pipeline

`packages/yaade-app/src/hooks/useGlobalKeymap.ts` — a **window capture-phase**
`keydown` listener.

1. Any overlay open → bail (overlays own their own keys).
2. Radix context-menu content → bail.
3. Inputs/textareas → bail, except the xterm textarea and Monaco chrome.
4. Terminal branch (`terminalFocus || inXterm`, and `terminalFocus` is always
   `true` in mux): `Mod-Shift-p` is hard-wired so the palette never depends on
   the `registerUser` → revision → snapshot pipeline; everything else goes
   through `dispatchKeyBinding`.
5. Otherwise `dispatchKeyBinding(e, { allowEditor: true })`.

Chord resolution lives in `context-keys.ts` (`resolveKeydownBinding`,
`startChord`, `CHORD_TIMEOUT_MS = 2500`).

**Invariants:**

- A matched binding calls `preventDefault()` **and** `stopPropagation()`. Without
  the latter, a capture-phase match still reaches xterm — that is how `Ctrl-a`
  would leak through as readline `beginning-of-line`.
- **Never bind bare `Escape` globally.** vim, less and fzf all need it. A global
  Escape binding (mux unzoom) previously swallowed it for every pane; the
  surviving binding is gated on *a pane being zoomed* **and** focus being outside
  `.xterm`. Regression test: `tests/electron/mux.electron.spec.ts` →
  "Escape reaches the terminal".
- Do not re-add `Mod-=` / `Mod--` font-zoom hard-wiring. Browser zoom is not
  cancellable; use the prefix.

---

## Host server & IPC

Wired by `@yaade/host-client` `createWebTransport()` → `createYaadeApi()`;
types in `@yaade/workspace` (`YaadeHostAPI` name retained for stability).

| Channel | Purpose |
| --- | --- |
| `fs:readFile`, `fs:writeFile`, `fs:readDir`, `fs:stat` | File URIs (`file://...`) |
| `git:isRepo`, `git:status`, `git:diff` | Git CLI wrappers |
| `git:worktreeList`, `git:worktreeAdd`, `git:worktreeRemove` | Git worktree lifecycle |
| `git:defaultBranch` | Resolve HEAD / default branch |
| `lsp:start`, `lsp:stop` | Spawn language server, WS bridge |
| `terminal:create/attach/write/resize/dispose` | PTY lifecycle |
| `notifications:*` | Notification center CRUD + WS `notifications:event` |
| `POST /api/v1/notifications/ingest` | Provider hook ingest (Claude/Codex Stop) |
| `GET/POST /api/v1/project-sessions` | List / create project sessions |
| `GET/PUT/DELETE /api/v1/project-sessions/:id` | Load / save layout / delete (+ optional worktree remove) |
| `GET/PUT /api/v1/workspace-session` | Legacy single-layout persistence (migrated → project_sessions) |
| `GET /api/v1/system` | `homeDir`, `machineHostname`, `launchConfig` |

Transport: HTTP `POST /api/v1/rpc` for requests, `/ws` for events and hot
terminal ops. Reconnect uses `?since=${lastSequence}` with exponential backoff.

### Terminal streaming

Deliberately engineered; do not "simplify" it:

- Host batches PTY output at 64 KiB / 4 ms, with an immediate flush for the
  first ≤32-byte interactive chunk.
- Binary WS frames for `terminal:data`.
- VS Code-style flow control: pause above 100k unacked chars, resume below 5k.
- Per-PTY 2 MB replay ring; `attach()` returns replay + `lastSequence`, and the
  client applies a replay floor to drop duplicates.
- Client coalesces writes with rAF, microtask for ≤256-char interactive chunks.
- PTY output **never** flows through React state.

### Lifetime rules

| Event | PTY |
| --- | --- |
| WS close / tab closed | **Survives** (unsubscribe only) |
| `terminal.dispose` (close pane) | Killed |
| Process exit | `terminal:exit`, auto-disposed after 90 s |
| Host shutdown | All killed |

Caps: 64 PTY entries, 2 MB WS buffered bytes (slow clients get closed 1013),
`EventHub` history 1024 events / 16 MB (`terminal:data` is live-only — not retained).

### Security posture (remote is NOT ready)

- **No authentication on HTTP or WS.** None. No tokens, no sessions.
- Protection is only: startup refuses a non-loopback bind, `pathAllowed()` against
  `JET_ALLOWED_ROOTS` (default `$HOME`), and a WS origin check that allows
  loopback or an exact `Origin.host === Host` match.
- Putting this behind a reverse proxy to make it "remote" removes both, and any
  reachable client gets a shell as the host user.

**A shared-secret token checked on both HTTP and the WS upgrade is a hard
prerequisite before shipping remote.**

---

## Theming

- `defaultJetTheme` + CSS vars via `applyJetThemeCss()`; `applyColorScheme`
  toggles `.dark` and sets `--yaade-*` vars.
- Tailwind v4 with `@source` in `packages/yaade-ui/src/styles/globals.css` — it
  must scan sibling packages or position/layout utilities are not emitted.
- Bundled themes in `packages/yaade-ui/src/theme/bundled.ts`.
- Appearance state (`jet-theme-id`, `jet-font-size`, `jet-color-scheme`) persists
  in `localStorage` via `useAppearanceSettings.ts`.
- Design-system rules (tokens, typography scale, motion, shadcn primitives) live
  in `packages/yaade-ui/AGENTS.md`. Read it before adding UI.

---

## Agent visual verification (MANDATORY)

Any change that can affect what the user sees — UI, layout, theming, commands,
keybindings, panes, palette, error/status messages — MUST be verified with
Playwright before the task is reported done. Typecheck and unit tests are
necessary but not sufficient.

Specs live in `tests/electron/*.electron.spec.ts`. `launchJet()` → `launchWeb()`
starts `@yaade/host-server` + Chromium. `YAADE_E2E=1` unless `YAADE_HEADED=1`.
Playwright runs `workers: 1`, `fullyParallel: false`; override with
`PLAYWRIGHT_WORKERS=N`. Headed: `YAADE_HEADED=1 pnpm test:e2e`.

**Verification preference (strict):**

1. DOM/text assertions on scoped selectors.
2. `window.__yaadeAgent.getState()` — workspace path, palette flag, pane kinds,
   font size.
3. List helpers — `expectLayout`, `expectNoOverlap`, `expectRowTextVisible` on
   `[data-yaade-list-panel="…"] [data-yaade-list-item]`.
4. `pnpm test:bench` for latency-sensitive changes.

### Anti-tautology rules for list/search UIs (MANDATORY)

Query echoes are worthless as proof: asserting `export` in `body` after typing
`export` passes even when the result list is empty. Every list/search spec MUST
include:

1. Row-count assertion — `expectLayout` with `minItems >= 1` on the scoped panel.
2. Positive content — a needle that only appears in rendered rows (fixture
   filename, path segment, `:` line separator). Never the typed query alone.
3. Negative empty-state — `not.toContainText("No results")` when a hit is expected.
4. `expectNoOverlap` + `expectRowSpacing` when ≥2 rows are expected.
5. `expectRowTextVisible` on the scoped selector.

Always scope with the panel data attribute so unrelated lists cannot satisfy the
assertion by accident.

### Keyboard specs

Drive mux actions through `pressMuxPrefix(page, "KeyZ")` from
`tests/electron/_launch.ts`, never a raw `Meta+…` chord. Assert *effects on the
PTY* (via `waitForTerminalText`) when testing that a key does or does not reach
the terminal — that is the only assertion that would have caught the Escape bug.

### Host IPC

Any change to `fs:*`, `git:*`, `lsp:*`, `search:*`, `agents:*`, or terminal PTY
MUST have a sibling spec in `tests/electron/`.

### Programmatic control (`window.__yaadeAgent`)

```javascript
await window.__yaadeAgent.waitForReady()
await window.__yaadeAgent.createProjectSession?.({ title: "…" })
await window.__yaadeAgent.openProjectSession?.(id)
await window.__yaadeAgent.backToProject?.()
await window.__yaadeAgent.executeCommand("mux.splitRight")
window.__yaadeAgent.getState() // includes route, sessionId, sessionCwd
window.__yaadeAgent.getPerfMeasures() // User Timing measures (jet:*)
```

`launchJet()` opens a session by default (`waitForMux`). Pass
`{ projectPage: true }` for specs that assert the project landing page.

---

## Coding Conventions

1. **Minimal scope** — smallest correct diff; no drive-by refactors.
2. **Match existing style** — ESM `.js` extensions in TS imports, strict TS, no
   `@types/node` in `@yaade/shared` or `@yaade/workspace` (reach `process` via
   `globalThis` if you must).
3. **URI discipline** — `pathToFileUri` / `fileUriToPath` from `@yaade/shared`;
   avoid `process.platform` in shared packages.
4. **Panel mutations** — clone tree → mutate → commit (immutable-ish updates).
5. **Exports** — packages expose `./src/index.ts` directly. Every `exports`
   condition (`types`, `import`, `default`) must point at source. Pointing
   `import`/`default` at `./dist/*` silently ships stale JavaScript: `tsc` checks
   `types` against source, so typecheck stays green while the app runs whatever
   was last compiled. If a typecheck error mentions a symbol that clearly exists,
   suspect a stale `dist/` before editing the export list.
6. **Commits** — only when the user asks.
7. **No setup panes.** Creating a ToolUse mounts its renderer immediately.
   Project, checkout, provider, and other options are comboboxes in that pane.
   Do not add a pre-launch form, dialog, or staged wizard.
   Changing project or agent provider must persist, then restart the underlying
   process. Never fail that RPC for a stale revision. A failed relaunch marks
   the ToolUse failed but does not roll back the new project/provider.

---

## Adding a Feature (checklist)

1. Decide layer — shared / panels / workspace / ui / app / host-server.
2. Add types to `@yaade/shared` or `@yaade/rpc` if cross-cutting.
3. Register the command in `MuxApp`'s command effect.
4. If it needs a shortcut, add it to `TOOL_SESSION_PREFIX_BINDINGS` — do **not**
   invent a new `Mod-` chord or a second key for an existing command. Legacy mux
   only: `MUX_PREFIX_BINDINGS`.
5. `pnpm -r typecheck`.
6. Unit test with `node:test`; register the file in `package.json` for
   `@yaade/app`.
7. `pnpm test:e2e` (+ `pnpm test:bench` when perf-sensitive).

---

## Known gaps / next work

Ordered by severity. Items reflect an August 2026 review after the session pivot.

### P0 — blocks the product promise

- [ ] **Auth for remote.** Token on HTTP + WS upgrade. Nothing else about
      "remote IDE" is safe to ship first.
- [ ] **Entry UX.** Path still comes from the address bar (plus host
      `launchConfig`). Needs resolve → validate → error-or-open, plus a
      recent-projects list for first-run when the URL is `/`.
- [ ] **URL cannot express paths outside `$HOME`.** CD away from the URL
      project still leaves `pathname` stale.

### P1 — correctness

- [x] `terminal:data` excluded from `EventHub` history (live fan-out only;
      reconnect uses per-PTY `attach()` replay).
- [ ] WS terminal commands are fire-and-forget (`void runHostRpc` in
      `server.ts`) — a failed write or resize is invisible to the client.
- [ ] No timeout on HTTP RPC invokes; a wedged host leaves promises pending.

### P2 — UI/UX

- [ ] No roving tabindex across the tile grid (active pane has a focus ring;
      chrome controls reveal on `focus-visible`).
- [ ] Boot state is a bare "Loading…".
- [ ] Delete the dead shells: `App.tsx`, `MuxTabStrip`, `PanelTabBar`, and the
      ~29 skipped Mission Control specs.
- [ ] Optional README / recent-commits polish on the project page main column.

### P3 — hygiene (carried over, still valid)

- [ ] Virtualize `packages/yaade-ui/src/tabs/ExplorerTab.tsx`
      (`@tanstack/react-virtual` is already a dependency). Preserve
      `data-yaade-list-item` on rendered rows.
- [ ] `StatusBar` LSP trigger is a raw `<button>`; should use the shadcn `Button`
      ghost variant to inherit ring/focus tokens.
- [ ] `packages/yaade-ui/src/components/ui/sidebar.tsx` is ~730 LOC with most
      exports dead. Tree-shaken at build; delete only for source hygiene.

Backlog items that referenced `jet-codemirror`, `LocationListPanel`, or
`ExplorerPanel` were dropped — those files no longer exist.

---

## Key Files (start here)

| File | Why |
| --- | --- |
| `packages/yaade-app/src/main.tsx` | Entry: `createWebTransport` → `window.yaade`, mounts `AppRoot` |
| `packages/yaade-app/src/AppRoot.tsx` | `/` → ToolSessionApp; legacy routes otherwise |
| `packages/yaade-app/src/tools/ToolSessionApp.tsx` | Session shell composition |
| `packages/yaade-app/src/tools/tool-store.ts` | Normalized browser store (no PTY bytes) |
| `packages/yaade-app/src/tools/tool-session-routing.ts` | `/?s=&u=` parse/build |
| `packages/yaade-rpc/src/tool-session.ts` | Session/ToolUse contracts |
| `apps/host-server/src/tools/service.ts` | Host ToolService orchestration |
| `apps/host-server/src/tool-session-store.ts` | SQLite Sessions/ToolUses |
| `packages/yaade-app/src/mux/MuxApp.tsx` | Legacy mux shell (compat) |
| `packages/yaade-app/src/project/ProjectPage.tsx` | Legacy project landing (compat) |
| `packages/yaade-node-host/src/terminal.ts` | PTY batching, flow control, replay |
| `packages/yaade-node-host/src/search.ts` | Ripgrep/FFF search engine |

---

## Agent Anti-patterns

- Binding a browser-reserved chord (the guard will throw — heed it).
- Binding bare `Escape`, or matching a key without `stopPropagation()` in the
  terminal path.
- Using an E2E test to prove a keyboard shortcut is *available* — CDP bypasses
  browser chrome.
- Shipping UI/UX changes without `pnpm test:e2e`.
- Writing new tests with vitest; this repo uses `node:test`.
- Extending `App.tsx` or anything in the legacy Mission Control surface.
- Putting terminal output or editor document text in React state.
- Calling Node APIs from lower packages (use `window.yaade` / `@yaade/host-client`).
- Adding Rust / Cargo / Tauri / Electron back into the repo.
- Adding a setup pane, launch wizard, or staged form before a ToolUse renderer mounts.
- Failing a project or agent-provider combobox change. Persist the new value,
  restart the PTY, return the ToolUse. Do not throw `ToolUseConflict` on that path.
