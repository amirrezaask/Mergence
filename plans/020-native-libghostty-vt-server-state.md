# Plan 020: Make native libghostty-vt the server terminal-state authority

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. Preserve all pre-existing working-tree changes. If anything in the
> "STOP conditions" section occurs, stop and report instead of improvising.
> When done, update this plan and its row in `plans/README.md` to `DONE`.
>
> **Drift check (run first)**:
>
> ```bash
> git status --short
> git diff --stat 7276f526..HEAD -- \
>   packages/ghostty-core/src/vendor/VERSION \
>   packages/ghostty-react/scripts/build-ghostty-wasm.sh \
>   apps/server/Cargo.toml apps/server/Cargo.lock \
>   apps/server/src/terminal.rs apps/server/src/terminal_control.rs \
>   apps/server/src/wire.rs apps/server/tests scripts .github/workflows/ci.yml \
>   docs/architecture docs/terminal-renderers.md
> git diff --stat -- \
>   packages/ghostty-core/src/vendor/VERSION \
>   packages/ghostty-react/scripts/build-ghostty-wasm.sh \
>   apps/server/Cargo.toml apps/server/Cargo.lock \
>   apps/server/src/terminal.rs apps/server/src/terminal_control.rs \
>   apps/server/src/wire.rs apps/server/tests scripts .github/workflows/ci.yml \
>   docs/architecture docs/terminal-renderers.md
> ```
>
> Confirm Plan 019 is `DONE`; native Ghostty handles must be created and used on
> the terminal owner thread, not placed back behind a broad mutex. The currently
> shipped Ghostty revision is the exact content of
> `packages/ghostty-core/src/vendor/VERSION` (at plan creation,
> `9f62873bf195e4d8a762d768a1405a5f2f7b1697`). Do not substitute the revision
> from the external review or a moving branch. Browser WASM and native server
> must use the same one-line revision source.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plan 019
- **Category**: perf / migration / correctness / architecture
- **Planned at**: commit `7276f526`, 2026-08-30
- **Source findings**: SolPro Ghostty review P1-7 and P1-8

## Why this matters

The browser already parses output with libghostty-vt, while the server uses
`vt100` only for checkpoints and maintains separate hand-written scanners for
OSC 7 and terminal queries. The server therefore pays duplicate parsing cost
and can disagree with the renderer about modes, cursor, title/cwd, query
responses, wide/combining text, and modern terminal sequences. It also misses
Ghostty's printable-run batching, table-driven parser, SIMD control-byte search,
and cache-oriented terminal storage.

The target is one pinned terminal engine on both sides. A small unsafe sys crate
owns the evolving C ABI; a safe Rust crate owns terminal/render handles and
callbacks; the server actor feeds raw `Bytes` directly into it. Query effects are
captured synchronously into bounded actor-local outboxes and drained after the
C call, so callbacks never block or re-enter Ghostty.

### Important vetting result: compact checkpoint restore is not currently a
### public libghostty-vt capability

At the pinned revision, the public C interface exposes terminal creation/write/
resize/reset, getters/effects, render-state traversal, grid refs, and formatters.
It does **not** expose a versioned terminal state import/restore operation. A
compact checkpoint built from public render rows cannot initialize a fresh
browser Ghostty parser; applying later raw bytes to a blank parser would produce
incorrect modes, cursor, scrollback, and untouched rows.

Therefore this plan does **not** expose Ghostty's internal page layout as a
persistent format and does not pretend a display snapshot is parser state. It
replaces `vt100` and duplicate scanners first. The existing synthetic replay
bootstrap may remain temporarily, generated through public Ghostty formatting,
until one of these separately approved conditions is true:

1. pinned libghostty-vt gains a public versioned export/import contract; or
2. measured full raw-history replay is acceptable and checkpoints can be removed;
   or
3. YAADE deliberately switches to authoritative server semantic state.

The executor must run the checkpoint feasibility gate below. If a public restore
API now exists at the live pinned revision, stop and propose a separate typed
checkpoint plan; do not expand this migration opportunistically. This narrowing
is intentional and should be recorded in `plans/README.md` as a considered
rejection of the original compact-checkpoint instruction for the current ABI.

