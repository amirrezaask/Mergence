# Plan 001: Productionize the Cursor ACP driver

- **Status:** Implemented; live Cursor sign-off pending
- **Priority:** P1
- **Effort:** Large
- **Risk:** Medium
- **Planned against:** `593aa846` plus the current uncommitted interactive-agent foundation
- **Date:** 2026-08-09
- **Suggested branch:** `codex/cursor-acp-driver`

## Implementation result

Phases 1–5 and the non-live parts of Phase 6 are implemented. The strict ACP
fixture, package/host tests, monorepo typecheck and unit suite, and all 19
generic agent Playwright scenarios pass. The gated Cursor suite is present and
skips all five prompt-bearing cases unless `YAADE_CURSOR_LIVE=1` is explicitly
set.

An isolated exact-response smoke passed against Cursor
`2026.08.04-aaa8809` on 2026-08-09. Production sign-off remains intentionally
pending because the full gated Cursor suite and native load-after-host-restart
have not been run, and no minimum Cursor CLI version has been pinned. The full
web E2E run completed with 121 passing, 6 skipped, and 6 failures in unrelated
HQ, LSP/editor, mux, and terminal tests; the complete agent block passed.

## Executive summary

YAADE is ready to implement and sign off a Cursor driver because the canonical
protocol, durable runtime, browser client, generic UI, deterministic Mock, and
ACP adapter boundary already exist. Cursor should remain a profile of
`@yaade/agent-driver-acp`; do not create `@yaade/agent-driver-cursor` unless a
captured incompatibility cannot be represented by a typed ACP profile hook.

The existing `cursor:acp` registration is not production-ready. Its ACP
initialization capabilities and cwd values do not match ACP v1, optional
lifecycle methods are not fully capability-gated, image/auth support is
misreported or incomplete, and the real Cursor turn/lifecycle matrix has not
been exercised. This plan fixes those boundaries without adding
provider-specific behavior to the UI or canonical runtime.

## Baseline and drift guard

The interactive-agent implementation is currently a large uncommitted change.
Before editing:

```bash
git status --short
git diff --stat
git rev-parse --short HEAD
```

Preserve every existing user change. Do not reset, clean, or rewrite unrelated
files. If the ACP driver, protocol, runtime context, or agent UI has materially
changed since this plan, re-run the characterization tests described below and
update the plan assumptions before implementation.

## Current state

- `cursorAcpProfile()` registers provider `cursor`, driver `cursor:acp`, command
  `agent`, and arguments `acp`.
- `AcpAgentDriver` owns the stdio JSON-RPC adapter and maps messages, reasoning,
  tools, plans, usage, permissions, elicitation, filesystem, terminal, config,
  attachments, cancellation, and close into the canonical contract.
- A deterministic ACP peer and shared conformance suite exist.
- The generic UI discovers the descriptor through the host registry; Cursor
  needs no provider-specific React component.
- A read-only live probe of the installed Cursor CLI verified ACP protocol
  version 1 and advertised native load-session, image input, MCP HTTP/SSE,
  session listing, and a `cursor_login` auth method. No live prompt/turn has
  been run or signed off.

Known mismatches:

1. `initialize.clientCapabilities` sends empty objects for filesystem and
   terminal; ACP v1 requires explicit booleans.
2. Session cwd is sent as a `file://` URI; ACP v1 requires an absolute native
   filesystem path.
3. `session/load` and `session/resume` omit required cwd and MCP server input.
4. Resume and close requests are not consistently gated by negotiated native
   capabilities.
5. Cursor advertises image input, but the adapter currently reports images as
   unsupported and does not have a signed-off content mapping.
6. Cursor advertises authentication methods; unauthenticated startup behavior
   is not represented cleanly before thread creation.
7. The Cursor-only `cursor/ask_question` method is handled in generic ACP logic
   rather than through an explicit profile hook.
8. The adapter performs permissive object extraction at its native boundary;
   ACP schema drift can silently degrade behavior.
