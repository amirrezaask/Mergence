# YAADE Next: session tabs with composable ToolUses

> **Planning document only. Do not implement opportunistically while reading it.**
>
> This is a handoff for a smaller executor model. Complete the phases in order,
> run every gate, and stop when a STOP condition is reached. Do not add Rust,
> Tauri, Electron, or a second host process.
>
> **Planned at:** commit `85c6309` on 2026-08-12.
>
> **Drift check before implementation:**
>
> ```bash
> git diff --stat 85c6309..HEAD -- \
>   packages/yaade-rpc packages/yaade-shared packages/yaade-workspace \
>   packages/yaade-node-host packages/yaade-host-client packages/yaade-ui \
>   packages/yaade-app apps/host-server tests/electron README.md AGENTS.md
> ```
>
> `figma-mock.html` was untracked when this plan was written. Treat it as a
> visual reference, not as production source and not as a file to rewrite.
>
> ## Implementation handoff (updated after the first Tool Session shell)
>
> The contract, storage, host runtime, transport, browser store, and a first
> Tool Session shell are implemented. `/` now mounts the new Session UI while
> legacy project/mux routes remain available for compatibility. **This plan is
> not complete.** Treat the current UI as an MVP checkpoint, not the final
> cutover.
>
> ### Implemented
>
> - `packages/yaade-rpc/src/tool-session.ts`: branded `ses-`/`use-` IDs,
>   Session/ToolUse models, checkout/context unions, Agent/Terminal/Search input
>   and output unions, commands, events, search result contracts, and typed
>   runtime errors. Input/output and ToolUse kind pairing are schema-validated.
> - `packages/yaade-rpc/src/tool-session.test.ts`: schema round trips, malformed
>   IDs, all input/output members, pairing rejection, optional fields, and the
>   100-result event limit.
> - `apps/host-server/src/tool-session-store.ts`: `app_sessions`, `tool_uses`,
>   `tool_use_search_results`, indexes, schema migration 15, legacy project
>   session migration, terminal correlation, session/ToolUse CRUD, CAS updates,
>   and search result replacement/append/page operations.
> - `apps/host-server/src/tool-session-store.test.ts`: fresh DB, ordering,
>   idempotent migration, cascade-safe persistence, CAS conflicts, and paging.
> - `apps/host-server/src/host-runtime.ts`: constructs `ToolSessionStore` after
>   terminal persistence so existing PTYs can be correlated. The store is also
>   exposed through the Effect host tags/layers.
> - `apps/host-server/src/dispatch.ts`: transitional `tools:*` list/get/select,
>   session archive/restore, input update, search paging, and compatibility CRUD.
>   ToolUse create/cancel/restart/session archive and search input updates now
>   route through `ToolService`; terminal bytes remain on the specialized
>   terminal transport.
> - `packages/yaade-rpc/src/host.ts`,
>   `packages/yaade-host-client/src/{host-channels,create-yaade-api}.ts`, and
>   `packages/yaade-workspace/src/types.ts`: `tools:event`, Tool RPC channel
>   names, typed client methods, and `YaadeHostAPI.tools` plumbing.
> - `packages/yaade-app/src/tools/{tool-store,tool-session-routing}.ts`: initial
>   normalized external browser store with per-entity subscriptions, revision
>   filtering, batched search events, selection state, and `/?s=...&u=...`
>   route parsing/selection helpers. Their unit tests are registered.
> - `TerminalInstanceService` now persists nullable `tool_use_id` and its partial
>   unique index; PTY exits project back into ToolUse output/status.
> - `apps/host-server/src/tools/{model,errors,registry,context-resolver,process-driver,search-driver,service}.ts`:
>   runtime contracts, typed driver failures, a concrete closed v1 registry for
>   Agent/Terminal/Search, host-validated context resolution, shared
>   Agent/Terminal launch logic, cancellable/debounced SearchTool execution,
>   durable result batches, and ToolUse lifecycle orchestration.
> - Tool runtime lifecycle now uses one scoped Effect scope and per-search
>   fibers: superseded searches are interrupted/aborted, shutdown interrupts
>   active fibers before the terminal host stops, and startup reconciliation
>   resumes pending searches or marks missing PTYs disconnected.
> - `dispatch.ts` compatibility terminal/agent launch paths now call the shared
>   process driver. Existing terminal creation, restart, provider availability,
>   hook installation, PTY correlation, and launch idempotency remain covered by
>   the shared implementation.
> - `apps/host-server/src/effect/{tags,layers}.ts`: `ToolServiceTag` and
>   `ToolSessionStoreTag` are exposed from the single host layer. Startup
>   reconciliation marks missing process PTYs disconnected and resumes pending
>   searches.
> - `apps/host-server/src/tools/*.test.ts`: Main/path validation and an
>   end-to-end host-owned empty SearchTool lifecycle test.
>
> ### Important limitations of the current implementation
>
> - `ToolService` still exposes Promise-facing compatibility methods and wraps
>   them with Effect adapters. The registry is concrete and scoped search work is
>   fiber-owned, but the full driver contract is not yet a pure Effect
>   `Stream`/`PubSub` design for every runtime event. Do not expand the public
>   Tool API until typed lifecycle/error behavior has parity coverage.
> - SearchTool reuses `packages/yaade-node-host/src/search.ts`, debounces input,
>   aborts superseded searches, persists batches, emits reset/append events, and
>   supports load-more. It still needs dedicated stale-input, host-failure,
>   restart-recovery, and reconnect-gap tests.
> - `CreateToolUse` supports Main and existing/branch worktree resolution, but
>   managed-worktree cleanup and live-ToolUse checkout blockers are not exposed
>   as a complete user workflow.
> - Client channels and Promise adapters exist, including Tool events and
>   ToolUse-conflict decoding. Revision-gap refetch/reconciliation, complete
>   typed command decoding, and host-client-specific tests are still unfinished.
> - The normalized browser store and route parser now support revision filtering,
>   batched search events, selection, hydration, reconnect reconciliation, and
>   `/?s=...&u=...` routing. They are connected to the first shell, but not yet
>   to the final renderer registry or viewport cache.
> - `ToolSessionApp` is mounted at `/` with Session tabs, a ToolUse sidebar,
>   empty state, project selection, basic process rendering, and basic search
>   results. It is not yet the complete staged product flow.
> - Focused Tool Session E2E exists, but reload, PTY survival, Agent/Search,
>   worktree, reconnect, close-choice, LRU, mobile, and legacy URL parity specs
>   are still missing. Do not remove old HQ/project/mux specs or legacy tables.
> - The migration leaves legacy SQLite tables intact, and search-surface
>   migration plus complete project/checkout field preservation still need work.
>
> ### Verification passing after this checkpoint
>
> Verified at this checkpoint:
>
> ```bash
> pnpm -r typecheck
> pnpm --filter @yaade/host-client test
> pnpm --filter @yaade/host-server test
> pnpm --filter @yaade/app test
> pnpm --filter @yaade/app build
> pnpm exec playwright test --project=web-e2e tests/electron/tool-sessions.electron.spec.ts --timeout=60000
> git diff --check
> ```
>
> Current focused results: host-server 106 passing, host-client 21 passing, app
> 197 passing, and both Tool Session smoke tests passing. The production build
> completes with the existing large-chunk warnings. Full E2E, benchmark, lint,
> and final cleanup gates are not green; the broad Playwright run previously
> timed out in legacy HQ/git/LSP/mux scenarios.
>
> ### Next execution point
>
> 1. Add dedicated process-driver, SearchTool, and ToolClient tests for
>    cancellation, stale input, restart generations, PTY reconciliation,
>    pagination, host failure, event ordering, and reconnect-gap recovery.
> 2. Finish the staged New ToolUse flow: checkout targets, existing/isolated
>    worktrees, branch cleanup blockers, review/create state, provider input,
>    and typed inline retry/error states.
> 3. Add Session/ToolUse rename, reorder, archive/restore, close confirmation,
>    command palette, mobile drawer, and the new keyboard/agent-bridge API.
> 4. Add the UI registry, separate renderers, six-viewport keep-alive LRU,
>    Search virtualization/load-more, and preserve PTYs outside React/store
>    state.
> 5. Expand Playwright coverage for reload persistence, PTY survival, Agent and
>    Search flows, worktree isolation, reconnect, close choices, LRU eviction,
>    mobile layout, legacy URL compatibility, and search anti-tautology rules.
> 6. Add performance/startup-graph budgets, run all typecheck/lint/unit/E2E/bench/
>    build gates, then remove active project/mux surfaces and update README and
>    AGENTS only after parity passes.
>
> ## 1. Product contract