## Current state

`apps/server/Cargo.toml` depends on `vt100 = "0.16"`.
`apps/server/src/terminal.rs::EntryState` contains:

```rust
query_leftover: String,
live_cwd: Option<PathBuf>,
recorder: Option<vt100::Parser>,
checkpoint: Option<TerminalCheckpoint>,
```

The output path calls `feed_terminal_queries`, `parse_osc7_cwd`,
`recorder.process`, and `store_checkpoint`. Query responses later reacquire the
PTY writer. Plan 019 should have moved all of this into one terminal owner, but
it remains duplicate parsing/state.

Browser WASM is built by
`packages/ghostty-react/scripts/build-ghostty-wasm.sh`. It reads the shared
`VERSION`, fetches that exact Ghostty source, pins Zig 0.15.2, and invokes
`zig build -Demit-lib-vt`. Reuse this source/toolchain acquisition; do not create
a second revision file or unrelated cache convention.

The pinned public C headers declare the API unstable. Relevant effects include
`GHOSTTY_TERMINAL_OPT_WRITE_PTY`, `TITLE_CHANGED`, `PWD_CHANGED`, `SIZE`,
`COLOR_SCHEME`, and `DEVICE_ATTRIBUTES`. Documentation states callbacks run
synchronously inside `ghostty_terminal_vt_write`, must not re-enter it, and must
not block.

## Target design

```text
crates/ghostty-vt-sys
  build.rs -> exact pinned Ghostty + Zig -> native static lib in OUT_DIR
  checked-in minimal generated bindings
  ABI/layout/symbol validation
  unsafe only; no terminal policy

crates/ghostty-vt
  safe Terminal (thread-confined)
  safe RenderState traversal / public snapshots
  EffectOutbox callbacks (write PTY, title, pwd, bell/query flags)
  typed GhosttyError
  revision/build-info validation

apps/server terminal owner
  Bytes -> ghostty_vt::Terminal::write
        -> bounded callback outbox
        -> actor state/title/cwd/modes/checkpoint update
        -> drain PTY response bytes through owner writer
```

Keep `ghostty-vt` a deep module. Server code should not name raw C handles,
integer option IDs, pointer lifetimes, sized-struct ABI details, or Ghostty
allocation functions.

The safe `Terminal` should be intentionally `!Send + !Sync` (for example via a
private `PhantomData<Rc<()>>`) so it cannot leave the Plan 019 owner thread.
Handles free in `Drop`; callbacks use pinned stable userdata; borrowed strings/
render iterators may not outlive the next write/update documented by Ghostty.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Prepare/validate Ghostty | new repository script defined in Step 1 | exact VERSION/Zig/header/symbol checks pass |
| Wrapper tests | `cargo test --manifest-path crates/ghostty-vt/Cargo.toml` | safe wrapper/fixtures pass |
| Server tests | `vp run test:server && vp run test:terminal:integration` | all pass without `vt100` |
| Rust lint | `vp run lint:server:rust` plus fmt/Clippy commands for both new crates | exit 0 |
| Protocol/browser unit | `vp run test:terminal:protocol && vp test packages/ghostty-core packages/ghostty-react packages/yaade-host-client` | parity tests pass |
| Compatibility E2E | `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-compatibility.web.spec.ts` | terminal corpus/query cases pass |
| Platform | `vp exec playwright test --project=platform-e2e` | supported host lifecycle passes |
| Bench | focused native VT benchmark command added by this plan and `vp run test:bench` | parser and E2E gates pass |
| Builds | `vp run build:server && vp run build:web && vp run build:desktop` | same revision embedded; all build |

## Suggested executor toolkit

- Use `perfguy` for parser corpus design, optimized native builds, allocation/
  throughput comparison, and 1/8/64-terminal measurements.
- Use `codebase-design` to keep FFI/ABI details behind the safe wrapper.
- Use `rust-gpu-performance` only for understanding Ghostty render-state data
  layout if needed; this plan does not add native GPU rendering.
- Use `playwright-best-practices` for server/browser differential fixtures.

## Scope

**In scope**

