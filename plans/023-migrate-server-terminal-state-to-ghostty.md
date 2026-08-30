# Plan 023: Replace server vt100 and custom scanners with native Ghostty

> **Executor instructions**: Complete Plans 019, 021, and 022 first. Run the
> drift check, preserve all operator changes, and migrate one behavior at a time.
> Keep the old parser only in test-only differential code until final removal.
> Stop on an unexplained parity failure. Mark this plan and its README row `DONE`
> only after `vt100` and production scanners are gone.
>
> **Drift check (run first)**:
>
> ```bash
> git status --short
> git diff --stat 8bbcd017..HEAD -- \
>   apps/server/Cargo.toml apps/server/Cargo.lock \
>   apps/server/src/terminal.rs apps/server/src/terminal_control.rs \
>   apps/server/src/wire.rs apps/server/tests \
>   crates/ghostty-vt docs/architecture
> git diff --stat -- \
>   apps/server/Cargo.toml apps/server/Cargo.lock \
>   apps/server/src/terminal.rs apps/server/src/terminal_control.rs \
>   apps/server/src/wire.rs apps/server/tests \
>   crates/ghostty-vt docs/architecture
> ```
>
> Confirm Plan 019's terminal owner is the sole owner of mutable PTY/parser
> state. Do not put a `ghostty_vt::Terminal` into `Arc<Mutex<_>>`.

## Status

- **Status**: BLOCKED (Plan 020)
- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plans 019, 021, and 022
- **Category**: migration / correctness / terminal semantics
- **Planned at**: commit `8bbcd017`, 2026-08-30
- **Source findings**: SolPro P1-7 and P1-8

## Why this matters

The browser uses libghostty-vt while the server uses `vt100` for checkpoint
state and hand-written byte/string scanners for OSC 7 and terminal queries.
Those engines can disagree on split sequences, modes, Unicode, title/cwd, color
queries, and modern keyboard/device behavior. The server also parses the same
output several times.

The terminal owner should feed each output chunk once to native Ghostty and
drain typed effects after the write. Browser and server then use the same pinned
engine revision without sharing unsafe handles.

## Current state

At the planning baseline, `apps/server/Cargo.toml` contains `vt100 = "0.16"`.
`EntryState` holds query carry state, cwd, a `vt100::Parser`, and a checkpoint.
The output loop invokes `feed_terminal_queries`, `parse_osc7_cwd`,
`recorder.process`, and checkpoint formatting. Current local changes may have
moved these fields into the Plan 019 actor; the drift check decides exact names.

Current terminal query handling writes responses through PTY writer state.
Ghostty callbacks are synchronous, so Plan 021 collects their bytes in a bounded
outbox and returns them only after `Terminal::write` finishes.

## Target architecture

```text
Plan 015 Bytes
  -> Plan 019 terminal owner
       -> ghostty_vt::Terminal::write(&bytes) exactly once
       -> TerminalEffects
            write_pty bytes -> urgent actor-owned PTY writer lane
            title/pwd/bell  -> actor metadata/control state
       -> public state/formatter -> transitional checkpoint path
       -> replay/history/fan-out from original immutable Bytes
```

The native Ghostty handle never enters async tasks, socket writers, history
workers, or global terminal-map locks.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Server | `vp run test:server && vp run test:terminal:integration` | migration semantics pass |
| Native/WASM parity | `vp run test:ghostty:parity` | same-revision corpus passes |
| Rust lint | `vp run lint:server:rust` | exit 0 without `vt100` |
| Browser E2E | `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-compatibility.web.spec.ts` | query/TUI compatibility passes |
| Platform | `vp exec playwright test --project=platform-e2e` | host lifecycle passes |

## Scope

**In scope**