YAADE Next is one browser application containing multiple top-level **Session**
tabs. A Session is no longer a project workspace. It is an ordered collection
of **ToolUses**. A ToolUse is one invocation of a registered software-engineering
**Tool**, with durable input, output state, lifecycle, and an optional project /
checkout context.

The first version has exactly three public Tool kinds:

1. **AgentTool** — launches a supported agent CLI in a PTY.
2. **TerminalTool** — launches a shell in a PTY.
3. **SearchTool** — runs the existing project content search and streams result
   batches.

AgentTool and TerminalTool share the existing PTY/process infrastructure.
SearchTool reuses the current ripgrep/FFF implementation. The work is a domain,
persistence, transport, and shell reshaping—not a rewrite of the proven PTY or
search engines.

### 1.1 Terms that must be used consistently

- **Tool**: a registered capability definition and runtime driver. It validates
  input, starts or attaches work, accepts commands, emits events, and cleans up.
- **ToolUse**: one persisted invocation of a Tool. Sidebar rows represent
  ToolUses, not Tools.
- **Session**: one top-level tab containing ordered ToolUses and one selected
  ToolUse.
- **Project target**: the project chosen for one ToolUse.
- **Checkout target**: Main, an existing worktree, or an isolated worktree made
  for a branch. It belongs to the ToolUse, never to the Session.
- **Tool input**: schema-validated user intent. It is persisted and revisioned.
- **Tool output state**: the current durable/recoverable output snapshot. Large
  or high-frequency data may be stored behind a typed resource reference.
- **Tool event**: a revisioned state/output delta delivered asynchronously.

Do not reuse the existing `MuxToolKind` terminology from
`packages/yaade-app/src/mux/tool-pane.ts`; those are IDE panel kinds, not this
product-level Tool abstraction.

### 1.2 Required user behavior

- The app opens at `/`, showing a top session tab strip.
- `+` creates a new empty Session and opens the New ToolUse flow.
- Selecting a session updates the sidebar and main viewport without stopping
  any background ToolUse.
- The active Session sidebar lists its ToolUses with type, title, lifecycle
  status, project, and checkout/worktree.
- Selecting a ToolUse renders only that ToolUse in the main viewport.
- New ToolUse asks for Tool kind, project, and optional checkout/worktree/branch,
  followed by kind-specific input.
- Two ToolUses in one Session may target different projects and worktrees.
- Reload restores Session order, active Session, ToolUse order, selected
  ToolUse, inputs, output snapshots, and attachable PTYs.
- Closing a browser tab or navigating between Sessions must not kill PTYs.
- Closing a Session with live ToolUses must present three explicit choices:
  **Keep running and archive**, **Stop tools and archive**, or **Cancel**.
- Archived Sessions are recoverable from the command palette/session switcher.
- At least one visible Session always exists; closing the last one creates a new
  empty Session.

### 1.3 URL contract

Use a global shell URL because project is no longer the route identity:

```text
/?s=<session-id>&u=<tool-use-id>
```

- `s` selects a Session.
- `u` selects one ToolUse in that Session.
- Missing/invalid `s` selects the most recently updated visible Session.
- Missing/invalid `u` selects that Session's persisted active ToolUse.
- Session/ToolUse selection uses `pushState`; initial correction and invalid-id
  recovery use `replaceState`.