- `crates/ghostty-vt-sys/**` (new)
- `crates/ghostty-vt/**` (new)
- A shared Ghostty source/toolchain preparation script under `scripts/`
- `packages/ghostty-react/scripts/build-ghostty-wasm.sh` only to reuse the shared
  preparation/revision validation
- `packages/ghostty-core/src/vendor/VERSION` as the single revision source (do
  not change revision as part of migration unless fixing a proven ABI blocker)
- `apps/server/Cargo.toml` and `Cargo.lock`
- `apps/server/src/terminal.rs`
- `apps/server/src/terminal_control.rs` only for typed native query/device state
- `apps/server/src/wire.rs` only for checkpoint/metadata fields already present
- Focused wrapper/server tests and deterministic shared terminal fixtures
- `.github/workflows/ci.yml`
- Release/build scripts that must carry the native static library
- `docs/architecture/rust-server-migration.md`
- `docs/architecture/terminal-runtime.md`
- `docs/terminal-renderers.md`
- `plans/README.md` and this plan's status

**Out of scope**

- Exposing Ghostty private page structs, offsets, allocator memory, or raw dumps
  as YAADE persistence.
- Claiming a compact render snapshot can restore terminal parser state.
- Native rendering, WebGPU, server-side glyph shaping, or sending semantic rows
  to React as a new default protocol.
- Upgrading Ghostty revision merely because a newer commit exists.
- Dynamic system-library discovery; this is a pinned internal static dependency.
- Rewriting libghostty's parser/SIMD in Rust.
- A Cargo build that silently downloads moving/unverified source.

## Git workflow

- Do not commit, push, or open a PR unless explicitly instructed.
- Preserve prior plans and operator changes; never reset files.
- Unsafe code is confined to `ghostty-vt-sys` and narrow reviewed wrapper
  constructors/callback trampolines. Every unsafe block needs a local safety
  invariant and a test/static check where possible.

## Steps

### Step 1: Unify pinned Ghostty source/toolchain acquisition

Extract the exact revision/Zig/cache validation from
`build-ghostty-wasm.sh` into a shared script usable by WASM builds, native Cargo
builds, and CI. It must:

- read exactly `packages/ghostty-core/src/vendor/VERSION`;
- reject empty/non-40-hex revisions;
- fetch/check out only that commit into a content-addressed cache;
- verify `git rev-parse HEAD` equals the file;
- use exact Zig 0.15.2 (or the version required by the pinned commit, recorded in
  one place) and verify downloaded archive integrity;
- support an explicitly supplied offline source/Zig path;
- print resolved revision/source/toolchain paths for diagnostics;
- never edit the cached source or repository VERSION.

`build-ghostty-wasm.sh` calls this helper and produces byte-identical artifacts
before any optimization decision in Plan 021. Add a check-only mode for CI.

**Verify**:

```bash
# Run the new helper's check mode twice, once cached.
vp run --filter @yaade/ghostty-react build:ghostty-wasm
```

Expected: exact revision/toolchain are printed; second preparation uses cache;
WASM vendor VERSION remains unchanged.

### Step 2: Prove native C build/link on Linux, macOS, and Windows

Create `crates/ghostty-vt-sys`. Its `build.rs` locates the prepared pinned source,
invokes the pinned Zig build for Cargo's actual target/profile, and links the
native static lib from `OUT_DIR`. Inspect the pinned Ghostty build output and
link requirements. Do not guess library names or target triples.

Requirements:

- release server uses an optimized native Ghostty mode representative of
  production (`ReleaseFast` unless measured otherwise); debug tests may use a
  faster build mode only if semantics/layout match;
- target/profile/revision/Zig become cache keys;
- no generated static library is committed;
- `cargo:rerun-if-changed` covers wrapper/header/VERSION, not the entire cache;
- build fails clearly on revision/header/symbol mismatch;
- Windows/macOS/Linux native CI installs/prepares Zig before Cargo commands;
- build works under `cargo build --release --locked --manifest-path
  apps/server/Cargo.toml`.

Create a minimal C smoke fixture linked the same way and call build info,
terminal create/write/resize/free.

**Verify**:

```bash
cargo test --manifest-path crates/ghostty-vt-sys/Cargo.toml
vp run build:server
```

Expected locally: symbols link and smoke test passes. CI changes are not done
until all three platform jobs pass.

