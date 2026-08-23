# Multi-Client Terminal Multiplexer Audit

- **Repository:** YAADE
- **Snapshot:** `67ea4b36` with a dirty working tree
- **Audited:** 2026-08-24
- **Scope:** Terminal runtime, replay and flow control, multi-client state, authentication, multi-server routing, CI, and the GPUI desktop client
- **Status:** Advisory report only; no source changes were made

The working tree changed during the review. Findings were revalidated after the latest terminal ACK and resync edits, but source locations should be checked again before implementation.

## Prioritized findings

### 1. Restore trustworthy CI gates

- **Category:** Testing / developer experience
- **Confidence:** High
- **Impact:** High
- **Effort:** Small for the immediate repair; large for the lint backlog
- **Risk:** Low

CI currently reaches two nonexistent tasks, while lint and the new desktop client are not gated.

**Evidence**

- `.github/workflows/ci.yml:24` invokes `test:e2e:critical`.
- `.github/workflows/ci.yml:47` invokes `test:runtime:e2e`.
- Both commands return `Task not found`.
- Existing E2E tasks are defined in `vite.config.ts:69-76`.
- `vp run lint` currently reports approximately 628 errors and 28 warnings.
- The documented desktop fmt, test, clippy, and design-contract checks are absent from CI.

**Recommended change**

1. Replace stale CI task names with real scoped tasks.
2. Add a desktop job covering formatting, tests, clippy, and design-contract validation.
3. Triage anti-slop rules and establish a phased lint baseline rather than performing hundreds of mechanical suppressions.
4. Keep the final CI workflow runnable locally through the same commands.

---

### 2. Never cumulatively ACK across dropped parser bytes

- **Category:** Correctness / terminal protocol
- **Confidence:** High
- **Impact:** High
- **Effort:** Medium
- **Risk:** Medium

Consumption-based ACKs are now wired, but the browser output writer can discard an earlier frame and later ACK a higher sequence. Because terminal ACKs are cumulative, this tells the host that discarded bytes were successfully parsed.

**Evidence**

- Consumption ACK mode is enabled in `packages/yaade-ui/src/panels/TerminalPanel.tsx:483`.
- `packages/yaade-ui/src/panels/terminal-output-writer.ts:116-128` sheds old frames when the parser queue exceeds its cap.
- Later consumed-frame callbacks can still ACK a higher sequence.

**Impact**

A dropped prefix may contain an incomplete escape sequence, OSC command, UTF-8 sequence, or terminal mode transition. Subsequent output can then be rendered from corrupted parser state while the authoritative replay is prematurely trimmed.

**Recommended change**

1. Treat any parser-queue shed as an explicit replay gap.
2. Suppress all later cumulative ACKs for that generation.
3. Clear or quarantine queued live bytes and request authoritative replay from the last fully consumed sequence.
4. Align client parser capacity with advertised flow-control capabilities.
5. Add a flood test that verifies full terminal-screen integrity or a deterministic checksum after at least 1 MiB of unique output; a final marker alone is insufficient.

---

### 3. Keep active navigation state per client

- **Category:** Multi-client correctness / product architecture
- **Confidence:** High
- **Impact:** High
- **Effort:** Medium
- **Risk:** Medium

Session, Window, and terminal selection is persisted and broadcast as shared state. Two clients trying to view different terminals can therefore move one another's navigation. Observe-only clients cannot navigate reliably because selection routes are treated as control mutations.

**Evidence**

- Web navigation persists selection in `packages/yaade-app/src/mux/TerminalMultiplexer.tsx:673` and `:864`.
- Incoming session and tab events overwrite local selection in `packages/yaade-app/src/mux/mux-store.ts:457-495`.
- Selection routes are not observe-safe in `packages/yaade-host-server/src/route-policy.ts:15-43`.

**Recommended change**

1. Make active Session, Window, terminal, focused pane, and scroll position viewer-local.
2. Keep server-side active IDs only as non-authoritative reload hints, if they are retained at all.
3. Allow observe-scoped clients to navigate their local view without mutating shared runtime state.
4. Introduce an explicit follow or presenter mode rather than making all navigation implicitly shared.
5. Add a two-client test where each client stays on a different Window while both receive runtime updates.

---

### 4. Track terminal exits inside archived, keep-running Sessions

- **Category:** Correctness / lifecycle
- **Confidence:** High
- **Impact:** Medium–high
- **Effort:** Small
- **Risk:** Low

A Session can be archived without stopping its terminals, but later process exits are resolved only against visible Sessions. Restoring the Session can therefore show a dead PTY as still running.

**Evidence**

- Archive-without-stop is supported in `packages/yaade-host-server/src/terminal-runtime/service.ts:332-354`.
- `onProcessExit` searches only `listSessions(false)` in `packages/yaade-host-server/src/terminal-runtime/service.ts:423-428`.

**Recommended change**

Resolve terminal ownership by PTY across both visible and archived Sessions, or maintain a direct PTY-to-terminal index. Add a regression test covering archive, process exit, and restore.

---

### 5. Bound all unauthenticated authentication state

