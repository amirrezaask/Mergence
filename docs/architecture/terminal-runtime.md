# Terminal runtime architecture

## Scope

YAADE's terminal path is a three-boundary system:

```text
browser / Electron  <->  host server  <->  detached PTY supervisor
```

The host owns HTTP, WebSocket, authentication, product metadata, and routing.
The supervisor owns `node-pty` handles and child-process lifetime. A host
restart must therefore disconnect and reconnect to the supervisor rather than
call `stopAll()`.

## Current compatibility model

Host-to-supervisor traffic is still length-prefixed JSON. Current-generation
owners advertise `protocolMax: 2` and accept both:

* legacy v1 `{ kind: "req" }` frames, adapted by `legacy-v1-adapter.ts`;
* typed v2 `{ version: 2, kind: "command" }` frames with deadlines, operation
  limits, and mutation command IDs.

`SupervisedTerminalHost` handshakes with v1, then sends v2 for fenced mutations
and other mapped operations when the owner reports protocol 2. Unmapped flow
control remains v1. Legacy owners that do not know `handshake` stay attached.

Current-generation terminals parse PTY output with `@yaade/ghostty-core`. Query
responses are written through a bounded `PtyWriteQueue` shared with user input.
The host publishes semantic snapshots on `terminal:semantic`; the browser
applies them through `TerminalV3Store` and a remote cell renderer. Legacy
terminals keep the bounded raw replay ring, `BasicTerminalStateRecorder`, and
the parser-backed Ghostty surface.

Writer authority lives in the supervisor. Host-memory `TerminalLeaseService` is
a compatibility projection for legacy owners only. Production
`MultiGenerationTerminalHost.connect` requests a current generation with
`authoritativeLeases` and `semanticTerminalState`.

Recovery snapshots are last-known historical state written off the PTY path
(`YAADE_TERMINAL_HISTORY=disabled|screen-only|screen-and-scrollback`). They are
never reported as a live process.

## Target ownership invariants

1. Every PTY is owned by exactly one supervisor generation.
2. A terminal ID resolves to exactly one owner epoch.
3. Host and client restarts do not change PTY ownership.
4. The owner parses every output byte before publishing terminal state.
5. `terminalEpoch` is immutable for the lifetime of a terminal.
6. Semantic state revisions and raw output sequences are distinct counters.
7. Reliable control messages are ordered and bounded.
8. Render messages are replaceable; a slow client is resynchronized or closed.
9. No client backpressure pauses a PTY.
10. Mutations require an explicit, owner-validated authority fence.

## Generation-draining upgrades

The public `node-pty` API does not provide a supported live master-handle
transfer between Node processes. YAADE therefore uses generation draining
instead of descriptor passing:

* the newest compatible generation accepts new terminals;
* existing terminals stay with their original owner;
* the host routes operations to all live generations;
* an old generation is marked draining and rejects new creates;
* it exits only after its terminal count reaches zero.

`MultiGenerationTerminalHost` discovers both the legacy manifest and
`pty-runtimes/<ownerId>/manifest.json` generations, maps new IDs to their owner,
and keeps old IDs routable. `markDraining` changes the registry state so the
owner remains available for existing terminals but is no longer selected for
new creates; `shutdownWhenEmpty` is the only normal exit path.

An old supervisor must never be killed merely because its code or protocol is
older. A stale manifest may be removed only after process identity validation.

## Recovery boundaries

A live owner's in-memory model is authoritative. A recovery snapshot is only a
last-known historical view after owner loss; it is never reported as a live
process. Machine reboot, an unexpected owner crash, and arbitrary-process resume
remain explicit limitations unless the process itself has a native resume
protocol.

## Migration order

1. fixtures and process-level harness;
2. request principals and route capabilities;
3. owner-side leases and mutation fencing;
4. bounded per-client mailboxes with no PTY pause;
5. typed supervisor protocol plus legacy adapter;
6. multi-generation registry/router;
7. Node-loadable Ghostty core;
8. owner-side semantic snapshots and patches;
9. structured input encoding in the owner;
10. recovery snapshots, health, and cross-platform failure gates.

Each step must keep the legacy path available until the replacement has an
independent compatibility and failure test.