### Step 3: Generate a minimal checked-in binding surface and validate ABI

Generate bindings only for required public C types/functions/options. Check them
in so normal builds do not require libclang/bindgen. Add a maintainer command to
regenerate from the pinned headers and a CI drift check.

Validate:

- `sizeof`, `alignof`, and field offsets for every non-opaque struct crossing FFI;
- enum discriminants/options/data keys used by Rust;
- function signatures/callback calling convention;
- pointer-width-dependent `size_t`/`intptr_t` on 32/64-bit targets supported;
- required exported symbols and `ghostty_build_info` revision/features;
- sized-struct initialization requirements.

Compile C static assertions against the pinned headers and compare with Rust
layout tests. Do not bind all Ghostty internals. Deny or document warnings in the
sys crate and keep public exports minimal.

**Verify**:

```bash
cargo test --manifest-path crates/ghostty-vt-sys/Cargo.toml
# Run the binding regeneration in check/diff mode.
```

Expected: regeneration is clean and C/Rust layout/symbol checks pass.

### Step 4: Build a thread-confined safe `ghostty-vt` wrapper

Create `crates/ghostty-vt` as a path dependency on sys. Implement RAII wrappers
for only what the server needs:

```text
Terminal::new(cols, rows, max_scrollback, effects)
Terminal::write(&[u8])
Terminal::resize(...)
Terminal::reset()
Terminal::mode(...)
Terminal::title()/pwd()/cursor()/colors()
Terminal::render_state()/public snapshot traversal
Terminal::format_replay_bootstrap() (transitional only)
```

Use typed errors for allocation/invalid-value/out-of-space/ABI failures. Do not
panic on external bytes. Enforce range/size checks before FFI. Make handles
thread-confined and make borrowed output lifetimes impossible to retain across
mutating calls. Reuse render iterators, grapheme buffers, and scratch allocations.

The effects userdata is `Pin<Box<EffectState>>` and callbacks only:

- copy bounded write-PTY response bytes into an actor-local outbox;
- set title/pwd/bell/query dirty flags;
- fill device/size/color response structs from small copied state;
- set an overflow/error flag when bounded outbox capacity is exceeded.

Callbacks do not lock a host mutex, write the PTY, allocate without a bound,
block, send through a full channel, call terminal methods, log payloads, or
re-enter `vt_write`. After `write` returns, safe Rust drains effects and queries
borrowed title/pwd while valid.

**Verify**:

```bash
cargo test --manifest-path crates/ghostty-vt/Cargo.toml
cargo clippy --manifest-path crates/ghostty-vt/Cargo.toml --all-targets -- -D warnings
```

Expected: lifecycle/leak, malformed bytes, callback overflow, query, title/pwd,
resize/mode, and render traversal tests pass under sanitizers where available.

### Step 5: Add a shared native/WASM terminal differential corpus

Generate deterministic fixture bytes once, outside benchmark/test execution:

```text
ASCII source/build logs
split/malformed UTF-8
SGR/256/truecolor
wide/combining/ZWJ
scroll/wrap/reflow
primary/alternate screen
DEC synchronized output
mouse/focus/bracketed-paste/kitty keyboard modes
OSC title/cwd/colors/hyperlinks
DA/DSR/DECRQM/XTWINOPS/color queries
complex TUI rewrite corpus
```

Feed the exact byte files with the exact chunk-boundary schedule to:

1. native safe wrapper;
2. browser/Node WASM `GhosttyTerminalCore` in render-only/effects-controlled mode.

Compare public render-state rows/cells/styles/cursor/colors/modes/title/pwd,
query response bytes, dimensions, and formatted bootstrap output. Normalize only
explicit platform-dependent fields. Store no generated expected output that
could hide both implementations drifting together; include hand-authored
semantic assertions for critical cases.

**Verify**:

```bash
cargo test --manifest-path crates/ghostty-vt/Cargo.toml
vp test packages/ghostty-core packages/ghostty-react
```

Expected: native/WASM parity passes with the same VERSION and chunk schedule.

### Step 6: Replace actor-owned `vt100` and duplicate scanners

