# Creating an interactive agent driver

This guide is the implementation checklist for adapting a provider to YAADE's
interactive agent protocol. Read
[`docs/interactive-agent-system.md`](interactive-agent-system.md) and
[`docs/adr/0001-interactive-agent-runtime.md`](adr/0001-interactive-agent-runtime.md)
first.

## Choose the smallest adapter boundary

Use this order:

1. Add a profile to an existing standards-based driver when the provider speaks
   that protocol. Cursor belongs in `@yaade/agent-driver-acp` because its CLI
   exposes ACP v1.
2. Add a provider hook to that profile only for a documented vendor extension
   or command-detection difference.
3. Create a new driver package only when the provider transport or lifecycle
   cannot be represented without contaminating the generic adapter.

Do not create a provider package solely for branding, capability labels, or a
different executable name. Conversely, do not add provider-ID conditionals to
generic ACP parsing. Express a vendor difference as a typed profile hook.

## The `AgentDriver` contract

Implement `AgentDriver` from `packages/yaade-agent-driver/src/index.ts`:

```ts
interface AgentDriver {
  readonly descriptor: AgentDriverDescriptor
  detect(context: AgentDriverDetectionContext): Promise<AgentDriverDetection>
  openThread(
    context: AgentDriverContext,
    request: OpenAgentThreadRequest,
  ): Promise<AgentThreadConnection>
}
```

The descriptor separates user-facing `providerId` from the concrete `driverId`.
`detect` must be fast, side-effect-free beyond a bounded version/auth probe, and
abortable. It reports why a driver is unavailable so the start UI can offer an
actionable remedy.

`openThread` receives one of three explicit lifecycle modes:

- `new`: create a provider session;
- `load`: load a provider session and replay its history when supported;
- `resume`: reconnect without asking the provider to replay history when
  supported.

Never silently substitute one mode for another. Return a stable provider
session binding when the provider supplies one, truthful negotiated
capabilities, initial configuration, a command sender, an async canonical event
stream, and an idempotent close operation.

## Use only the controlled driver context

`AgentDriverContext` is the host security boundary. It supplies:

- workspace root checks;
- filesystem reads/writes;
- bounded terminal handles;
- provider process spawning;
- host-owned executable resolution and bounded version/auth probes;
- attachment metadata resolution plus controlled `read(attachmentId)` bytes;
- allowlisted credential lookup;
- normalized typed MCP discovery (`stdio`, `http`, or `sse` transports);
- clock, logger, and cancellation.

Do not import host persistence, reach into the mux UI, use raw Node filesystem
or child-process APIs, or read arbitrary environment variables from a driver.
Validate every provider-requested path with `workspace.assertAllowed` before
access. Convert between file URIs and native absolute paths only at the protocol
boundary and with shared URI helpers.

Uploaded attachments are host-owned temporary objects. Drivers obtain their
metadata with `attachments.resolve(...)` and their bounded content with
`attachments.read(...)`; they must not open the attachment storage key or any
other raw host path. This is the path used to map uploaded images into a native
provider content block.

`AgentMcpRegistry` returns typed transport descriptors. ACP profiles translate
those descriptors into schema-exact, non-empty `mcpServers` values for
new/load/resume. Registry IDs are host-local correlation keys and are stripped
at the ACP wire boundary; native command, URL, headers, and environment fields
are preserved according to the negotiated transport schema.

## Normalize the native lifecycle

A successful adapter normally performs these steps:

1. Validate the thread workspace and spawn/connect through the context.
2. Negotiate the native protocol and reject unsupported versions.
3. Decode the provider response at the external boundary.
4. Create, load, or resume the native session exactly as requested and allowed
   by negotiated capabilities.
5. Return `AgentThreadConnection` with an opaque binding and truthful capability
   map.
6. Translate commands to native requests and native updates to
   `UnsequencedAgentEvent`.
7. Attach native event IDs/cursors when available.
8. Stop the provider, reject pending RPCs, close terminal handles, and close the
   event queue exactly once.

If a provider announces a capability that YAADE does not expose or the adapter
does not implement, advertise it as unsupported. Capability truth is more
important than provider feature parity.

## Command mapping

Handle every canonical command explicitly:

| Command | Driver responsibility |
| --- | --- |
| `turn.submit` | Resolve inputs and attachments, submit one native turn, and correlate resulting events |
| `turn.interrupt` | Invoke native cancellation and eventually emit a terminal turn event |
| `action.respond` | Verify the action and exact option/field IDs were advertised, resolve once, reject stale or duplicate replies |
| `configuration.set` | Validate the option and value against negotiated configuration, then emit the updated configuration |
| `thread.close` | Invoke native close only when supported, always tear down local resources |

Track command IDs within the connection and return `already-applied` for a
duplicate. Do not invent a new ID when UI code retries an action response.

The host durably claims a command before dispatching it to a driver. If the host
crashes after that claim and cannot prove the provider outcome, recovery returns
the non-retryable `agent.command-outcome-unknown` error and never automatically
redispatches the command. This chooses possible omission over duplicating a
provider side effect; the user must inspect the durable timeline/provider state
before issuing a new command ID.

