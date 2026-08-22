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

PTY output is consumed continuously into bounded in-memory replay and Ghostty
semantic state. Output is batched to reduce framing overhead, while small
interactive chunks flush immediately. Each browser has an isolated bounded
socket queue; a slow viewer cannot pause the PTY or another viewer.

Input, resize, paste, focus, mouse, and close operations use per-connection
writer leases in the in-process `TerminalControlRegistry`. Every authenticated
connection with control scope may mutate the same terminal concurrently;
explicit observe-only connections remain read-only. No IPC or serialization
occurs between the host and PTY owner.

## Design rules

1. Keep PTY ownership in `TerminalHost` and lifecycle in the host Effect scope.
2. Never block PTY output on a browser or WebSocket.
3. Keep replay and queues bounded.
4. Prefer direct calls over process boundaries, adapters, and recovery state.
5. Test a real interactive shell and a directly launched command through
   `node-pty`.
6. Treat host restart as destructive. Breaking persisted-state upgrades may
   reset the database instead of adding compatibility code.