- **Category:** Security / resource control
- **Confidence:** High
- **Impact:** High
- **Effort:** Medium
- **Risk:** Low

Unauthenticated callers can create attacker-controlled map entries and consume unauthenticated WebSocket capacity.

**Evidence**

- Challenge, session, and failure maps are unbounded in `packages/yaade-host-server/src/device-auth.ts:91-93`.
- Arbitrary unauthenticated `deviceId` values reach authentication through `packages/yaade-host-server/src/server.ts:703-711`.
- Failure tracking creates caller-selected keys in `packages/yaade-host-server/src/device-auth.ts:374-384`.
- Modern unauthenticated WebSockets remain open for five seconds at `packages/yaade-host-server/src/server.ts:1195-1198` without a global admission ceiling.

**Recommended change**

1. Add schema limits for device IDs, public keys, signatures, labels, and challenge inputs.
2. Replace unbounded maps with TTL/LRU-bounded stores.
3. Add global and per-source admission limits in addition to device-key limits.
4. Cap concurrent unauthenticated WebSockets and outstanding pairing challenges.
5. Add security tests using many unique device IDs and half-open WebSocket handshakes.

---

### 6. Negotiate raw versus semantic terminal subscriptions

- **Category:** Performance / protocol architecture / desktop parity
- **Confidence:** High
- **Impact:** High
- **Effort:** Large
- **Risk:** Medium–high

The host always performs semantic parsing, while browser clients continue to parse raw PTY output and can also receive semantic projection. Semantic events are retained in generic event history and encoded per viewer. The desktop client, meanwhile, uses one-shot HTTP replay rather than the semantic WebSocket lane.

**Evidence**

- Semantic parsing is always enabled in `packages/yaade-node-host/src/effect-terminal.ts:28`.
- Screen rows and cells are materialized in `packages/yaade-node-host/src/terminal-semantic-runtime.ts:291-298`.
- `packages/yaade-host-server/src/events.ts:27` marks only raw `terminal:data` frames as ephemeral.
- No production web terminal surface consumes semantic snapshots.
- Desktop calls HTTP attach in `apps/desktop/src/host.rs:47-49`.
- The typed attach schema omits semantic snapshots in `packages/yaade-rpc/src/routes.ts:107-132`.
- Desktop falls back to parsing replay bytes in `apps/desktop/src/app.rs:293-309`.

The desktop's one-shot attach also does not page the durable archive or detach its viewer after obtaining a snapshot. Long-running terminals can therefore be represented from only a truncated tail.

**Recommended change**

1. Negotiate an explicit `raw`, `semantic`, or one-shot `snapshot` mode per terminal subscription.
2. Preserve raw mode for the Ghostty browser surface and use semantic mode for native desktop.
3. Encode each semantic revision once and fan out shared immutable bytes.
4. Mark both paint channels ephemeral in generic event history.
5. Cap terminal grid area independently from per-dimension limits.
6. Implement desktop WS snapshots, patches, detach, input, and resize before calling the desktop client realtime-capable.
7. Add protocol conformance tests between Effect schemas and Rust fixtures or generated contracts.

---

### 7. Add socket-wide flow credit and retry failed resyncs

- **Category:** Reliability / backpressure
- **Confidence:** High
- **Impact:** High under load
- **Effort:** Medium
- **Risk:** Medium

Flow credit is tracked per terminal, but output ultimately shares one bounded socket writer. Several busy terminals can collectively exceed that writer's capacity even when each terminal remains below its own limit. A transient replay-attach failure also leaves a terminal waiting until a later socket reconnect.

**Evidence**

- Per-terminal credit defaults to 8 MiB in `packages/yaade-host-server/src/ws/terminal-flow-control.ts:18-36`.
- The shared raw mailbox is capped at 32 MiB in `packages/yaade-host-server/src/ws/client-outbound-mailbox.ts:40`.
- Mailbox overflow closes the client socket in `packages/yaade-host-server/src/ws/client-socket-writer.ts:126-130`.
- The resync catch path in `packages/yaade-host-client/src/create-yaade-api.ts` retains state but schedules no connected-socket retry with backoff.

**Recommended change**

1. Add a socket-wide outstanding-byte budget below the actual mailbox and transport-buffer ceiling.
2. Preserve per-terminal fairness and resynchronize only the terminal that exceeded its allocation.
3. Retry failed resyncs with bounded exponential backoff, generation checks, and one in-flight request per terminal.
4. Advertise relevant flow limits in host capabilities.
5. Add tests with several simultaneous high-output terminals and a deliberately slow consumer.

---

### 8. Make terminal history globally bounded and observable

- **Category:** Reliability / storage
- **Confidence:** High
- **Impact:** High
- **Effort:** Medium
- **Risk:** Medium

The advertised total history quota counts only closed archives. Active terminals can therefore consume up to their per-terminal limits independently. Persistence failures are logged and swallowed, leaving replay silently incomplete.

**Evidence**

