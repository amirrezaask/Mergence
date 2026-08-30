# Plan 021: Suppress unnecessary worker frames and make terminal builds measurable

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
>   packages/ghostty-react/src/surface.ts packages/ghostty-react/src/worker \
>   packages/ghostty-react/src/scheduler \
>   packages/ghostty-react/scripts/build-ghostty-wasm.sh \
>   packages/ghostty-core/src/vendor packages/ghostty-react/src/vendor \
>   packages/yaade-ui/src/panels/TerminalPanel.tsx \
>   packages/yaade-app/src/test-bridge.ts scripts tests/bench tests/web/e2e \
>   apps/server/Cargo.toml .github/workflows/ci.yml docs/terminal-renderers.md
> git diff --stat -- \
>   packages/ghostty-react/src/surface.ts packages/ghostty-react/src/worker \
>   packages/ghostty-react/src/scheduler \
>   packages/ghostty-react/scripts/build-ghostty-wasm.sh \
>   packages/ghostty-core/src/vendor packages/ghostty-react/src/vendor \
>   packages/yaade-ui/src/panels/TerminalPanel.tsx \
>   packages/yaade-app/src/test-bridge.ts scripts tests/bench tests/web/e2e \
>   apps/server/Cargo.toml .github/workflows/ci.yml docs/terminal-renderers.md
> ```
>
> Confirm Plans 014, 015, and 016 are `DONE`. Plan 014 owns incremental WebGL
> submission counters, Plan 015 owns byte writes, and Plan 016 owns the bounded
> recyclable render slots. Build on them; do not add another frame pool, restore
> string writes, or change retained scene semantics. If Plan 020 has landed,
> reuse its shared Ghostty source/toolchain helper and same-revision checks.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: Plans 014, 015, and 016
- **Category**: perf / dx / robustness
- **Planned at**: commit `7276f526`, 2026-08-30
- **Source findings**: SolPro Ghostty review P1-9, P1-10, build-level optimizations, and benchmark discipline

## Why this matters

The surface suppresses painting while hidden or while DEC private mode 2026 is
active, but the worker does not know either state. Every write still extracts a
Ghostty render update, packs typed arrays, transfers a slot, and asks the main
thread to apply it. Hidden panes and synchronized TUI transactions therefore pay
most frame-preparation cost even when no intermediate frame can be shown.

The Ghostty WASM artifact is also always built with `ReleaseSmall`. There is no
checked performance comparison with `ReleaseFast`, no CI assertion that the
shipped module contains intended SIMD instructions, and no subsystem benchmark
that localizes parse/pack/recycle/hidden/synchronized regressions.

The target separates parsing from presentation: hidden/synchronized terminals
keep state and ACK correct while render extraction stays pending. Visibility or
synchronized-output completion emits one catch-up frame. Focus/visibility inform
fair scheduling in the shared worker. Build choices are made from compressed
size, startup, throughput, replay, and memory measurements rather than intuition.

## Current state

`packages/ghostty-react/src/surface.ts::setVisible` cancels main-thread rAF and
requests a full frame when shown, but sends no visibility command to the worker.
The worker therefore keeps running `core.renderUpdate()` for hidden writes.

`surface.ts::afterTerminalWrite` implements synchronized-output paint suppression
and a one-second safety timeout. For the worker path, however, this method runs
only after `terminal-worker.ts` already built and transferred a packed update.

`packages/ghostty-react/src/worker/terminal-worker.ts` does this for every write:

```ts
case "writeBytes":
  core.write(command.data)
  scheduleUpdate(command, core)
  post({ ...envelope(command), type: "parsed" })
```

(The live name is byte-oriented after Plan 015.) `state(core)` reports mode 2026,
but reporting it with the packed update is too late to avoid that update.

`worker-pool.ts` hashes terminals across at most four workers but posts every
command immediately into browser FIFO order. It has no focused/visible priority
or per-terminal fairness queue.

`packages/ghostty-react/scripts/build-ghostty-wasm.sh` invokes:

```bash
-Doptimize=ReleaseSmall
```

and the helper WASM also uses `-O ReleaseSmall`. CI builds the checked-in artifact
but does not inspect optimization mode, Ghostty revision, or SIMD instructions.

## Target design

```text
surface state -> { visible, focused }
                   -> worker runtime scheduler state

write bytes -> parse -> post parsed/ACK point
             -> inspect synchronized mode
             -> presentation policy:
                  hidden: pending full catch-up, no render extraction
                  sync active: pending dirty catch-up, no extraction
                  visible/unsynced + free slot: packed update
                  all slots in flight: Plan 016 coalescing