- Keep a one-release compatibility resolver for old project path URLs and old
  `?s=` project-session links. Resolve a migrated Session, replace the URL with
  `/`, and never create or checkout a project merely by parsing the URL.
- Remove the old rule “URL pathname is the project” from user documentation only
  after the compatibility E2E passes.

### 1.4 Non-goals for v1

- No generic plugin marketplace or third-party code loading.
- No remote host/auth work in this migration.
- No new EditorTool, GitTool, ExplorerTool, or LSPTool. Existing implementations
  may remain temporarily unmounted for migration/reference.
- No tiled panes inside a Session. The Figma reference is tab strip + sidebar +
  one selected main ToolUse.
- No PTY protocol rewrite and no terminal bytes through generic JSON Tool events.
- No automatic `git checkout` of a shared project root to satisfy a branch.
- No full event-sourcing system. Persist snapshots plus revisioned deltas.
- No visual copy of the mock's fake metrics, profile, system logs, or hardcoded
  colors.

## 2. Architecture decisions (do not re-decide during implementation)

### 2.1 Tool abstraction: shared control plane, specialized data planes

The generic Tool runtime owns creation, lifecycle, commands, snapshots,
revisions, cancellation, and reconnect. Each Tool may keep a specialized data
plane:

- AgentTool/TerminalTool keep `terminal:data` binary WebSocket frames,
  `terminal.attach()` replay, existing 64 KiB/4 ms batching, and existing
  100k/5k flow-control watermarks.
- SearchTool emits bounded typed result batches and persists result rows so a
  snapshot can recover after an event gap.
- Generic `tools:event` carries low-frequency lifecycle and output metadata. It
  must never carry PTY screen bytes.

This preserves the hot path in `packages/yaade-node-host/src/terminal.ts` and
`packages/yaade-host-client/src/web-transport.ts`.

### 2.2 Output state is inline or referenced

Do not put unbounded output JSON into the `tool_uses` row. The generic output
union must support:

- Process output reference: terminal-instance id, PTY id, generation, process
  status, activity status, replay availability, exit metadata.
- Search output reference: result count, completion/truncation state,
  next-cursor, and a result-set revision. Actual results live in a child table.

This still fulfills “ToolUse state is input + output”: the ToolUse snapshot owns
the typed output reference, and the referenced store is part of that output.

### 2.3 ToolUse context is immutable after start

Project and checkout selection are immutable once a ToolUse starts. To target a
new checkout, create a new ToolUse. Search query/options are mutable Tool input
and increment `inputRevision`; project/checkout are not.

### 2.4 Branches are isolated

A branch choice resolves to an existing worktree for that branch or creates a
managed worktree under `~/.yaade/worktrees/`. Never switch the branch of Main as
an implicit side effect. This prevents one ToolUse from changing another
ToolUse's filesystem underneath it.

### 2.5 Host is authoritative

Sessions, ToolUses, status, ordering, and durable outputs are server-side. The
browser keeps a normalized external store for rendering and optimistic
selection only. Do not persist canonical Session/ToolUse state in localStorage.
Appearance preferences may remain localStorage-backed.

### 2.6 One managed Effect runtime

The host Tool runtime must be an Effect service/layer created once in
`makeHostLayers`. Use:

- `Schema.Class` / `Schema.TaggedClass` for reusable wire/domain models.
- branded Session and ToolUse IDs.
- `Schema.TaggedErrorClass` for transportable errors.
- `Effect.fn` for meaningful operations.
- `Stream`, `PubSub`, scoped fibers, and interruption for asynchronous drivers.
- `ManagedRuntime`/existing host runtime boundary; do not call `Effect.run*` in
  every driver method.
- named Layer constants where possible; do not repeatedly call layer factories.

Follow `.agents` Effect guidance and the existing scoped host composition in
`apps/host-server/src/effect/layers.ts`.

## 3. Canonical data contracts

### 3.1 Add `packages/yaade-rpc/src/tool-session.ts`

Define and export schema-backed models. Use `optionalKey`, not optional values,
for omitted object keys. Avoid `any`, `as` casts, namespaces, and manual
post-decode validation.

Required concepts (names may only change if TypeScript reserves/conflicts):

```ts
SessionId              // branded string, ses-...
ToolUseId              // branded string, use-...
ToolKind                // "agent" | "terminal" | "search"
ToolUseStatus           // created | starting | running | waiting |
                        // succeeded | failed | cancelled | disconnected

ProjectTarget {
  projectId
  projectPath
  projectName
}

CheckoutTarget =
  MainCheckout
  | ExistingWorktreeCheckout { path, branch? }
  | BranchWorktreeCheckout { branch, baseRef?, createBranch }

ResolvedToolContext {
  project
  checkoutKey
  checkoutPath
  checkoutLabel
  branch?
  managedWorktree
}

ToolUseInput =
  AgentToolInput { provider, args? }
  | TerminalToolInput { shellArgs? }
  | SearchToolInput { query, options }

ToolUseOutput =
  ProcessToolOutput { terminalInstanceId, ptyId?, generation,
                      processState, activityState, replayAvailable,
                      exitCode?, truncated }
  | SearchToolOutput { resultRevision, resultCount, truncated,
                       nextCursor?, running }

AppSession {
  id, title, position, activeToolUseId?, createdAt, updatedAt, archivedAt?
}

ToolUse {
  id, sessionId, kind, title, position, status, context,
  input, inputRevision, output, error?, revision,
  createdAt, updatedAt, startedAt?, finishedAt?, archivedAt?
}
```

The input and output variants must carry `_tag` and a matching `kind`. Decoding a
TerminalTool ToolUse with AgentTool input must fail.

Add command schemas:

```ts
CreateSession
RenameSession
ReorderSessions
ArchiveSession
RestoreSession
CreateToolUse
UpdateToolUseInput       // Search only in v1
ReorderToolUses
CancelToolUse
RestartToolUse
ArchiveToolUse
SelectSessionToolUse
ListSessions
GetSession
GetToolUse
ListSearchResults
```