- Default limits are defined in `packages/yaade-node-host/src/terminal-history-archive.ts:103-105`.
- Global quota enforcement skips manifests without `closedAt` in `packages/yaade-node-host/src/terminal-history-archive.ts:306-320`.
- Write failures are logged and swallowed at `packages/yaade-node-host/src/terminal-history-archive.ts:274-280`.
- The runtime permits 64 terminals in `packages/yaade-node-host/src/terminal.ts:62`.

At the current defaults, active terminals can retain roughly 16 GiB of compressed history before per-terminal limits are exhausted, despite a nominal 2 GiB global quota.

**Recommended change**

1. Include active archives in global quota accounting.
2. Reserve quota fairly between active terminals rather than deleting only after close.
3. Surface degraded or gapped replay state through health/capability metadata.
4. Make history quota and retention configurable.
5. Add tests for full disks, permission failures, partial blocks, and quota pressure across active terminals.

---

### 9. Fix remote terminal deep-link normalization

- **Category:** Correctness / multi-server routing
- **Confidence:** High
- **Impact:** Medium
- **Effort:** Small
- **Risk:** Low

Remote terminal deep links may not reconcile across clients that assigned the same host different local server IDs.

**Evidence**

- `packages/yaade-app/src/mux/mux-routing.ts:120-124` claims to normalize `term-` IDs but its regular expression strips `terminal-` instead.

**Recommended change**

Correct the prefix and add table-driven tests for local and server-scoped Session, Window, and terminal IDs, including the same remote resource under different client-local server definitions.

## High-value product directions

### 1. Finish native desktop realtime parity

- **Effort:** Large
- **Recommendation:** Direct implementation after the semantic subscription contract is defined

Implement semantic WS snapshots and patches, terminal input, resize, tiling, detach, and reconnect. Preserve the desktop rule that only decoded semantic snapshots live in GPUI view state. Use real host integration tests rather than only hand-authored Rust fixtures.

**Tradeoff:** Maintaining two renderers increases protocol and testing cost, so cross-language contract conformance must become a release gate.

### 2. First-class device pairing in Web and Desktop

- **Effort:** Medium–large
- **Recommendation:** Implement after pre-auth state is bounded

The server pairing protocol and browser identity primitives already exist, while Settings still asks users for bearer tokens. Add one-time-code pairing, automatic session refresh, scope-aware UI, revocation, and native keychain storage.

**Tradeoff:** Secure storage is platform-specific on desktop and must not fall back to plaintext configuration silently.

### 3. Named presence, follow mode, and resize authority

- **Effort:** Large
- **Recommendation:** Design spike first

Build on device identity and viewer metadata. Keep typing permissions independent from ephemeral presenter/follower roles. Elect one resize authority while permitting all control-scoped clients to type under the existing shared-control model.

**Tradeoff:** Presence must remain content-free and must not accidentally turn optional following into globally shared navigation.

### 4. Agent attention and unread states in existing chrome

- **Effort:** Medium
- **Recommendation:** Direct implementation after viewer-local state exists

Use generic terminal and process signals—OSC shell integration, BEL, output activity, and process exit—to produce the existing `working`, `running_command`, and `waiting_for_input` states. Surface unread or attention badges in terminal, Window, and Session chrome without adding a standalone agent or notification surface.

**Tradeoff:** Heuristics must degrade gracefully for shells and programs without integration; avoid provider-specific agent parsing.

## Deliberately excluded directions

Do not add:

- PTY restart durability or a detached supervisor.
- Standalone agent chat, Git, search, editor, or file-browser surfaces.
- Provider-specific agent control planes.
- Multi-terminal broadcast input without a separate safety design.

These conflict with the documented product boundary or add disproportionate operational risk.

## Recommended execution order

1. Repair CI task names and add desktop gates.
2. Add characterization tests for:
   - Parser-consumption ACK integrity.
   - Independent two-client navigation.
   - Archived-session process exit.
   - Slow viewers across several terminals.
   - Desktop/host protocol conformance.
3. Implement findings 2, 4, 5, and 9 as the first safety tranche.
4. Implement viewer-local navigation and socket-wide flow control together.
5. Define raw/semantic subscription negotiation and complete desktop realtime transport.
6. Make terminal history globally bounded and observable.
7. Build pairing, presence/follow mode, and attention features on the corrected foundations.

## Verification performed

### Passed

- `vp run typecheck`
- 119 focused TypeScript tests
- Two-browser shared-terminal Playwright scenario
- 9 security E2E scenarios
- Desktop: 7 tests, formatting, clippy, and design-contract validation
- `git diff --check`

### Outstanding

- `vp run lint`: approximately 628 errors and 28 warnings
- `vp run test:e2e:critical`: task not found
- `vp run test:runtime:e2e`: task not found
- `pnpm audit --prod`: one high transitive Undici advisory and four moderate advisories

## Suggested implementation-plan set

If this audit is decomposed into implementation plans, begin with:

1. CI and quality-gate repair.
2. Multi-client characterization suite.
3. Lossless consumption ACK and replay-gap recovery.
4. Viewer-local navigation and resize authority.
5. Pre-authentication resource bounds.
6. Raw/semantic stream negotiation and desktop realtime parity.