9. Native lifecycle/replay IDs and full cleanup behavior need stronger tests.

## Desired state

- Cursor discovery resolves the supported CLI command, reports a real version,
  and gives an actionable unauthenticated reason without exposing account data.
- ACP v1 initialization and session calls use schema-validated payloads,
  absolute native paths, correct client capability booleans, and negotiated
  optional-method gates.
- Cursor-specific extensions are isolated in a typed ACP profile.
- Every advertised canonical capability corresponds to implemented and tested
  behavior.
- New/load/resume/interrupt/close, replay deduplication, actions,
  configuration, images, filesystem, terminal, errors, and cleanup are covered
  by deterministic tests where supported.
- An opt-in real Cursor smoke suite verifies the installed CLI without entering
  default CI or silently consuming provider usage.
- The generic YAADE agent UI renders Cursor with no provider branches.

## Non-goals

- Do not redesign the canonical protocol or agent UI for Cursor branding.
- Do not expose Cursor session listing until the canonical runtime has a
  provider-session listing contract and product requirement.
- Do not fall back to Cursor `stream-json` while ACP is viable.
- Do not add a raw environment-variable or unrestricted filesystem escape hatch.
- Do not run billable live turns without the explicit live-test gate.
- Do not commit, push, or open a PR unless separately requested.

## Phase 1: Characterize the Cursor ACP dialect

### Files

- `apps/host-server/mocks/mock-acp.ts`
- `packages/yaade-agent-driver-acp/src/driver.test.ts`
- `packages/yaade-agent-driver-acp/src/profiles.ts`

### Work

1. Add a Cursor provider profile to the deterministic ACP peer that matches the
   sanitized live `initialize` shape. Never store email, tokens, machine paths,
   or other account data in fixtures.
2. Add tests that capture exact outbound requests:
   - protocol version 1;
   - explicit client filesystem and terminal booleans;
   - absolute cwd for new/load/resume;
   - MCP server input on all session-open modes;
   - optional load/resume/close calls only when advertised;
   - protocol-version mismatch rejection;
   - unknown/native extension behavior.
3. Add an unauthenticated Cursor fixture and define V1 behavior: discovery is
   unavailable with an `agent login` remedy. Do not expand the runtime solely
   to model a pre-thread authentication action in this phase.
4. Record expected image, permission, elicitation, configuration, cancel, and
   session-update shapes as deterministic scenarios before changing mapping
   code.

### Gate

The new characterization tests fail for the known mismatches and pass for the
existing correct behavior. No production behavior changes in this phase.

## Phase 2: Make the ACP v1 boundary exact

### Files

- `packages/yaade-agent-driver-acp/package.json`
- `packages/yaade-agent-driver-acp/src/index.ts`
- `packages/yaade-agent-driver-acp/src/json-line-rpc.ts`
- `packages/yaade-agent-driver-acp/src/async-queue.ts`
- `packages/yaade-agent-driver-acp/src/driver.test.ts`
- `pnpm-lock.yaml`

### Work

1. Evaluate the official `@agentclientprotocol/sdk` v1 TypeScript client. Prefer
   its current fluent client API if it supports YAADE's injected process,
   cancellation, queue bounds, and client callbacks without bypassing
   `AgentDriverContext`.
2. Stop and document the incompatibility instead of adopting the SDK if it
   requires raw spawning, unbounded queues, or hidden filesystem/terminal
   access. In that case, retain `JsonLineRpc` but add explicit schemas for every
   used request, response, notification, and callback.
3. Replace permissive `asObject` interpretation at external boundaries with
   schema decoding and typed protocol errors. Unknown optional fields may be
   ignored; malformed required fields must fail predictably.
4. Send correct ACP v1 client capabilities for read, write, terminal, and
   elicitation support. An omitted or false capability must match actual
   callback behavior.
5. Convert YAADE's file URI to an absolute native path at the ACP boundary.
   Keep file URIs inside the canonical/runtime layers.
6. Preserve current bounds for frames, semantic text, pending RPCs, actions,
   event queues, and process shutdown; add any missing byte bounds.