- `apps/server/Cargo.toml` and lockfile
- `apps/server/src/terminal.rs`
- `apps/server/src/terminal_control.rs`
- `apps/server/src/wire.rs` only for existing metadata/checkpoint compatibility
- Focused server unit/integration/parity tests
- `crates/ghostty-vt` additions required by a demonstrated server use case
- Existing terminal compatibility and multiplexer E2E
- Architecture/runtime documentation and `plans/README.md`

**Out of scope**

- New checkpoint wire/import semantics: Plan 024.
- Private Ghostty state persistence.
- Socket/history/actor redesign from Plans 017–019.
- Browser renderer or worker changes.
- Ghostty revision/build-profile changes.
- A native renderer or server semantic-frame protocol.

## Steps

### Step 1: Capture old-server behavior against the shared corpus

Before deleting code, adapt the current `vt100`/scanner path in test-only code to
run relevant Plan 022 fixtures. Record exact current behavior for:

- query response bytes and ordering;
- OSC title/cwd updates across split chunks;
- alternate screen, cursor, modes, and resize;
- synthetic checkpoint/bootstrap output;
- malformed control strings and carry-buffer limits.

Classify differences from Ghostty as an old bug, an intentional host policy, or
a required compatibility behavior. Add hand-authored tests for each decision.
Do not make Ghostty imitate a bug without product approval.

**Verify**:

```bash
vp run test:server
vp run test:terminal:integration
vp run test:ghostty:parity
```

Expected: baseline differences are enumerated before production migration.

### Step 2: Create native Ghostty inside the terminal owner

Add `ghostty-vt` as a path dependency and create one `Terminal` when the actor
creates its PTY. Pass validated columns, rows, cell dimensions, scrollback,
device attributes, color scheme, and effect bounds. Fail terminal creation with
the existing typed host/runtime error path; do not leave a live PTY with no
state authority.

Keep construction, writes, resize/reset, state reads, and Drop on the same owner
thread. Ensure owner shutdown drops Ghostty after output processing stops and
before thread exit. Record the native/WASM revision in diagnostics without
payload data.

**Verify**:

```bash
vp run test:server
cargo clippy --manifest-path apps/server/Cargo.toml --all-targets -- -D warnings
```

Expected: lifecycle tests prove create/failure/dispose/recovery and thread
confinement.

### Step 3: Feed each output chunk once and drain effects

Replace parser/scanner calls with one `terminal.write(chunk.as_ref())`. After it
returns:

1. inspect bounded wrapper errors/overflow;
2. drain write-PTY responses through the actor's urgent write lane;
3. update title, cwd, bell, modes, palette, and diagnostics;
4. publish original immutable bytes to replay/history/attached fan-out.

Maintain causal order. A query response caused by output sequence N must enter
the PTY writer before later normal writes can overtake it, while still allowing
partial-write handling from Plan 019. Never write the PTY from a C callback.

Remove duplicate text decoding. Treat cwd from Ghostty as bounded untrusted
metadata. Any later filesystem operation derived from it must pass the existing
allowed-root validation before host access.

**Verify**:

```bash
vp run test:server
vp run test:terminal:integration
```

Expected: exact query/title/cwd fixtures pass under split chunks and output is
parsed once.

### Step 4: Move resize, reset, and host query policy to the wrapper

Route actor resize commits into native Ghostty in the same owner turn as PTY
resize ordering specified by Plan 019. Preserve final/latest-wins resize and
transaction generations from Plan 012.

Configure device attributes, host size, color scheme, clipboard policy, and
other responses through typed wrapper options/effects. Retain YAADE security
policy even when Ghostty can parse a sequence. Parsing a clipboard/file query
does not grant permission to service it.

Add tests for resize interleaved with split queries and close/recovery.

**Verify**:

```bash
vp run test:server
vp exec playwright test --project=web-e2e tests/web/e2e/terminal-compatibility.web.spec.ts
```

Expected: terminal query and resize compatibility matches approved fixtures.

### Step 5: Preserve the existing checkpoint contract temporarily

