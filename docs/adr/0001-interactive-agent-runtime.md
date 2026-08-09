# ADR 0001: Interactive agent runtime

Status: Accepted

## Context

YAADE already observes terminal-launched coding agents through
`@yaade/agent-telemetry` (formerly `@yaade/agents`). That package ingests provider hooks and plugins, reduces
telemetry into session snapshots, and projects attention into notifications.
It does not control provider conversations.

Interactive chat requires commands, exact action responses, durable thread
history, provider-native resume bindings, and streamed semantic content. Those
requirements have different identities and lifecycle rules from CLI telemetry.

The repository also contains TypeScript ACP mock infrastructure ported from a
retired server. It is useful test input, but it is not the application domain
model and does not justify reviving the retired Rust architecture.

## Decision

YAADE has two agent planes:

- `@yaade/agent-telemetry` owns CLI telemetry. `@yaade/agents` remains a
  compatibility re-export while existing imports migrate.
- Interactive execution uses durable `AgentThread` state derived from canonical
  commands and events.

A provider is the user-facing agent identity. A driver is the concrete,
host-side integration strategy. Driver selection may be automatic when a thread
is created, but a durable thread remains bound to its selected driver.

The browser consumes canonical thread snapshots and events through
`AgentRuntimeClient`. It never imports or communicates with a provider driver.
ACP, app-server protocols, SDKs, and structured CLI streams are adapters behind
the driver contract, not architectural boundaries.

Canonical wire structures use Effect Schema. The runtime owns event IDs,
per-thread sequence numbers, connection generations, command idempotency, and
persist-before-publish ordering. Provider option IDs and session IDs remain
opaque and are round-tripped exactly.

Terminology is fixed as follows:

| Term | Meaning |
| --- | --- |
| `ProjectSessionId` | Existing durable YAADE mux/worktree session |
| `AgentThreadId` | Durable YAADE-managed interactive conversation |
| `AgentTurnId` | One user submission and its execution |
| `ProviderSessionId` | Opaque provider-native conversation identity |
| `AgentConnectionId` | One live provider connection/process |
| `DriverId` | Concrete integration mechanism |

## Consequences

- Existing CLI hook ingestion, unread state, and notifications are not changed.
- Interactive packages cannot import either telemetry package or reuse its event
  union.
- Provider-specific behavior is normalized host-side and expressed to the UI
  through negotiated capabilities, configuration, semantic items, and optional
  namespaced extensions.
- Project-session payloads store only pane-to-thread references; thread
  timelines belong in their own durable event store.
- The first implementation sequence is protocol, reducer/invariants, driver
  contract, deterministic mock, host runtime, browser client, UI, then real
  drivers.