### Gate

- Boundary tests pass with the Cursor fixture and strict malformed-input cases.
- No driver accesses raw filesystem/process/environment APIs.
- `pnpm --filter @yaade/agent-driver-acp typecheck` passes.

## Phase 3: Introduce a typed Cursor profile

### Files

- `packages/yaade-agent-driver-acp/src/profiles.ts`
- `packages/yaade-agent-driver-acp/src/index.ts`
- `packages/yaade-agent-driver-acp/src/detect-command.ts`
- optional new `packages/yaade-agent-driver-acp/src/cursor-profile.ts`
- `apps/host-server/src/host-runtime.ts`

### Work

1. Extend `AcpDriverProfile` with minimal typed hooks for:
   - executable candidates (`agent`, then `cursor-agent` when supported);
   - version and auth-status probes;
   - vendor request handlers such as `cursor/ask_question`;
   - capability adjustments only where native negotiation is insufficient.
2. Move `cursor/ask_question` out of unconditional generic ACP handling and
   into the Cursor profile hook. Generic standardized elicitation remains in
   the ACP core.
3. Make detection bounded and abortable. Return the real CLI version. For an
   unauthenticated installation, return `available: false` with an actionable
   `Run agent login` reason; never log the account identity or credentials.
4. Keep registration as `new AcpAgentDriver(cursorAcpProfile())`. Do not create a
   separate package unless a failing captured case proves a profile hook would
   distort the ACP core. If that stop condition occurs, report it for an
   architecture decision before proceeding.

### Gate

- Cursor-specific behavior is reachable only through the Cursor profile.
- Grok, OpenCode, and the generic Mock ACP profiles retain their behavior.
- Detection tests cover missing command, alias fallback, authenticated,
  unauthenticated, aborted, and version-probe failure states.

## Phase 4: Correct lifecycle, content, and capabilities

### Files

- `packages/yaade-agent-driver-acp/src/index.ts`
- `packages/yaade-agent-driver-acp/src/driver.test.ts`
- `apps/host-server/mocks/mock-acp.ts`

### Work

1. New sessions call `session/new` with absolute cwd and MCP servers.
2. Loaded sessions call `session/load` only when advertised, include cwd and MCP
   servers, and normalize replayed history without duplicating already durable
   YAADE events.
3. Resumed sessions call `session/resume` only when advertised. If Cursor does
   not advertise resume, the runtime must choose load or surface unavailable;
   the driver must not fake native resume.
4. `thread.close` invokes native `session/close` only when advertised. Local
   process, RPC, queue, actions, and terminals are always cleaned up.
5. Map Cursor image attachments to the ACP v1 content block and advertise image
   input only after a deterministic and live smoke test passes.
6. Verify streamed assistant text, reasoning, tool lifecycle, plans, usage,
   config, permissions, and elicitation. Final item completion must retain all
   accumulated text even when the provider's terminal update has no text.
7. Preserve exact native IDs/options and attach native event IDs or cursors to
   unsequenced events wherever Cursor supplies them.
8. Treat Cursor-advertised session listing as unsupported in the canonical
   capability map until the runtime/UI expose and test it.

### Gate

The deterministic Cursor matrix passes for new/load, all supported content,
interrupt, exact action responses, configuration, attachment/image, terminal,
filesystem, malformed input, disconnect, and cleanup. Capability assertions
match the test matrix exactly.

## Phase 5: Security, bounds, and recovery verification

### Files

- `apps/host-server/src/agent-runtime/context.ts`
- `apps/host-server/src/agent-runtime/runtime.ts`
- `apps/host-server/src/agent-runtime/runtime.test.ts`
- `packages/yaade-agent-driver-acp/src/driver.test.ts`
- `apps/host-server/src/server-replay.test.ts`

### Work

1. Verify every Cursor filesystem callback is restricted to the thread
   workspace and explicitly attached roots, not all host `allowedRoot` values.
2. Verify credential requests use named allowlisted broker entries and cannot
   read arbitrary `process.env` names.