Until Plan 024 chooses a restorable format, keep the current versioned checkpoint
wire behavior. Produce transitional bootstrap bytes only through Plan 021's
public formatter/state APIs. Label the function and docs as synthetic replay
bootstrap, not Ghostty state serialization.

Do not persist raw handles, page memory, allocator state, or private structs. Do
not claim that a public render snapshot can initialize browser parser state.
Retain replay-quality/degraded behavior for truncated history.

**Verify**:

```bash
vp run test:server
vp run test:terminal:protocol
vp exec playwright test --project=web-e2e tests/web/e2e/terminal-multiplexer.web.spec.ts
```

Expected: reconnect/cold replay behavior remains compatible before Plan 024.

### Step 6: Remove `vt100` and production scanners

Delete the `vt100` dependency, recorder fields, UTF-8/query carry maintained only
for old scanners, `feed_terminal_queries`, `parse_osc7_cwd`, and dead helpers.
Keep scanner code only if another nonterminal security protocol owns it; document
that exception with a focused test.

Run a repository search and inspect every result. Lockfile removal alone is not
proof that bytes are parsed once.

**Verify**:

```bash
rg -n 'vt100|feed_terminal_queries|query_leftover|parse_osc7_cwd' apps/server
vp run lint:server:rust
vp run test:server
vp run test:terminal:integration
vp run test:ghostty:parity
```

Expected: no production duplicate parser/scanner match remains; all commands
pass.

### Step 7: Run browser and platform compatibility gates

Run terminal query, complex TUI, resize, reconnect, close, and multiplexer tests.
Update architecture docs with one-parse ownership, callback drain ordering,
security policy, same-revision guarantee, and the transitional checkpoint limit.

**Verify**:

```bash
vp run typecheck
vp run lint
vp run test:server
vp run test:terminal:protocol
vp run test:terminal:integration
vp run test:ghostty:parity
vp exec playwright test --project=web-e2e \
  tests/web/e2e/terminal-compatibility.web.spec.ts \
  tests/web/e2e/terminal-multiplexer.web.spec.ts
vp exec playwright test --project=platform-e2e
vp run build:server
```

Expected: all pass on Linux, macOS, and Windows runtime CI.

## Test plan

- Old/new classification for corpus queries, title/cwd, modes, malformed input.
- Actor lifecycle and thread confinement.
- Exact effect response ordering and partial PTY writes.
- Resize/reset/write interleaving and final resize guarantee.
- Checkpoint/replay compatibility without private state.
- Repository search proving parser/scanner removal.
- Browser/platform E2E for TUI, reconnect, close, and queries.

## Done criteria

- [ ] Each PTY output chunk enters one native Ghostty parser call.
- [ ] Terminal owner exclusively owns the `!Send` Ghostty handle.
- [ ] Query responses drain after callbacks through the urgent actor write lane.
- [ ] Title/cwd/modes/theme/size/device behavior matches approved corpus cases.
- [ ] Existing checkpoint/replay compatibility remains explicit and transitional.
- [ ] `vt100` and duplicate OSC/query scanners are absent from production.
- [ ] Native/WASM revision and parity gates pass on supported platforms.
- [ ] Full server/browser/platform tests and lint pass.

## STOP conditions

- Native Ghostty must be shared behind a mutex or moved across owner threads.
- A callback must block, re-enter Ghostty, or write the PTY directly.
- Approved query/title/cwd behavior differs from browser Ghostty without an
  explained host-policy boundary.
- Migration requires private Ghostty representation or changes checkpoint wire
  semantics assigned to Plan 024.
- Removing old code loses replay, resize, close, or security behavior.
- The work starts a native renderer or semantic terminal transport.

## Maintenance notes

Server terminal semantics now follow the pinned Ghostty engine plus explicit
YAADE host policy. Add new terminal behaviors to the shared corpus before adding
server-specific parsing. Keep callbacks bounded and the native handle on the
terminal owner thread. Plan 024 remains the authority for checkpoint claims.