## Event and content mapping

Prefer semantic canonical items over a generic text dump:

- assistant prose -> `assistant-message`;
- private/native thought stream -> `reasoning` only when the provider exposes it;
- command, file, search, web, or MCP activity -> `tool-call` with a stable
  category and lifecycle;
- structured plan -> `plan`;
- patch -> `diff`;
- delegated work -> `subagent`;
- files or media -> `artifact`;
- provider failures -> `error` item, `turn.failed`, or `agent.error` as
  appropriate.

Start an item before deltas, increment revisions monotonically, and complete it
with the full accumulated content. A final provider notification that omits
text must not replace accumulated streamed text with an empty value.

Namespaced `extension` events/items are an escape hatch for lossless data, not a
way to bypass normalization. The generic UI may ignore an extension safely.

## Actions and configuration

Permission, elicitation, and authentication are pending actions. Store the
exact native request and allowed response identifiers until resolved. Reject:

- unknown action IDs;
- option IDs that were not advertised;
- a second response to an already resolved action;
- configuration option IDs or values not in the negotiated schema.

Do not synthesize permission semantics from labels. The adapter may add a
canonical decision (`allow-once`, `reject-always`, and so on) for display, but
the response must round-trip the native opaque option ID.

## Bounds and failure behavior

Every new driver must define and test bounds for:

- native protocol line/frame size;
- pending RPC requests and pending actions;
- queued events by count and bytes;
- semantic text and structured tool payloads;
- simultaneously open terminal handles;
- attachment size/type;
- shutdown grace time.

The production driver context caps a thread at eight concurrently owned
provider processes and eight terminal handles. Context cancellation is a
cleanup backstop: it stops remaining processes and closes remaining terminals,
but drivers still close resources promptly on normal completion, interrupt,
explicit thread close, and failure.

Malformed or oversized native input must become a bounded error and cleanup,
not an unhandled exception or unbounded allocation. Log metadata, not prompts,
credentials, or full tool output.

## Testing requirements

Add tests in layers:

1. Boundary decoding and unit tests for capability, content, configuration,
   lifecycle, and error mapping.
2. Deterministic native-protocol fixtures, including malformed, disconnect,
   cancellation, permissions, elicitation/authentication, attachments, config,
   filesystem, terminal, replay, and oversized output.
3. `runAgentDriverConformanceSuite` from `@yaade/agent-testkit` for the shared
   lifecycle and duplicate-command contract.
4. Host runtime tests for persistence, restart/reconnect, idempotency, workspace
   isolation, and replay gaps.
5. Playwright assertions against the generic agent UI. A new visual capability
   is incomplete without browser verification.
6. An opt-in real-provider smoke test for compatibility. Keep it outside normal
   CI when it requires credentials, network access, or billable turns.

Useful commands:

```bash
pnpm --filter @yaade/agent-driver-<name> test
pnpm --filter @yaade/agent-driver-<name> typecheck
pnpm -r typecheck
pnpm test
pnpm test:e2e
```

Real-provider tests must use an explicit environment gate such as
`YAADE_CURSOR_LIVE=1`, describe any usage/cost before running, avoid destructive
prompts, and never print account details or tokens.

Before the full browser matrix, use the shared scenario runner for a free probe
and then one minimal canonical turn:

```bash
pnpm agent:scenario -- --driver=all --probe
pnpm agent:scenario -- --driver=cursor --live
```

The live scenario runs in an isolated temporary workspace, disables terminal,
attachment, and file-write use, rejects any permission request, requires an
exact sentinel reply, and validates the native event stream through the
canonical reducer. It is the cheap compatibility gate; it does not replace
provider-specific UI, permission, tool, interrupt, reload, or recovery coverage.

For Cursor, the opt-in Playwright suite is:

```bash
YAADE_CURSOR_LIVE=1 PLAYWRIGHT_WORKERS=1 pnpm exec playwright test --project=web-e2e tests/electron/cursor-agent.electron.spec.ts
```

The suite is skipped by default and prints a warning immediately before each
prompt. It uses the isolated sample workspace and covers discovery/version, a
new exact-response turn, observable streaming, a read-only tool, permission
rejection, interrupt, browser reload/recovery, and explicit close. Setting the
environment variable is an acknowledgement that the prompt-bearing tests may
consume provider quota or incur cost. Merely adding or collecting the skipped
suite is not live verification.

## Registration and UI verification

Register the driver in `apps/host-server/src/host-runtime.ts`. The host registry
groups descriptors by provider, performs discovery for the current workspace,
selects the highest-priority available driver unless a `driverId` is explicit,
and publishes registry changes.

No UI registration is needed. If the descriptor is discovered, the generic
start view can show it. If a new capability cannot be represented by the
canonical protocol and generic UI, extend protocol -> runtime -> RPC -> UI in
that order before advertising it.