Add event schemas with `eventId`, `toolUseId` where relevant, `revision`, and
`occurredAt`:

```ts
SessionCreated | SessionUpdated | SessionArchived | SessionRestored
ToolUseCreated | ToolUseUpdated | ToolUseOutputChanged
SearchResultsReset | SearchResultsAppended | ToolUseArchived
```

`SearchResultsAppended` must contain at most 100 results per event. Event
payloads must use the existing `ProjectSearchResult` schema/type or move that
contract into `@yaade/rpc` without duplicating it.

Add errors:

```ts
SessionNotFound
ToolUseNotFound
InvalidToolInput
InvalidToolCommand
ProjectTargetUnavailable
CheckoutResolutionFailed
ToolUseConflict          // stale revision / generation
ToolRuntimeFailure
```

Export the file from `packages/yaade-rpc/src/index.ts` and add
`packages/yaade-rpc/src/tool-session.test.ts` covering round trips, invalid
input/output pairing, malformed IDs, every tagged union member, and optional
fields.

**Phase gate:**

```bash
pnpm --filter @yaade/rpc typecheck
pnpm --filter @yaade/rpc test
```

Expected: exit 0 and the new schema tests pass.

## 4. Persistence and migration

### 4.1 Schema version 15

Add the migration through the existing SQLite owner. Prefer a focused
`apps/host-server/src/tool-session-store.ts` that receives `db.raw()` over
adding hundreds more lines to `persistence.ts`; keep database construction in
`ProjectDatabase`.

Create:

```sql
app_sessions(
  id TEXT PRIMARY KEY,
  machine TEXT NOT NULL,
  title TEXT NOT NULL,
  position INTEGER NOT NULL,
  active_tool_use_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
)

tool_uses(
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES app_sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  position INTEGER NOT NULL,
  status TEXT NOT NULL,
  project_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  project_name TEXT NOT NULL,
  checkout_key TEXT NOT NULL,
  checkout_path TEXT NOT NULL,
  checkout_label TEXT NOT NULL,
  branch TEXT,
  managed_worktree INTEGER NOT NULL DEFAULT 0,
  input_json TEXT NOT NULL,
  input_revision INTEGER NOT NULL DEFAULT 1,
  output_json TEXT NOT NULL,
  error_json TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  archived_at TEXT
)

tool_use_search_results(
  tool_use_id TEXT NOT NULL REFERENCES tool_uses(id) ON DELETE CASCADE,
  result_revision INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  result_json TEXT NOT NULL,
  PRIMARY KEY(tool_use_id, result_revision, ordinal)
)
```

Indexes:

- visible sessions by `(machine, archived_at, position)`
- ToolUses by `(session_id, archived_at, position)`
- ToolUses by checkout path for worktree-in-use protection
- ToolUses by status

Add nullable `tool_use_id TEXT` to `terminal_instances` plus a unique partial
index for non-null values. Keep `workspace_id` during compatibility; new writes
set `workspace_id = session_id` and `tool_use_id = ToolUse.id`.

### 4.2 Store API

`ToolSessionStore` must expose transaction-safe methods for:

- list/get/create/rename/reorder/archive/restore Sessions
- list/get/create/reorder/archive ToolUses
- compare-and-set ToolUse input/output/status by expected revision
- replace/append/page search results by result revision
- set active ToolUse only when it belongs to the Session
- list live ToolUses using a checkout path

All JSON reads must decode through `@yaade/rpc` schemas. Invalid persisted rows
must become a typed storage error and operational log; do not silently replace
them with empty state.

### 4.3 One-time migration from the current product

Run once inside an immediate transaction and record schema migration 15 only
after success:

1. For each non-archived `project_sessions` row, create one `app_sessions` row.
   Preserve id when it already starts `ses-`; preserve title/order by
   `updated_at DESC`.
2. For each non-removed `terminal_instances` row linked by `workspace_id`, create
   one process ToolUse:
   - provider non-null -> AgentTool
   - provider null -> TerminalTool
   - project/checkout fields come from the terminal instance
   - output points back to that terminal instance
   - populate `terminal_instances.tool_use_id`
3. Parse `project_surface_state` rows for the `search` surface. For each persisted
   search tab, create a SearchTool ToolUse using its project/checkout/query/options.
   Results are not currently durable; initialize an empty output and mark it
   ready to rerun on first attach.
4. Do not migrate editor, git, explorer, or LSP panes into fake Tool kinds.
5. If migration produces no visible Session, create `Session 1` with no ToolUses.
6. Leave legacy tables intact for rollback. Do not dual-write them after the new
   shell is enabled.
7. Migration must be idempotent when a process crashes between startup attempts.

Add `apps/host-server/src/tool-session-store.test.ts` with fresh DB, migration,
idempotence, ordering, invalid JSON, cascade, compare-and-set conflict, and
search-result paging tests. Register the test in
`apps/host-server/package.json` because this repo lists tests explicitly.

**Phase gate:**

```bash
pnpm --filter @yaade/host-server typecheck
pnpm --filter @yaade/host-server test
```

Expected: exit 0; migration can run twice without duplicates.

## 5. Host Tool runtime

### 5.1 New host modules

Create:

```text
apps/host-server/src/tools/
  model.ts                 # runtime-only driver interfaces
  errors.ts                # typed host/runtime errors
  registry.ts              # closed v1 registry, kind lookup
  service.ts               # Session + ToolUse orchestration
  context-resolver.ts      # project/worktree/branch resolution
  process-driver.ts        # shared Agent/Terminal implementation
  search-driver.ts         # Search implementation
  index.ts
```

### 5.2 Driver contract

The runtime contract must be independent of React and transport. The exact
syntax can follow Effect 3.22 APIs, but it must provide these semantics:

```ts
ToolDriver {
  kind
  create(toolUse, decodedInput): Effect<initial output, typed error, deps>
  updateInput?(toolUse, decodedInput): Effect<output, typed error, deps>
  restart(toolUse): Effect<output, typed error, deps>
  cancel(toolUse): Effect<output, typed error, deps>
  attach(toolUse): Stream<ToolRuntimeEvent, typed error, deps>
  close(toolUse): Effect<void, typed error, deps>
}
```

Avoid an unsafe heterogeneous generic registry. Use the closed tagged
`ToolUseInput` union at the erased registry boundary and narrow by `_tag`/kind.
A helper may preserve concrete driver types internally, but it must not require
`any` or `as`.

### 5.3 ToolService responsibilities

`ToolService` is the only mutator for Sessions/ToolUses. It must:

1. Decode every command.
2. Resolve/validate project and checkout under `allowedRoots` on the host.
3. Persist a `created` ToolUse before starting asynchronous work.
4. Transition `created -> starting -> running/waiting -> terminal state` with
   compare-and-set revisions.
5. Start each long-running driver in a scoped fiber tracked by ToolUse id.
6. Interrupt and clean up the previous fiber on cancel/restart.
7. Publish typed events to a bounded `PubSub`, bridged to EventHub as
   `tools:event`.
8. On host startup, reconcile `starting/running/waiting` rows:
   - attach to a live PTY when available
   - mark missing PTYs `disconnected`
   - rerun incomplete SearchTool uses
9. Annotate Effect spans/logs with `sessionId`, `toolUseId`, `toolKind`, and
   project id; never log terminal contents or search file contents.
10. Keep cancellation as Effect interruption, not a generic failure.

Add `ToolServiceTag` and a single live layer in
`apps/host-server/src/effect/tags.ts` and `layers.ts`. Construct it once and add
it to `HostRuntime` only as the HTTP/WS compatibility boundary requires. Ensure
shutdown interrupts Tool fibers before stopping the terminal host.

### 5.4 Context resolver

Reuse server-known projects and existing worktree helpers. The resolver must:

- verify project exists and is within `allowedRoots`
- canonicalize paths with realpath when they exist
- Main -> project root
- existing worktree -> verify it belongs to the selected project's
  `git worktree list`
- branch -> reuse an existing worktree for that branch or create the managed
  worktree using `resolveWorktreePath` and `gitWorktreeAdd`
- persist both requested input and resolved context
- never trust a browser-supplied checkout path by itself
- clean up a managed worktree only through an explicit later user action and
  only when `list live ToolUses by checkout` returns no blockers

### 5.5 Process driver

Refactor, do not duplicate, the durable process path in
`apps/host-server/src/terminal-instances.ts` and the launch logic in
`apps/host-server/src/dispatch.ts`:

- TerminalTool reserves a terminal instance, creates a shell PTY at resolved
  checkout path, binds PTY, and projects instance state into ProcessToolOutput.
- AgentTool does the same but resolves provider availability/driver, installs
  hooks as currently required, launches the CLI, and keeps agent telemetry.
- A launch request id remains idempotent and should derive from ToolUse id plus
  generation.
- Restart increments generation and reuses immutable context/input.
- Cancel/stop sends the existing process stop/dispose behavior and records final
  replay metadata.
- Existing `terminal:data`, attach replay, acknowledge, resize, and xterm APIs
  remain untouched except for ToolUse correlation.
- Existing agent nested `tool.started/tool.completed` telemetry updates
  AgentTool activity; it does not create product-level ToolUses.

### 5.6 Search driver

Refactor the orchestration currently in
`packages/yaade-app/src/project/project-search-store.ts` into the host driver;
reuse `packages/yaade-node-host/src/search.ts::projectSearch`.

Behavior:

- Debounce mutable query/options input by 120 ms.
- Interrupt the previous search immediately when input revision changes.
- Reset search results transactionally before publishing `SearchResultsReset`.
- Fetch pages with the existing limits; append persisted results in batches of
  at most 100 and publish one batch event after each transaction.
- Check input revision before every append so stale results cannot land.
- Persist completion, truncation, next cursor, count, and result revision.
- `loadMore` continues from persisted cursor without replacing prior rows.
- Empty query succeeds with an empty result set and does not spawn ripgrep.
- On reconnect/event gap, `GetToolUse` + `ListSearchResults` reconstructs the
  exact visible state.

Tests must cover cancellation, stale result rejection, empty query, pagination,
host failure, and restart recovery.

**Phase gate:**

```bash
pnpm --filter @yaade/host-server test
pnpm --filter @yaade/node-host test
pnpm --filter @yaade/host-server typecheck
pnpm --filter @yaade/node-host typecheck
```

## 6. Transport and client API

### 6.1 RPC/HTTP surface

Prefer typed `tools:*` host channels through the existing RPC envelope for
commands and reads. Do not add ad hoc fetch calls in React components.

Required channels:

```text
tools:listSessions
tools:createSession
tools:renameSession
tools:reorderSessions
tools:archiveSession
tools:restoreSession
tools:getSession
tools:createUse
tools:updateUseInput
tools:reorderUses
tools:selectUse
tools:getUse
tools:listSearchResults
tools:loadMore
tools:cancelUse
tools:restartUse
tools:archiveUse
tools:listProjects
tools:listCheckoutTargets
```

Keep specialized terminal hot commands as they are.

Update:

- `packages/yaade-rpc/src/host.ts`: add `tools:event` to channel contracts.
- `apps/host-server/src/dispatch.ts`: decode typed Tool commands and call
  ToolService; do not embed driver logic in the switch.
- `packages/yaade-workspace/src/types.ts`: add `JetElectronTools` and attach it
  to `YaadeHostAPI`.
- `packages/yaade-host-client/src/create-yaade-api.ts`: Promise compatibility
  adapter and one deduplicated event listener set.
- `packages/yaade-host-client/src/effect-host-client.ts`: expose the Effect API
  without collapsing typed errors to strings.

### 6.2 Reconnect and ordering

- Tool events carry per-entity revision.
- Client ignores duplicate/older revisions.
- If revision jumps by more than one or EventHub emits `protocol:replay-gap`,
  refetch the affected ToolUse snapshot; for SearchTool also refetch result
  pages.