show / sync close / safety timeout
  -> one authoritative catch-up update
```

Use one worker-side presentation state machine:

```text
visibility: hidden | visible
sync:       inactive | suppressing(deadline) | timedOut
focus:      background | focused
```

While `sync=suppressing`, no packed update is built. At one second, transition to
`timedOut` and allow rendering even if the application left mode 2026 enabled;
do not emit one frame and immediately suppress forever again. Return to
`inactive` when the mode clears. Hidden state still wins over the timeout.

Parsing/`parsed` acknowledgements never wait for visibility, synchronization,
rAF, render slots, or GPU presentation.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Worker/core unit | `vp test packages/ghostty-core packages/ghostty-react packages/yaade-ui` | all pass |
| Typecheck/lint | `vp run typecheck && vp run lint` | exit 0 |
| WASM build checks | new dual-build/SIMD verification commands added by this plan | exact revision and feature checks pass |
| Compatibility E2E | `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-compatibility.web.spec.ts` | hidden/sync/worker cases pass |
| Multiplexer E2E | `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-multiplexer.web.spec.ts` | multi-pane visibility/focus passes |
| Bench | `vp run test:bench` | subsystem and existing budgets pass |
| Builds | `vp run build:web && vp run build:desktop && vp run build:server` | selected artifacts build |

## Suggested executor toolkit

- Use `frontend-performance` for worker scheduling, hidden-page behavior,
  allocation/timing instrumentation, WASM startup, and browser profiling.
- Use `perfguy` for deterministic corpora, ReleaseSmall/Fast trade-offs, SIMD,
  memory budgets, and repeated median/p95/p99 comparisons.
- Use `codebase-design` to keep presentation policy behind one worker runtime
  state machine rather than duplicating flags in surface/pool/worker callers.
- Use `playwright-best-practices` for visibility, fake clock, synchronized TUI,
  multi-pane, and browser compatibility tests.

## Scope

**In scope**

- `packages/ghostty-react/src/surface.ts`
- `packages/ghostty-react/src/worker/protocol.ts` and tests
- `packages/ghostty-react/src/worker/terminal-worker.ts`
- `packages/ghostty-react/src/worker/worker-terminal-core.ts`
- `packages/ghostty-react/src/worker/worker-pool.ts` and focused tests
- `packages/ghostty-react/src/scheduler/terminal-frame-scheduler.ts`
- `packages/ghostty-react/scripts/build-ghostty-wasm.sh`
- Shared Ghostty preparation helper from Plan 020 if present
- `packages/ghostty-core/src/vendor/**` and compatibility vendor copies only
  when replacing the measured selected artifact; VERSION must remain exact
- `packages/yaade-ui/src/panels/TerminalPanel.tsx` only to propagate explicit
  focused/visible state and diagnostics; no visible design changes
- `packages/yaade-app/src/test-bridge.ts` for mirrored payload-free metrics
- `scripts/` for pinned WASM inspection/benchmark helpers
- `.github/workflows/ci.yml`
- `apps/server/Cargo.toml` only for measured release-profile settings in Step 7
- Focused browser E2E and subsystem benchmark files
- `tests/bench/budgets.json` only for repeatable measured distributions
- `docs/terminal-renderers.md`
- `docs/architecture/rust-server-migration.md` only if Rust profile changes
- `plans/README.md` and this plan's status

**Out of scope**

- Server terminal ownership/history/socket/native VT work from Plans 017–020.
- WebGL retained scene/atlas/buffer changes from Plan 014.
- SharedArrayBuffer/cross-origin isolation or OffscreenCanvas.
- WebGPU, native/Tauri-only behavior, or a new worker per terminal.
- Disabling terminal protocol handling merely to reduce WASM size.
- Adding a shaping cache before ligature/complex-run profiling justifies it.
- Shipping `target-cpu=native` server binaries.

## Git workflow

- Do not commit, push, or open a PR unless explicitly instructed.
- Preserve prior-plan/operator work. Never reset checked-in WASM artifacts.
- Benchmark alternate artifacts in temporary/ignored directories; replace the
  checked-in artifact only after the selection gate.

## Steps

### Step 1: Add worker presentation-work characterization

Extend Plan 014/016 payload-free diagnostics with:

```text
worker_parse_ns / bytes
worker_frame_build_ns
worker_frame_builds
worker_frames_suppressed_hidden
worker_frames_suppressed_sync
worker_sync_timeouts
worker_full_catchups
worker_pending_dirty
worker_render_slots_in_flight
worker_render_buffer_allocations
worker_queue_bytes by priority
worker_terminal_turns by terminal
```

Use fixed-capacity timing rings and compute percentiles only when diagnostics are
read. Do not add a clock call per cell/row. Add deterministic tests that show the
current issue: a hidden terminal and a mode-2026 transaction both increment
frame-build/transfer counts for every coalesced worker turn despite no paint.

Add browser fixtures for:

- one visible focused terminal;
- one visible background terminal;
- five hidden resident terminals flooding output;
- a 30 Hz synchronized dashboard;
- mode 2026 left open beyond one second.

**Verify**:

```bash
vp test packages/ghostty-react packages/yaade-ui
vp exec playwright test --project=web-e2e tests/web/e2e/terminal-compatibility.web.spec.ts
```

Expected before implementation: counters expose hidden/sync frame construction;
existing semantic tests pass.

### Step 2: Propagate explicit visibility and focus to the runtime

Add a generation-scoped validated worker command such as:

```ts
{ type: "setPresentationState", visible: boolean, focused: boolean }
```

Extend `TerminalCoreRuntime` with one presentation-state method. Main-thread
fallback may store it/no-op for extraction because the surface already owns its
render calls; worker runtime forwards it. `GhosttyTerminalSurface.setVisible`
and input focus/blur call one internal updater that deduplicates identical state.
`TerminalPanel`'s explicit `visible`, `focused`, and `isActive` props must remain
consistent with real input focus; do not infer visibility only from DOM geometry.

Ordering requirements:

- create establishes initial state before normal writes can produce a frame;
- hide cancels pending worker frame extraction but not parsing;
- show marks full catch-up and requests one frame;
- stale state from an old worker generation is ignored;
- focus affects priority/cursor policy but never terminal correctness;
- dispose clears scheduler state.

**Verify**:

```bash
vp test packages/ghostty-react packages/yaade-ui
vp run typecheck
```

Expected: create/hide/show/focus/blur/dedup/generation/dispose tests pass; no
visible React state stores PTY output.

### Step 3: Suppress worker extraction for hidden terminals

When hidden:

- continue parsing every byte/replay/resize/control command;
- post `parsed` at the normal point;
- update Ghostty state/title/modes and mark catch-up pending;
- do not call `renderUpdate`, lease a Plan 016 slot, pack typed arrays, transfer,
  apply a viewport model, upload GPU state, or request surface paint.

On show, request exactly one full authoritative update after any pending resize/
theme generation is applied, then resume dirty-row updates. If all three slots
are in flight, keep the full catch-up pending until a slot returns. A hide→show→
hide race may not emit an invisible frame.

Keep hidden parsing bounded/fair. Browser tabs with suspended rAF still parse and
answer terminal queries through the existing output fallback; visibility
suppression concerns frame preparation, not parser liveness.

**Verify**:

```bash
vp test packages/ghostty-react
vp exec playwright test --project=web-e2e tests/web/e2e/terminal-multiplexer.web.spec.ts
```

Expected: hidden output flood increments parse/ACK but zero frame-build/transfer
counts; show emits one full catch-up with final text/grid and stable PTY/runtime.

### Step 4: Implement synchronized-output suppression in the worker

After each write/replay parse, inspect mode 2026 **before** scheduling extraction.
Use the target state machine:

- transition inactive→suppressing when mode becomes active; cancel pending
  extraction and arm one 1,000 ms safety deadline;
- while suppressing, accumulate Ghostty dirty state and build no updates;
- when mode clears, cancel deadline and emit one catch-up update;
- on deadline, transition to `timedOut`, emit one update, and continue allowing
  updates while the mode remains stuck;
- when stuck mode finally clears, return to inactive without duplicate catch-up;
- hidden visibility overrides emission but preserves timeout state/catch-up.

Do not rely on `TerminalRuntimeState.synchronizedOutput` delivered with a packed
update to make the suppression decision. Keep main-thread fallback behavior
semantically identical. Expose a presentation-suppressed/timed-out state to the
surface if needed so its existing suppression does not discard the worker's
safety-timeout frame.

Use fake timers for exact 999/1000 ms boundaries and repeated writes; no sleep
based unit tests.

**Verify**:

```bash
vp test packages/ghostty-core packages/ghostty-react
vp exec playwright test --project=web-e2e tests/web/e2e/terminal-compatibility.web.spec.ts
```

Expected: one packed/presented frame per complete synchronized transaction,
zero intermediate frame builds, and a faulty open transaction resumes display
after about one second without stopping parsing.

### Step 5: Add focused/visible fairness inside each shared worker

Keep terminal command order per terminal. Add a bounded worker-local scheduler
only if characterization shows shared-worker starvation; do not blindly replace
browser FIFO. If needed, message handlers enqueue lightweight command envelopes
per terminal and drain weighted turns:

1. focused terminal input/control and visible parse;
2. other visible terminals;
3. hidden/background parse.

Use byte quanta from the existing scheduler budgets, not command count alone.
Never starve hidden parsing/query responses: apply round-robin aging/fairness and
an explicit maximum wait. Resize/dispose/recovery commands keep lifecycle
priority. Render extraction remains conditional on visibility/sync/slot state.

Bound total and per-terminal queued bytes using existing Plan 015 scheduler
limits; do not add a second uncoordinated unbounded queue. If browser FIFO already
meets the measured multi-pane target and an internal queue adds overhead, record
"not worth doing" and keep only visibility/sync suppression.

Tests compare one focused terminal's parse/input latency while five hidden
terminals flood, and prove every hidden terminal still advances within the
fairness bound.

**Verify**:

```bash
vp test packages/ghostty-react
vp run test:bench
```

Expected: focused latency does not regress and hidden terminals make bounded
progress; queue byte limits hold. If no scheduler is added, documented evidence
shows why.

### Step 6: Produce controlled ReleaseSmall and ReleaseFast WASM artifacts

Refactor the build script to accept a validated optimization mode and output
path without overwriting checked-in artifacts. Produce temporary:

```text
ghostty-vt-small.wasm
ghostty-vt-fast.wasm
```

Both must report the same VERSION, Zig, target, features, strip policy, and
source tree. Keep the write-PTY helper's optimization choice separate; its size/
runtime role differs from the parser module.

Create deterministic optimized browser/Node measurements for both:

```text
raw and brotli/gzip size
compile/instantiate/init p50/p95/p99
first terminal ready
ASCII / Unicode / ANSI / TUI bytes per second
512 KiB / 16 MiB replay
packed dirty-row extraction
steady and peak memory
```

Generate corpora once with fixed seeds; warm up; run repeated serial samples;
record hardware, browser, runtime, revision, artifact hash, and compressed size.
Choose `ReleaseFast` only if runtime/replay improvement outweighs measured
startup/download/memory cost for YAADE's reuse pattern. Choose `ReleaseSmall`
if Fast is noise or harms startup materially. Replace both vendor copies from
one selected artifact and verify hashes match.

**Verify**:

```bash
# Run dual-build command and focused artifact benchmark added by this step.
vp test packages/ghostty-core packages/ghostty-react
```

Expected: a reproducible decision table exists; selected vendor artifacts and
VERSION/hash checks agree; no claim is based on raw file size alone.

### Step 7: Verify SIMD/features and benchmark Rust release settings

Add a pinned CI inspection tool/script that fails if the selected WASM artifact:

- does not match the VERSION/build hash;
- lacks the intended `simd128` instructions/features;
- imports unexpected native/runtime facilities;
- exports missing required libghostty-vt symbols;
- exceeds the recorded compressed size/startup budget.

Validation that a browser *supports* SIMD is not proof the artifact contains SIMD;
inspect module instructions or authoritative Ghostty build info. Retain a scalar
artifact only if a supported browser/WebView test proves it is required; do not
silently ship two modules without loader/fallback tests and a memory/download
budget.

For the Rust server, benchmark the actual release binary with default, thin LTO,
full LTO, and `codegen-units=1` where build time permits. Compare startup,
binary/compressed size, terminal throughput, and CI build time. Apply only a
measured portable profile. Strip distributed release symbols according to
existing diagnostics policy; never use `target-cpu=native`.

**Verify**:

```bash
# Run the new WASM artifact verification script.
vp run build:server
vp run build:web
vp run build:desktop
```

Expected: CI fails on a scalar/wrong-revision/unexpected-import artifact; any
Rust profile change has recorded measurements and remains portable.

### Step 8: Add subsystem benchmarks and regression budgets

Create focused browser benchmarks using the same deterministic corpus across
revisions:

```text
ArrayBuffer routing -> worker
worker parse throughput by corpus
packed dirty-row generation
render-slot recycle latency/allocation
one dirty row / full frame
hidden terminal output flood
synchronized-output dashboard
focused terminal during five hidden floods
WASM initialization and replay
```

Integrate Plan 014 renderer submission counters rather than duplicating GPU
metrics. Keep setup/corpus generation outside measured regions, warm up, use
multiple rounds, compare medians/p95/p99, and never run competing benchmarks in
parallel.

Machine gates:

- hidden flood: zero packed builds/transfers while parse/ACK reaches final bytes;
- synchronized transaction: one catch-up build/present, zero intermediate builds;
- stuck sync: presentation resumes by the safety deadline;
- render-buffer allocation delta: zero after Plan 016 warm-up;
- focus/background fairness: no starvation and no >5% focused-input regression;
- selected WASM meets recorded compressed size/init/replay/throughput budgets;
- existing end-to-end typing/flood/session-switch budgets remain unchanged or
  tighter.

Add `budgets.json` entries only for stable duration distributions. Keep exact
counter gates in benchmark code.

**Verify**:

```bash
vp run test:bench
```

Expected: all exact and timing gates pass with runtime/backend/artifact/hardware
context printed.

### Step 9: Run shared browser/Tauri and CI gates

Update `docs/terminal-renderers.md` with worker presentation state, hidden/sync
rules, safety timeout, fairness result, render-slot interaction, selected WASM
mode, SIMD verification, artifact sizes, and benchmark table. Update architecture
docs only for measured Rust profile/build changes.

**Verify**:

```bash
vp run typecheck
vp run lint
vp run test:web
vp test packages/ghostty-core packages/ghostty-react packages/yaade-ui
vp exec playwright test --project=web-e2e \
  tests/web/e2e/terminal-compatibility.web.spec.ts \
  tests/web/e2e/terminal-multiplexer.web.spec.ts
vp run test:desktop
vp run test:bench
vp run build:web
vp run build:desktop
vp run build:server
```

Expected: all local commands and artifact CI checks pass; browser and Tauri use
the same worker/runtime implementation; no existing budget is loosened.

## Test plan

- Protocol/runtime state: create/visible/focused dedup, generation, dispose,
  malformed messages.
- Hidden: parse/ACK without extraction, resize/theme while hidden, show full
  catch-up, hide/show race, suspended rAF.
- Synchronized: mode enter/write/exit, fake-clock timeout, timed-out continued
  updates, hidden interaction, all slots in flight, main fallback parity.
- Fairness: focused/visible/background ordering, byte quanta, lifecycle priority,
  hidden progress, queue bounds; or measured rejection of extra scheduler.
- Build: exact revision/toolchain, Small/Fast isolated outputs, artifact hashes,
  imports/exports, SIMD instruction assertion, compressed size.
- Bench/E2E: deterministic corpora, hidden floods, synchronized dashboard,
  worker allocation/recycle, multi-pane focus, WASM startup/replay, Tauri build.

## Done criteria

- [ ] Worker receives explicit generation-scoped visible/focused state.
- [ ] Hidden terminals parse and ACK but build/transfer zero render updates until one show catch-up.
- [ ] Mode 2026 suppresses worker extraction and emits one update on completion.
- [ ] A stuck synchronized transaction resumes presentation after about one second and stays live.
- [ ] Parsing never waits for visibility, synchronization, render slots, rAF, or presentation.
- [ ] Shared-worker fairness is measured; any added queue is bounded and non-starving.
- [ ] ReleaseSmall/Fast decision uses compressed size, startup, throughput, replay, and memory.
- [ ] CI proves exact Ghostty revision, required exports, and actual SIMD instructions.
- [ ] Distributed Rust builds remain portable; profile changes are measured.
- [ ] Subsystem exact counters and stable timing budgets pass without loosening E2E budgets.
- [ ] Browser and Tauri builds/tests use the same selected artifact/runtime.

## STOP conditions

- Surface suppression is kept while worker extraction still occurs.
- The synchronized safety timeout emits one frame then suppresses forever again.
- Hidden parsing/ACK or terminal query responses wait for visibility/rAF.
- A worker priority queue is unbounded, breaks per-terminal order, or starves
  hidden terminals.
- ReleaseFast/Small artifacts differ in revision/features beyond optimization or
  are benchmarked with different corpora/environment.
- SIMD validation checks only browser capability, not module instructions/build
  info.
- A feature reduction removes terminal protocol compatibility for size alone.
- A Rust release profile uses `target-cpu=native` or is chosen without build/
  runtime/size measurements.
- The plan starts changing WebGL submission, server runtime ownership, or native
  Ghostty FFI assigned elsewhere.

## Maintenance notes

Parsing correctness and presentation work are separate milestones. Future worker
commands must state whether they mutate terminal state, require a result, or
require a frame. Visibility/sync suppression may coalesce frames, never bytes or
parser ACK. Keep build artifacts reproducible from one revision and make every
optimization-mode/SIMD/profile claim rerunnable. Reviewers should scrutinize
state-machine transitions, timeout behavior, slot interaction, hidden fairness,
artifact identity, and benchmark comparability.
