# Interactive agent system

This document describes YAADE's provider-agnostic interactive agent system as
implemented in August 2026. The architectural decision is recorded in
[`docs/adr/0001-interactive-agent-runtime.md`](adr/0001-interactive-agent-runtime.md),
and the practical adapter checklist lives in
[`docs/agent-driver-guide.md`](agent-driver-guide.md).

## Scope: two separate agent planes

YAADE deliberately separates passive observation from interactive execution:

- `@yaade/agent-telemetry` observes terminal-launched agents and projects
  attention into notifications. `@yaade/agents` is its compatibility export.
- The interactive runtime creates, controls, persists, and resumes agent
  conversations. Its durable aggregate is an `AgentThread`.

Do not share event unions, reducers, or lifecycle state between these planes.
Telemetry describes a process that may exist outside YAADE. An interactive
thread is owned by YAADE and accepts commands.

## Architecture

```text
AgentChatView (provider-neutral React)
  -> MuxAgentChatPane
  -> window.yaade.agentRuntime
  -> AgentRuntimeClient + external store
  -> HTTP/WS Effect Schema RPC
  -> AgentThreadRuntime
  -> AgentDriver
  -> ACP / Codex app-server / Claude SDK / deterministic Mock

Provider stream
  -> driver normalization
  -> UnsequencedAgentEvent
  -> runtime envelope + durable store
  -> publish over WS
  -> browser reducer
  -> AgentChatView
```

The direction is intentional. UI packages never import provider drivers, and a
driver never sends provider-native payloads directly to the browser.

### Package responsibilities

| Package or module | Responsibility |
| --- | --- |
| `@yaade/agent-protocol` | Effect Schema identities, commands, events, items, actions, capabilities, snapshots, and reducer |
| `@yaade/agent-driver` | Host-only adapter contract and controlled provider services |
| `@yaade/agent-runtime` | Provider-neutral reducer and runtime helpers |
| `@yaade/agent-driver-mock` | Deterministic canonical scenarios used by demos and tests |
| `@yaade/agent-driver-acp` | ACP v1 transport plus provider profiles such as Cursor |
| `@yaade/agent-driver-codex` | Codex app-server adapter |
| `@yaade/agent-driver-claude` | Claude Agent SDK stream adapter |
| `@yaade/agent-testkit` | Shared driver lifecycle conformance checks |
| `apps/host-server/src/agent-runtime/` | Registry, connection lifecycle, SQLite event store, recovery, attachments, and context security boundary |
| `packages/yaade-app/src/agent/` | Browser runtime client, gap repair, project-session thread binding, and mux pane controller |
| `packages/yaade-ui/src/agent-chat/` | Provider-neutral timeline, action dock, configuration controls, and composer |

## Identities and bindings

These identifiers are not interchangeable:

| Identity | Owner | Lifetime |
| --- | --- | --- |
| `ProjectSessionId` | YAADE mux | Workspace layout/worktree session |
| `AgentThreadId` | YAADE runtime | Durable interactive conversation |
| `AgentTurnId` | YAADE/provider adapter | One submitted user turn |
| `ProviderSessionId` | Provider | Opaque native conversation reference |
| `AgentConnectionId` | Driver | One live provider process or connection |
| `ProviderId` | Registry | User-facing provider, such as `cursor` |
| `DriverId` | Registry | Concrete integration, such as `cursor:acp` |

A project-session layout stores a thread reference, not a transcript. The
runtime persists the transcript and the provider binding independently. Once a
thread selects a driver, that durable thread remains bound to it.

## Canonical protocol

All host/browser wire values are decoded with Effect Schema. Protocol version 1
has five commands:

- `turn.submit` sends text, attachments, or workspace resources.
- `turn.interrupt` interrupts a known turn.
- `action.respond` resolves a permission, elicitation, or authentication action.
- `configuration.set` changes a negotiated provider option.
- `thread.close` explicitly closes the interactive thread.

Every command is wrapped in `AgentCommandEnvelope`, which includes a unique
`commandId`, thread ID, timestamp, protocol version, and optional expected
revision. Results are `accepted`, `already-applied`, or `rejected`.