For visual verification, use the Mock driver first, then an opt-in real driver:

```bash
pnpm agent:demo
PLAYWRIGHT_WORKERS=1 pnpm exec playwright test --project=web-e2e tests/electron/agent-runtime.electron.spec.ts
```

## Definition of done for a driver

- Detection returns real version/auth availability and an actionable reason.
- New/load/resume/close obey negotiated native capabilities.
- The shared conformance suite passes.
- Streaming messages, tools, actions, configuration, attachments, interrupt,
  errors, and cleanup have deterministic tests where supported.
- Capabilities match verified behavior; unsupported features remain hidden.
- Native IDs and cursors are preserved for replay deduplication.
- Workspace, filesystem, process, credential, terminal, and size boundaries are
  enforced.
- Restart/recovery and generic UI behavior are verified.
- The support matrix and provider-specific caveats are documented.

## Current driver status

The evidence labels in this table are deliberately strict:

- **deterministic** means a checked-in native-protocol fixture or canonical Mock
  ran without credentials or provider usage;
- **read-only live probe** means an installed CLI was inspected without sending
  a turn;
- **live smoke** means the isolated scenario runner completed one exact-response
  turn through the canonical reducer;
- **live verified** means the gated prompt-bearing suite passed on the stated
  version.

| Driver | Deterministic evidence | Real-provider evidence | Production sign-off |
| --- | --- | --- | --- |
| Mock | Canonical lifecycle, duplicate-command contract, recovery scenarios, and the generic UI matrix | Not applicable | Reference implementation |
| Generic ACP | Shared lifecycle; streamed-text completion; permission option validation; terminal bridge; dynamic configuration; reasoning/tool lifecycle; structured elicitation; RPC, queue, and semantic-output bounds | None; a generic ACP peer is used for deterministic tests | Not independently signed off |
| Cursor (`cursor:acp`) | Strict ACP v1 initialization/cwd/MCP shape; native load and close; unsupported-resume rejection; image bytes; native IDs/cursors; vendor-elicitation gating; malformed-version/session rejection; command/version/auth detection | Probe and isolated exact-response smoke passed on `2026.08.04-aaa8809` (2026-08-09). The full `YAADE_CURSOR_LIVE=1` suite has not been run | **Not signed off**: full lifecycle, host-restart load, and minimum-version evidence remain pending |
| Codex (`codex:app-server`) | Adapter and deterministic tests present | Real-adapter fidelity matrix has not been recorded | Not signed off |
| Claude (`claude:agent-sdk`) | Adapter and deterministic tests present | Real-adapter fidelity matrix has not been recorded | Not signed off |

### Cursor verification matrix

| Behavior | Deterministic ACP/Cursor evidence | Live Cursor evidence |
| --- | --- | --- |
| Discovery and protocol initialization | Alias fallback, real-version parsing, auth remedy, abort/probe failure, strict v1 capability/MCP transport and malformed-boundary tests | Probe passed on `2026.08.04-aaa8809` |
| New/load/resume/close | New/load/close request shapes verified; unadvertised resume is rejected | New session observed in the smoke; load/resume/close remain unsigned |
| Streaming and exact final text | Accumulated-text completion and Cursor fixture completion verified | Isolated smoke streamed reasoning and assistant text, returned the exact sentinel, and reduced to idle with no violations |
| Read-only tool and terminal bridge | Deterministic normalized lifecycle/terminal coverage | Opt-in read-only tool test present, not executed here |
| Permission rejection and exact option IDs | Deterministic validation and race coverage | Opt-in rejection test present, not executed here |
| Configuration, elicitation, authentication, images | Dynamic configuration and structured elicitation are covered generically; Cursor image mapping reads controlled attachment bytes; Cursor vendor elicitation is profile-gated | Not signed off |
| Interrupt, reload/recovery, native replay | Deterministic runtime/Mock coverage | Opt-in interrupt and browser-reload tests present; host-restart/native-load result not recorded |

Do not move a cell to live verified, advertise a pinned minimum version, or call
Cursor production-ready until the gated suite passes and its result is recorded.
The live suite intentionally uses the same provider-neutral start view, status,
timeline, tool card, action dock, composer, configuration surface (when
negotiated), and recovery path as Mock; it adds no Cursor-specific UI branch.

The implementation plan for Cursor is
[`plans/001-productionize-cursor-acp-driver.md`](../plans/001-productionize-cursor-acp-driver.md).

## External protocol references

- [ACP v1 overview](https://agentclientprotocol.com/protocol/v1/overview)
- [ACP initialization and capability negotiation](https://agentclientprotocol.com/protocol/v1/initialization)
- [ACP session setup and lifecycle](https://agentclientprotocol.com/protocol/v1/session-setup)
- [Official ACP TypeScript SDK](https://agentclientprotocol.com/libraries/typescript)
- [Cursor CLI usage and authentication](https://docs.cursor.com/en/cli/using)
- [Cursor CLI parameters](https://docs.cursor.com/en/cli/reference/parameters)