- Do not assume EventHub retained terminal output; terminal replay remains the
  source of truth.
- Abort in-flight Tool commands on transport close using existing transport
  abort behavior.

Add sibling tests in `@yaade/rpc`, `@yaade/host-client`, and host-server for all
new IPC, including malformed input, forbidden paths, cancellation, reconnect,
revision gap, and error decoding.

**Phase gate:**

```bash
pnpm --filter @yaade/rpc test
pnpm --filter @yaade/host-client test
pnpm --filter @yaade/host-server test
pnpm -r typecheck
```

## 7. Browser state architecture

### 7.1 New app modules

Create:

```text
packages/yaade-app/src/tools/
  tool-client.ts           # Effect/Promise boundary only
  tool-store.ts            # normalized external store
  tool-store.test.ts
  tool-registry.ts         # UI metadata + lazy renderer loaders
  tool-session-routing.ts
  tool-session-routing.test.ts
  ToolSessionApp.tsx       # shell composition, not business logic
  SessionTabStrip.tsx
  ToolUseSidebar.tsx
  ToolUseViewport.tsx
  NewToolUseDialog.tsx
  SessionSwitcher.tsx
  renderers/
    AgentToolView.tsx
    TerminalToolView.tsx
    SearchToolView.tsx
```

### 7.2 Normalized external store

Do not put all Sessions, all ToolUses, search results, or PTY output into
`ToolSessionApp` React state. Build a store with:

```text
sessionsById
visibleSessionIds
usesById
useIdsBySession
searchResultsByUseId
activeSessionId
connection/reconciliation status
```

Required subscription granularity:

- session tab subscribes to one Session summary
- sidebar subscribes to one Session's ToolUse id list
- sidebar row subscribes to one ToolUse summary
- viewport subscribes only to selected ToolUse
- search list subscribes to the selected search result slice

Use `useSyncExternalStore` or the repo's Effect Atom integration. Snapshots must
be referentially stable when unrelated entities change. Batch incoming search
result events at most once per animation frame. PTY output must never enter this
store.

### 7.3 UI Tool registry

The UI registry is metadata and lazy rendering, not the runtime driver:

```ts
{
  kind,
  label,
  icon,
  describeInput,
  mountPolicy,
  loadRenderer
}
```

- Agent and Terminal use `mountPolicy: "keep-alive-lru"`.
- Search uses `mountPolicy: "remountable"` because output is in the store.
- Lazy-load xterm and search code only when that kind is first opened.
- Direct-import renderer chunks; do not pull Monaco, LSP, panel dock, or git into
  the startup graph.

### 7.4 Process viewport cache

Adapt the proven keep-mounted idea from
`packages/yaade-app/src/mux/MuxTerminalLayer.tsx` without carrying over the panel
tree:

- retain at most six Agent/Terminal viewports across Session/ToolUse switching
- selected viewport is visible and interactive
- retained inactive viewports are hidden, not disposed; pass `visible={false}`
  so xterm skips expensive fitting
- seventh least-recently-used viewport is unmounted; the PTY survives on host
  and reattaches with replay when selected again
- only the viewport cache rerenders on geometry changes

Do not render all historical terminals forever.

## 8. UI shell based on `figma-mock.html`

Use the mock's information architecture, not its fake dashboard content:

```text
┌──────────────────────────────────────────────────────────────┐
│ Session A × │ Session B × │ Session C × │ +                 │
├────────────────┬─────────────────────────────────────────────┤
│ YAADE          │                                             │
│ Filter tools   │  Selected ToolUse                           │
│                │  Agent terminal / shell / search results    │
│ TOOL USES      │                                             │
│ ● Agent        │                                             │
│ ○ Search       │                                             │
│ ○ Terminal     │                                             │
│                │                                             │
│ + New tool     │                                             │
├────────────────┴─────────────────────────────────────────────┤
│ optional prefix/connection status only                       │
└──────────────────────────────────────────────────────────────┘
```

### 8.1 Design rules

- Reuse current semantic theme tokens; no hex values in components.
- Use Geist for UI and Commit Mono for paths/status/output metadata.
- Reuse `Button`, `Input`, `Dialog`, `Command`, `Empty`, `Skeleton`, `Badge`,
  `Tooltip`, `Separator`, and `Sonner` from `@yaade/ui/primitives`.
- Use `PaletteShell` for Session switcher/filterable command surfaces.
- Use existing semantic radii and `yaadeMotion`; no hardcoded durations.
- Icons are Lucide only.
- Keep surfaces flat; shadows only on overlays.
- Top tabs are scrollable, keyboard accessible, and use roving tabindex.
- Sidebar is 280–304 px desktop, a drawer on narrow screens, and has stable row
  heights suitable for virtualization.
- ToolUse rows show title first, then `project · checkout` in muted mono text,
  plus a semantic status indicator. Do not display internal ids.
- Empty Session says “Add a tool to start this session” and provides one primary
  action.
- Failures explain the next action: retry, change target, or close.
- Respect reduced motion. Session switching is instant state-wise; only selection
  indicators/content opacity may animate.

The distinctive element is the top Session strip controlling a per-session
ToolUse rail. Do not add the mock's decorative status lights, fake profile, or
metrics cards.

### 8.2 New ToolUse dialog

Implement as a staged dialog with state preserved when moving backward:

1. **Tool**: Agent, Terminal, Search.
2. **Project**: known projects, recent projects, or validated absolute path.
3. **Checkout**: Main, existing worktree, or branch in isolated worktree.
4. **Tool input**:
   - Agent: provider and optional CLI args.
   - Terminal: shell defaults; optional shell args only.
   - Search: query plus existing regex/case/whole-word/include/exclude options.
5. **Review/Create**: plain summary of Tool, project, checkout, and action.

Project/worktree loading may happen in parallel after Tool selection. Disable
Create until host validation succeeds. If worktree creation fails, keep the
user's form state and show the typed host error inline.