Drivers emit unsequenced canonical events. The runtime adds the durable
`eventId`, per-thread `sequence`, timestamps, command correlation, connection
generation, and optional provider cursor. The main event families are:

- thread open, binding, capability, configuration, status, and close changes;
- turn start, complete, fail, and interrupt;
- item start, text delta, update, and completion;
- pending action request and resolution;
- usage, recoverable errors, and namespaced extensions.

The timeline supports user and assistant messages, reasoning, tool calls,
plans, diffs, subagents, artifacts, errors, and extension items. Provider-native
constructs must be mapped into one of these types before leaving a driver.

### Capability negotiation

Each feature is `native`, `emulated`, `unsupported`, or `unknown`. Capabilities
cover input types, thread lifecycle, turn control, structured output, tools,
interactive actions, and configuration. The UI renders controls from these
capabilities; it must not branch on provider or driver IDs.

Advertise only behavior that the adapter implements and tests. A provider's
native capability is not automatically a YAADE driver capability.

### Opaque values

Provider session IDs, action IDs, configuration option IDs, permission option
IDs, provider cursors, and native event IDs are opaque. Preserve and round-trip
them exactly. Never infer meaning by splitting, lowercasing, or rebuilding them.

## Runtime durability and recovery

`AgentThreadRuntime` is authoritative for sequencing and persistence:

1. A driver emits an `UnsequencedAgentEvent`.
2. The runtime assigns the envelope metadata.
3. The event and aggregate state are persisted to SQLite.
4. Only after persistence succeeds is the event published to browsers.

The reducer is deterministic: the same snapshot plus ordered events must produce
the same state. Streaming deltas may be coalesced for storage and publication,
while final semantic content remains lossless within documented size bounds.
Snapshots are periodic recovery accelerators, not a second source of truth.

Command IDs make retries idempotent. Drivers must also reject duplicate command
IDs within a connection, but runtime durability is the cross-process authority.
Provider-native event IDs or cursors should be attached whenever available so a
reconnect cannot duplicate replayed content.

The runtime durably claims each command before driver dispatch. A crash after
that claim can leave the external side effect unknowable; recovery surfaces the
non-retryable `agent.command-outcome-unknown` result and does not automatically
redispatch it. This prevents a retry from silently duplicating a provider-side
effect. The user can inspect the durable timeline/provider state and explicitly
issue a new command if appropriate.

The browser `AgentRuntimeClient` feeds an external store rather than placing
the token stream in React state. It detects sequence gaps, requests a snapshot
or events after its last sequence, and updates connection state while recovery
is in progress. A reload therefore restores from the host, not from a transcript
cached in the page.

## UI and user flow

`MuxAgentChatPane` is the stateful bridge between a mux pane and the generic
`AgentChatView`.

1. The pane asks the host for existing threads and driver discovery in the
   current session workspace.
2. If no thread is selected, the start view shows available/unavailable drivers
   and existing threads.
3. Creating a thread sends the project-session ID, workspace URI, and selected
   provider. The host selects and binds the concrete driver.
4. The browser hydrates the returned snapshot and subscribes to canonical
   events, connection changes, registry changes, and replay-gap signals.
5. The timeline renders streaming messages, reasoning, tools, plans, diffs,
   usage, errors, and status without provider-specific components.
6. Pending permission, elicitation, and authentication actions appear in the
   action dock. The exact advertised option ID is returned once.
7. Negotiated configuration appears as generic controls. Unsupported controls
   do not appear.
8. The composer submits text, uploaded attachments, or workspace resources and
   exposes interrupt while a turn is running.

The agent pane stores its `AgentThreadId` in project-session layout persistence.
Switching panes or reloading does not copy the transcript into that layout.

## Demo and deterministic scenarios

Use the canonical Mock driver to review the protocol and UI without credentials
or provider usage:

```bash
pnpm agent:demo
```

The script starts YAADE, opens an agent pane, and walks through a deterministic
showcase containing streaming text, reasoning, tools, plan updates, permission,
elicitation, configuration, attachment, and completion states.

For targeted scenarios:

```bash
pnpm agent:scenario -- --help
pnpm agent:scenario:ui
```

The same runner provides a cheap compatibility ladder for every native driver.
Detection is read-only and submits no prompt:

```bash
pnpm agent:scenario -- --driver=all --probe
pnpm agent:scenario -- --driver=cursor --probe
```

When a probe passes, run one isolated, tool-free sentinel turn. The runner uses
a temporary workspace by default, requires the exact
`YAADE_AGENT_SMOKE_OK` response, rejects permission requests, and emits the same
canonical trace and reducer invariants as Mock scenarios:

```bash
pnpm agent:scenario -- --driver=cursor --live
```

`--live` may consume provider quota. Use `--cwd=/path` only when deliberately
testing a real project; the temporary workspace is cheaper and safer.

The Mock driver speaks the same `AgentDriver` contract and emits the same
canonical protocol as production drivers. It replaces only the native provider
transport.

## Verification evidence and Cursor live testing

Three evidence levels are kept separate:

1. Deterministic Mock and native-protocol fixtures verify the canonical
   lifecycle, adapter mapping, host recovery, and provider-neutral UI without
   credentials or usage.
2. A read-only live probe may verify that an installed provider binary reports
   a version and compatible protocol initialization. It does not verify a turn,
   lifecycle recovery, or production readiness.
3. A gated live Playwright suite verifies actual provider behavior. For Cursor,
   run it only after acknowledging that prompt-bearing cases may consume quota
   or incur cost:

```bash
YAADE_CURSOR_LIVE=1 PLAYWRIGHT_WORKERS=1 pnpm exec playwright test --project=web-e2e tests/electron/cursor-agent.electron.spec.ts
```

The Cursor suite is skipped in default CI and warns immediately before every
real prompt. Its isolated fixture matrix covers discovery/version, a new
exact-response turn, visible streaming, a safe read-only tool, permission
rejection, interrupt, browser reload/recovery, and explicit close. Native load
after host restart is a separate release gate when the installed CLI advertises
load; resume must not be claimed unless it is both advertised and observed.

Current status is conservative: deterministic Mock/ACP and generic Playwright
coverage exist, and the isolated sentinel scenario passed against Cursor
`2026.08.04-aaa8809` on 2026-08-09. The full gated Playwright matrix,
load-after-host-restart behavior, and a minimum supported Cursor version remain
unverified, so `cursor:acp` is not yet live signed off. See the exact matrix in
[`docs/agent-driver-guide.md`](agent-driver-guide.md#cursor-verification-matrix).

Live assertions target canonical state and generic DOM surfaces: the shared
start view, connection marker, timeline, tool cards, action dock, configuration
controls when negotiated, composer, and restored timeline after reload. The UI
must not branch on `providerId === "cursor"` or `driverId === "cursor:acp"`.

## Non-negotiable invariants

- The browser and `@yaade/ui` never import or inspect a provider driver.
- Provider payloads are decoded at the adapter boundary; do not pass `unknown`
  native objects into the canonical reducer.
- All filesystem, terminal, process, attachment, credential, and MCP access
  goes through `AgentDriverContext`.
- Executable discovery and version/auth probes use the host-owned `commands`
  service; adapter packages never inspect `PATH` or spawn probe processes.
- Uploaded attachment content is read through the bounded
  `attachments.read(attachmentId)` service. Drivers never open a temporary
  attachment storage key or raw host path directly.
- MCP discovery exposes typed `stdio`, `http`, and `sse` descriptors. ACP sends
  schema-exact descriptors on new/load/resume and strips host-local registry IDs
  at the native wire boundary.
- A driver is scoped to the thread workspace, not every host allowed root.
- Do not read arbitrary `process.env` values on a provider's request.
- Persist canonical events before publishing them.
- Bound queues, pending requests, terminal handles, text, tool payloads, and
  attachment sizes. Close every provider process and terminal handle.
- The production context owns at most eight provider processes and eight
  terminal handles per thread. Cancellation stops/closes any remainder as a
  cleanup backstop.
- Preserve exact native IDs and emit truthful capabilities.
- Keep passive agent telemetry separate from interactive thread state.