Inside the Plan 019 terminal owner, create one native `ghostty_vt::Terminal` per
PTY. Feed every Plan 015 `Bytes` chunk once. Replace:

- `vt100::Parser` and its resize/checkpoint reads;
- `feed_terminal_queries` and `query_leftover`;
- `parse_osc7_cwd` output scanning;
- hand-built DA/query response selection where Ghostty effects cover it.

After each write, drain the bounded effects outbox. Write query responses through
the actor-owned urgent PTY writer path, update title/cwd metadata, and build
checkpoints/semantic metadata only from public wrapper data. Preserve host theme,
size, device attribute, response-policy, and replay behavior in existing tests.
Do not parse the same bytes with both engines after rollout except in test-only
differential mode.

Remove `vt100` from `Cargo.toml`/lock and delete dead scanners/tests only after
the shared corpus covers them.

**Verify**:

```bash
vp run test:server
vp run test:terminal:integration
vp run lint:server:rust
```

Expected: `rg 'vt100|feed_terminal_queries|query_leftover|parse_osc7_cwd' apps/server`
returns no production parser/scanner matches; all query/cwd/checkpoint tests pass.

### Step 7: Run the checkpoint feasibility gate without exposing internals

Inspect the live pinned public headers and wrapper tests for a versioned terminal
state export **and matching import/restore** contract. Render traversal or a
formatter alone does not qualify.

- If no restore contract exists (expected at plan creation), retain the current
  typed checkpoint wire version temporarily. Generate its bootstrap bytes from
  public Ghostty formatter/render data, document that it is synthetic and
  transitional, and add a source/README note forbidding private page dumps.
  Record compact checkpoint restore as rejected/deferred in `plans/README.md`.
- If a public restore contract now exists, STOP. Propose a separate plan that
  defines a YAADE-owned versioned checkpoint envelope, cross-version policy,
  browser restore path, sequence fence, ABI fixture tests, and fallback. Do not
  add it inside this already high-risk parser migration.
- If removing checkpoints in favor of full raw replay appears attractive, first
  benchmark maximum retained history, attach latency, memory, and truncation.
  STOP for product approval before removing the existing recovery quality.

Never serialize Ghostty page memory, offsets, raw handles, allocator state, or
private Zig structs.

**Verify**:

```bash
vp run test:server
vp run test:terminal:protocol
vp exec playwright test --project=web-e2e tests/web/e2e/terminal-multiplexer.web.spec.ts
```

Expected fallback: checkpoint/replay behavior remains compatible and explicitly
transitional; no private representation enters persistence.

### Step 8: Benchmark native parsing and server integration

Add optimized, deterministic native benchmarks using pre-generated corpora:

```text
ASCII / Unicode / ANSI-heavy / TUI parser throughput
OSC/query effects
render-state/checkpoint extraction
resize/reflow
replay 512 KiB / 16 MiB
1 / 8 / 64 terminal actors
```

Run warmups and repeated samples serially; report median/p95/p99, bytes/s,
allocations, RSS, callback outbox high water, actor loop time, and binary size.
Compare `vt100` baseline recorded before removal where possible. Do not benchmark
debug Ghostty as production evidence.

Also run existing PTY-to-present benchmarks to detect server-side regressions.
Do not claim libghostty speed solely from its upstream design; retain the
migration primarily for semantic unification if local timing is neutral.

**Verify**:

```bash
# Run the focused optimized native VT benchmark command added by this plan.
vp run test:bench
```

Expected: callback outbox never overflows, parser actor keeps queue headroom, and
existing E2E budgets remain unchanged or tighter.

### Step 9: Enforce cross-platform build and upgrade discipline

Update CI's Linux/macOS/Windows runtime matrix to prepare/cache exact Zig and
Ghostty source before Cargo checks. Run sys/wrapper layout/symbol/tests on each
platform, server release build, and shared corpus where supported. Release
packaging must include static code without runtime library lookup.

Add an upgrade checklist/script:

1. change the one VERSION file intentionally;
2. prepare exact source;
3. regenerate/check bindings;
4. run ABI/layout/symbol diff;
5. rebuild WASM/native;
6. run differential corpus, server/browser E2E, and benchmarks;
7. record behavior/performance changes.