### 8.3 Keyboard architecture

Do not bind browser-reserved chords. Replace mux-specific naming with an app
prefix table while preserving `Ctrl-a` and send-prefix behavior inside xterm.
Suggested v1 bindings:

```text
Ctrl-a c       new Session
Ctrl-a t       new ToolUse
Ctrl-a w       switch Session
Ctrl-a j/k     previous/next ToolUse
Ctrl-a x       close selected ToolUse
Ctrl-a Shift-X close Session
Ctrl-a p       command palette
Ctrl-a ,       settings
```

Direct bindings remain only deliberate non-reserved keys such as
`Mod-Shift-p` and `Mod-,`. A matched prefix command must call both
`preventDefault()` and `stopPropagation()`. Bare Escape must still reach xterm.
Update the on-screen WhichKey data from the same binding table.

## 9. Renderer-specific work

### 9.1 AgentToolView and TerminalToolView

Both compose one shared `ProcessToolView` around the existing lazy
`TerminalPanel`:

- attach using ProcessToolOutput's terminal instance/PTy information
- `attachOnly`; lifecycle actions go through Tool commands
- show starting, disconnected, exited, failed, and replay-only states
- Agent adds provider/activity/telemetry status and agent-specific restart label
- Terminal uses shell-oriented labels
- input, output, resize, acknowledgement, links, file drop, and Escape behavior
  stay in existing terminal components
- do not duplicate xterm setup

### 9.2 SearchToolView

Adapt `ProjectSearchPanel` and `ProjectSearchSurface`:

- controlled input comes from SearchToolInput
- updates call `updateUseInput` and rely on host cancellation/revision
- results come from normalized durable result pages
- preserve current grouped snippets, virtualization, load-more, and result open
- for v1, selecting a result may call the existing external/open-file behavior;
  do not silently introduce EditorTool
- show reconnect/reconciling status without clearing current rows

After cutover, delete or retire the in-memory asynchronous orchestration in
`project-search-store.ts`; there must be only one owner for search cancellation
and stale-result rejection.

## 10. App cutover and legacy removal

### 10.1 Cutover

Simplify `packages/yaade-app/src/AppRoot.tsx` to boot system info, resolve the new
Session route, preload only ToolSessionApp, and render it. Keep error boundary,
appearance initialization, system signals, and the Playwright agent bridge.

Update `window.__yaadeAgent` with new methods/state:

```text
createSession
selectSession
createToolUse
selectToolUse
closeToolUse
closeSession
getState -> activeSessionId, activeToolUseId, sessions, toolUses
```

Keep old methods only as temporary compatibility shims used by still-active
specs; remove them with those specs.

### 10.2 Do not delete proven engines

Keep and reuse:

- `packages/yaade-node-host/src/terminal.ts`
- `packages/yaade-node-host/src/search.ts`
- terminal renderer/input/output/link modules in `@yaade/ui`
- agent telemetry/provider driver packages
- git worktree host helpers
- host HTTP/WS transport, replay, flow control, and security checks
- semantic theme/design-system primitives

### 10.3 Remove after parity gates pass

Once the new E2E suite passes, remove active imports and then dead code for:

- project-as-route shell (`ProjectPage` and its project surface orchestration)
- `MuxApp`, panel-tree layout persistence, and mux-only launch routing
- HQ as the primary landing page
- old project-session browser clients/writers
- old project search browser store
- dead project-session/mux tests and E2E specs

Do not delete Monaco/LSP/Git packages in this plan; they are candidates for
future Tools. They must simply stay out of the active startup graph.

Keep legacy SQLite tables and compatibility read logic for one release. Mark
them deprecated in code/docs; schedule physical table removal as a separate
migration after real-user validation.

### 10.4 Documentation

Update:

- root `README.md`: new product model, URLs, first Tools, lifecycle, commands
- root `AGENTS.md`: architecture, key files, Tool invariants, testing guidance
- `packages/yaade-ui/AGENTS.md` only if public shell primitives/tokens change
- remove stale “one browser tab = one project” and one-project-session rules

## 11. Testing plan

### 11.1 Unit and integration tests

Add and explicitly register tests where package scripts enumerate files:

- `packages/yaade-rpc/src/tool-session.test.ts`
  - schema round trips and malformed contracts
- `apps/host-server/src/tool-session-store.test.ts`
  - migration, transactions, ordering, revisions, result paging
- `apps/host-server/src/tools/service.test.ts`
  - lifecycle, cancellation, restart, reconnect, stale update rejection
- `apps/host-server/src/tools/context-resolver.test.ts`
  - Main, existing worktree, branch worktree, forbidden/mismatched paths
- `apps/host-server/src/tools/process-driver.test.ts`
  - shared Agent/Terminal infrastructure and idempotent launch
- `apps/host-server/src/tools/search-driver.test.ts`
  - batch stream, stale rejection, pagination, recovery
- `packages/yaade-host-client/src/tool-client.test.ts`
  - event revisions, reconnect/gap, typed errors
- `packages/yaade-app/src/tools/tool-store.test.ts`
  - stable snapshots, per-entity subscriptions, batching, LRU selection
- `packages/yaade-app/src/tools/tool-session-routing.test.ts`
  - deep links, invalid ids, legacy path compatibility

Use `node:test` and `node:assert/strict`, not Vitest.

### 11.2 Playwright E2E

`tests/electron/tool-sessions.electron.spec.ts` now exists with focused smoke
coverage for booting the shell, creating a second Session, and creating a
Terminal ToolUse. Expand it with the following required scenarios:

1. Boot creates/restores a Session tab and empty state.
2. Create two Sessions; reload preserves order and active tab.
3. Create TerminalTool in Main; type a unique marker and observe it in PTY.
4. Switch Session away/back; PTY id and marker survive.
5. Create AgentTool using an available fixture/mock provider; status and terminal
   attach use one ToolUse.
