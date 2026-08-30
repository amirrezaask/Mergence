# Terminal runtime

YAADE uses one host process as the terminal multiplexer:

```text
browser  <->  host server  <->  TerminalHost  <->  node-pty children
```

`TerminalHost` maps terminal IDs to handles. One owner thread per terminal owns
the PTY master, writer, child, replay, checkpoint parser, and writer leases. A
small reader thread only reads the blocking PTY and sends immutable chunks over
a bounded channel. The owner services bounded urgent and normal command lanes
between measured output quanta. Queue saturation returns a typed runtime error.

The history owner accepts records through a separate mailbox bounded by message
count and bytes. It writes a checksummed append-only active segment before
adding each record to the compression batch. Startup keeps complete records and
truncates a torn tail. Block and manifest publication clears the active segment
only after the manifest rename. Compression and file work never hold the
terminal map lock. There is no detached supervisor or disk-backed process
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
control mailbox. The history archive can rebuild terminal bytes after the live
replay ring trims old chunks; it does not keep the PTY alive across host restarts.

Input, resize, paste, focus, mouse, and close operations use per-connection
writer leases. The terminal owner authorizes a mutation and applies it in one
command, so queue rejection cannot consume a command fence. Authenticated
connections with control scope may mutate the same terminal concurrently;
observe-only connections remain read-only.

## Browser parser and presentation

Each Ghostty worker shares a bounded fair scheduler across its terminals while
preserving each terminal's command order. Focused and visible terminals receive
higher deficit weights. Each terminal may hold one in-flight command, which
prevents a flooded terminal from filling all worker capacity. Generation and
sequence keys stop a stale completion from releasing a replacement runtime's
command. Lifecycle diagnostics include aggregate scheduler bytes, command
count, and in-flight count.

Workers continue parsing while a terminal is hidden or DEC mode 2026 suppresses
presentation. They skip render-update construction and transfer until the
terminal becomes visible or synchronized output ends. A one-second safety timer
presents a catch-up frame for a producer that leaves synchronization enabled.
The worker reports parsed, suppression, catch-up, timeout, transfer, allocation,
and slot counters without terminal content.

Render updates use three generation-scoped transferable slots. The main thread
returns each slot after model application. The worker rejects stale returns and
waits when all slots are leased. Idle workers trim oversized returned buffers
after hysteresis and cooldown thresholds; active terminals keep their hot
buffers.

## Design rules

1. Keep PTY ownership in `TerminalHost` and lifecycle in the host Effect scope.
2. Never block PTY output on a browser or WebSocket.
3. Keep replay and queues bounded; a detected gap must trigger resynchronization.
4. Keep reliable control, ordered raw output, and replaceable semantic state in separate lanes.
5. Prefer direct calls over process boundaries, adapters, and recovery state.
6. Test a real interactive shell and a directly launched command through
   `portable-pty`.
7. Treat host restart as destructive. Breaking persisted-state upgrades may
   reset the database instead of adding compatibility code.