**Verify**:

```bash
vp run build:server
vp run build:web
vp run build:desktop
```

Expected locally: all build. Plan completion additionally requires green CI on
all three OS jobs; do not mark DONE from one platform.

### Step 10: Run full compatibility and document the result

Update architecture/render docs with shared revision, crate seams, callback
rules, owner-thread confinement, supported effects, checkpoint limitation,
upgrade process, and benchmark context.

**Verify**:

```bash
vp run typecheck
vp run lint
vp run test:server
vp run test:terminal:protocol
vp run test:terminal:integration
vp test packages/ghostty-core packages/ghostty-react packages/yaade-host-client
vp exec playwright test --project=web-e2e \
  tests/web/e2e/terminal-compatibility.web.spec.ts \
  tests/web/e2e/terminal-multiplexer.web.spec.ts
vp exec playwright test --project=platform-e2e
vp run test:bench
vp run build:server
vp run build:web
vp run build:desktop
```

Expected: all local commands and Linux/macOS/Windows CI exit 0; native/WASM
report the same revision; no `vt100` production dependency remains.

## Test plan

- Sys crate: exact revision, build info, symbols, C/Rust layout/discriminants,
  lifecycle smoke on three OS targets.
- Safe wrapper: RAII, malformed bytes, bounds, thread confinement, callback
  outbox/overflow, title/pwd/query/colors/size, render traversal, reusable scratch.
- Differential corpus: identical chunking through native/WASM plus hand-authored
  semantic assertions.
- Server actor: one parse, query response priority, cwd/title metadata, resize,
  checkpoint bootstrap, replay, dispose/recovery.
- ABI upgrade check: regenerated binding diff and fixture failures on changed
  layout/symbols.
- Bench/E2E: parser corpora, 1/8/64 terminals, exact replay, complex TUI, query
  compatibility, browser presentation.

## Done criteria

- [ ] One VERSION file pins both native server and browser WASM Ghostty.
- [ ] `ghostty-vt-sys` builds/validates the exact static C ABI on Linux, macOS, and Windows.
- [ ] Checked-in minimal bindings have reproducible regeneration and layout/symbol checks.
- [ ] Safe thread-confined wrappers own/free handles and hide raw FFI from server code.
- [ ] Callbacks are bounded, nonblocking, non-reentrant, and drained by the terminal owner.
- [ ] Native/WASM differential corpus passes with identical revision/chunking.
- [ ] Server feeds each output chunk once to native Ghostty; `vt100` and duplicate OSC/query scanners are removed.
- [ ] Existing title/cwd/theme/query/resize/replay/checkpoint semantics pass.
- [ ] No private Ghostty memory representation enters persistence or wire contracts.
- [ ] Compact checkpoint restore is explicitly deferred/rejected unless a public import API exists.
- [ ] Optimized native benchmarks and existing end-to-end budgets pass without unsupported speed claims.
- [ ] Full local gates and Linux/macOS/Windows CI pass.

## STOP conditions

- Native and WASM builds cannot prove the exact same revision.
- The pinned C ABI cannot build/link on one supported server platform.
- Correct callbacks require blocking, re-entering Ghostty, or retaining borrowed
  pointers after `vt_write`.
- Raw handles must become `Send`/shared behind a mutex rather than remain on the
  Plan 019 owner thread.
- Binding generation requires libclang in every normal user build instead of a
  checked-in validated minimal surface.
- A compact checkpoint proposal uses public render rows without a matching
  parser-state restore operation.
- Any proposal persists Ghostty private pages, pointers, offsets, allocator
  state, or raw memory dumps.
- Removing checkpoints/full-history replay would degrade reconnect behavior
  without measured product approval.
- The migration starts a native renderer or server semantic protocol rewrite.

## Maintenance notes

libghostty-vt is pinned internal source, not a stable system dependency. Every
upgrade is an ABI and semantic migration requiring binding/layout/symbol,
differential corpus, and benchmark gates. Keep unsafe code narrow and callbacks
boring. Reviewers should scrutinize source pinning, build reproducibility,
borrowed lifetimes, callback allocation/blocking, actor thread confinement, and
checkpoint claims: a render snapshot is not restorable terminal state.