6. Create SearchTool; assert scoped row count, fixture-only result text, no empty
   state, no overlap, row spacing, and visible row text.
7. Change search quickly; old-query results never appear after the new result
   revision.
8. One Session contains ToolUses from two projects/checkouts.
9. Branch selection creates/uses an isolated worktree and does not switch Main.
10. Reload restores all ToolUses and selected ToolUse.
11. Host reconnect reconciles ToolUse status and search output.
12. Closing a Session with a live PTY tests all three choices; browser navigation
    alone never kills PTY.
13. LRU with seven terminals evicts one xterm viewport but not its host PTY.
14. Bare Escape reaches a focused terminal.
15. Prefix command does not leak into terminal input; double prefix sends `^A`.
16. Legacy project URL resolves to a migrated Session and rewrites the URL.
17. Mobile sidebar opens/closes and selected ToolUse remains visible.

Use existing helpers in `tests/electron/_launch.ts`. Search/list assertions must
follow the repository anti-tautology rules: scoped selector, `minItems >= 1`,
row-only content, negative “No results”, no overlap/spacing, and visible text.
PTY assertions must use `waitForTerminalText`.

Retire old HQ/project/mux specs only after equivalent new behavior is covered.
Do not leave dozens of newly skipped tests.

### 11.3 Performance gates

Add/adjust `tests/bench/` budgets:

- Session switch changes selected chrome in <= 100 ms.
- Warm ToolUse switch changes selected viewport in <= 100 ms.
- Terminal interactive echo retains the current latency budget.
- Search first result for fixture query <= 300 ms warm.
- A 5,000-result search does not create 5,000 DOM rows.
- PTY output does not rerender `ToolSessionApp`, SessionTabStrip, or sidebar.
- Startup bundle does not eagerly include Monaco/LSP/panel-dock chunks.

Instrument with User Timing (`yaade:session-switch`, `yaade:tool-switch`,
`yaade:search-first-result`) and expose measures through `__yaadeAgent`.

## 12. Execution order

Checkpoints 1–9 are complete for the Tool Session shell (contracts, storage,
runtime, drivers/tests, transport/client tests, browser store, shell UI,
renderers/LRU/search, and the 17-scenario parity E2E). Soft cutover is live:
`/` and home-relative legacy paths boot `ToolSessionApp`. Physical deletion of
project/mux/HQ surfaces waits until remaining legacy E2E specs are retired.

Continue with:

10. **Cutover cleanup:** remove dead project/mux imports and specs after legacy
    `/_project` consumers are gone.
11. **Verification:** keep unit + tool-session E2E + session/tool/search benches green.
12. **Docs:** README/AGENTS already describe the Session model; trim leftover
    “one tab = one project” wording as dead routes disappear.

## 13. Full verification gates

Run focused tests after every phase, then all of these before declaring done:

```bash
pnpm -r typecheck
pnpm lint
pnpm test
pnpm test:e2e
pnpm test:bench
pnpm build
```

Expected:

- every command exits 0
- no skipped tests were added to hide regressions
- production build serves the SPA and host API
- no Rust/Cargo/Tauri/Electron files added
- no source package export points to stale `dist/`
- no terminal output stored in React state or generic Tool JSON events
- no project/worktree field remains on the Session model
- every ToolUse has a host-validated resolved context
- source changes match the allowed scope of this plan

For visual changes, run headed Playwright at least once:

```bash
YAADE_HEADED=1 pnpm test:e2e -- tool-sessions.electron.spec.ts
```

Verify session-tab overflow, sidebar density, focus rings, terminal fill,
search-row visibility, narrow layout, dark/light themes, and reduced motion.

## 14. STOP conditions

Stop and report instead of improvising if any of these is true:

1. Product owner wants a Session to own one project after all; that contradicts
   the core model and requires a new plan.
2. Product owner expects arbitrary branch checkout in Main rather than isolated
   worktrees; this has cross-ToolUse safety implications.
3. Existing PTY APIs cannot attach without taking ownership or disposing on
   renderer unmount. Fix ownership semantics first; do not work around by
   keeping every xterm mounted.
4. Tool output is required to be an unbounded inline JSON field. Revisit storage
   before implementation.
5. A generic Tool event path measurably regresses terminal throughput/latency.
   Restore the specialized terminal data plane.
6. Migration would delete or overwrite legacy project/session data. Legacy
   tables must remain rollback-safe for one release.
7. Implementing SearchTool requires a second ripgrep/FFF engine. Reuse the
   existing node-host search implementation instead.
8. The implementation needs `any`, unchecked casts, or unvalidated boundary
   payloads to make the Tool registry compile. Simplify the closed union/registry.
9. An in-scope file has materially drifted from the current-state assumptions in
   this plan.
10. Any focused verification fails twice after a reasonable correction.

## 15. Completion checklist

- [ ] Top-level tabs are Sessions, not projects.
- [ ] Session schema has no project/worktree fields.
- [ ] Sidebar rows are persisted ToolUses.
- [ ] Each ToolUse owns validated project and checkout context.
- [ ] AgentTool and TerminalTool use one shared process driver and existing PTY.
- [ ] SearchTool uses existing search engine with host-side cancellation and
      streamed/persisted result batches.
- [ ] Generic Tool control plane supports async, streaming events, snapshots,
      cancellation, reconnect, and typed failures.
- [ ] Terminal bytes remain on the specialized binary/replay path.
- [ ] Session/ToolUse state restores after reload and host reconnect.
- [ ] Switching Session never kills PTYs.
- [ ] Seven-terminal LRU behavior is verified.
- [ ] New ToolUse flow supports Main, existing worktree, and isolated branch
      worktree.
- [ ] URL is `/?s=...&u=...`; old project URLs have tested compatibility.
- [ ] Figma reference structure is reflected without copying fake content or
      hardcoded styling.
- [ ] App startup does not eagerly load Monaco/LSP/panel-dock.
- [ ] All unit, E2E, benchmark, typecheck, lint, and build gates pass.
- [ ] README and AGENTS describe the new architecture.
