# Terminal runtime

YAADE uses one host process as the terminal multiplexer:

```text
browser  <->  host server  <->  TerminalHost  <->  node-pty children
```

`TerminalHost` owns PTY handles, bounded replay, Ghostty semantic state, writer
leases, resize/input routing, and child cleanup. There is no detached supervisor,
local supervisor protocol, runtime generation registry, or disk-backed terminal
recovery.

## Lifetime

- Browser reloads and disconnects only remove viewers. PTYs continue running.
- Closing a terminal disposes its PTY.
- Host shutdown or crash ends all PTYs.
- Host startup discards persisted Session, Window, terminal, and terminal-instance
  rows, then creates one fresh Session.
- Users must not restart the host while a long-running command matters.


## Data path

PTY output remains opaque ordered bytes from each host read through immutable
`Bytes` replay/history/live frames, binary WebSocket payloads, browser
`Uint8Array` replay coordination, and the Ghostty worker. Only terminal IDs and
completed textual protocol metadata are UTF-8 decoded. Durable history stores a
versioned big-endian binary record stream inside compressed blocks, so malformed
or incomplete UTF-8 replays exactly. Output is batched by byte count to reduce
framing overhead, while small interactive chunks flush immediately. A
fresh browser renderer attaches behind a replay barrier: history pages are
parsed in order, concurrent live bytes remain bounded, and only bytes newer
than the replay cursor are released afterward. Each browser has an isolated
bounded socket queue; a slow viewer cannot pause the PTY or another viewer.
Semantic snapshots use a replaceable binary lane rather than the reliable
control mailbox.

Input, resize, paste, focus, mouse, and close operations use per-connection
writer leases in the in-process `TerminalControlRegistry`. Every authenticated
connection with control scope may mutate the same terminal concurrently;
explicit observe-only connections remain read-only. No IPC or serialization
occurs between the host and PTY owner.

## Design rules

1. Keep PTY ownership in `TerminalHost` and lifecycle in the host Effect scope.
2. Never block PTY output on a browser or WebSocket.
3. Keep replay and queues bounded; a detected gap must trigger resynchronization.
4. Keep reliable control, ordered raw output, and replaceable semantic state in separate lanes.
5. Prefer direct calls over process boundaries, adapters, and recovery state.
6. Test a real interactive shell and a directly launched command through
   `node-pty`.
7. Treat host restart as destructive. Breaking persisted-state upgrades may
   reset the database instead of adding compatibility code.