3. Test absolute-path normalization against traversal, sibling roots, malformed
   URIs, symlink policy, and write conflicts with dirty editor buffers.
4. Bound concurrent terminals and pending actions; close all handles on user
   close, interrupt failure, provider exit, host shutdown, and reconnect.
5. Test command replay around provider-side effects and runtime persistence.
   Resolve or explicitly document any remaining crash window before declaring
   production readiness.
6. Test host restart with load-capable Cursor sessions, unavailable provider,
   non-resumable session, native replay, browser sequence gap, and long
   disconnect recovery.

### Gate

Security and recovery tests pass without relaxing existing host boundaries. Any
unresolved command-side-effect crash window or dirty-buffer overwrite is a
release blocker, not a Cursor-specific exception.

## Phase 6: Real Cursor and UI sign-off

### Files

- optional new `tests/electron/cursor-agent.electron.spec.ts`
- `tests/electron/agent-runtime.electron.spec.ts`
- `docs/agent-driver-guide.md`
- `docs/interactive-agent-system.md`

### Work

1. Add an opt-in suite gated by `YAADE_CURSOR_LIVE=1`. Default CI must skip it.
   Print a clear warning before any prompt that may consume provider usage.
2. Run a minimal non-destructive live matrix in an isolated fixture workspace:
   discovery/version, new thread, one exact-response turn, streaming, one safe
   tool request, permission rejection, interrupt, reload/recovery, and close.
3. If the installed CLI supports load, reopen the native session after a host
   restart and verify no duplicate timeline items. Do not claim resume support
   unless Cursor advertises and passes it.
4. Use Playwright DOM assertions and `window.__yaadeAgent` state to prove that
   Cursor uses the same start view, timeline, tool cards, action dock,
   connection status, configuration, composer, and recovery UI as Mock.
5. Update the driver support matrix with only the live behaviors actually
   verified and any pinned minimum Cursor version.

### Gate

- The opt-in live suite passes on the documented Cursor CLI version.
- The complete generic agent Playwright suite passes.
- No provider-specific branch or component was added to the UI.

## Verification commands

Run targeted checks while iterating, then the full matrix:

```bash
pnpm --filter @yaade/agent-driver-acp test
pnpm --filter @yaade/agent-driver-acp typecheck
pnpm --filter @yaade/agent-protocol test
pnpm --filter @yaade/agent-runtime test
pnpm --filter @yaade/host-server test
pnpm -r typecheck
pnpm test
PLAYWRIGHT_WORKERS=1 pnpm exec playwright test --project=web-e2e tests/electron/agent-runtime.electron.spec.ts
PLAYWRIGHT_WORKERS=1 pnpm test:e2e
```

Opt-in only, after explicit acknowledgement of provider usage:

```bash
YAADE_CURSOR_LIVE=1 PLAYWRIGHT_WORKERS=1 pnpm exec playwright test --project=web-e2e tests/electron/cursor-agent.electron.spec.ts
```

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Cursor ACP changes between CLI releases | Strict protocol decoding, sanitized fixtures, real version reporting, opt-in compatibility smoke |
| Official SDK bypasses YAADE bounds/context | Evaluate before adoption; retain the bounded transport if requirements are not met |
| Provider replay duplicates durable events | Preserve native IDs/cursors and test load/restart against existing sequences |
| Capability overstatement exposes broken UI | Derive from negotiated + implemented behavior and assert every advertised capability |
| Live tests consume usage or alter files | Explicit environment gate, warning, isolated fixture, minimal non-destructive prompts |
| Cursor extensions pollute generic ACP | Typed profile hooks and a stop condition before creating a separate package |
| Provider side effect precedes command durability | Runtime idempotency/recovery test and release-blocking resolution/documentation |

## Final definition of done

Cursor is production-ready only when all phase gates pass, the generic UI has
been visually verified, and the documentation states the exact supported
lifecycle/capability matrix. Registration or a successful `initialize` probe
alone is not completion.
