# Terminal protocol policy

## Framing

Supervisor connections use a local length-prefixed frame:

```text
u32 big-endian payload length + UTF-8 JSON payload
```

Frame lengths are checked before parsing. The current compatibility limit is
16 MiB; operation-specific limits are preferred for the versioned protocol.
Malformed or oversized frames terminate only the offending connection.

## Message identity

Every request has a request ID. A mutation that may be retried also carries an
idempotency command ID scoped to the owner epoch. Interactive input is ordered
but is not deduplicated: replaying raw keystrokes is unsafe.

A negotiated hello identifies:

* protocol range;
* runtime version;
* owner ID and owner epoch;
* semantic-state, lease, structured-input, history, subscription, and draining
  capabilities.

The host may continue to attach to a legacy owner when it cannot create new
terminals there. It must not silently use a legacy capability as an authority
bypass.

## Terminal stream contract

Raw compatibility events carry an output sequence. Semantic streams carry:

* immutable terminal epoch;
* monotonically increasing state revision;
* snapshot or patch base revision.

A client applies a patch only when both epoch and base revision match its local
state. Otherwise it requests a full snapshot. A dropped render patch is never a
reason to pause or throttle the PTY.

## Queues

Reliable control traffic is a bounded FIFO. Overflow is an explicit connection
failure. Render traffic is latest-state replaceable per client and terminal. A
client that falls behind is marked for full resynchronization; obsolete patches
are discarded rather than retained without bound.

## Security

Authorization identity is created by the host from the authenticated request or
WebSocket connection. Client-provided IDs are correlation data only. Terminal
mutations require an owner-validated lease fence containing terminal epoch,
lease ID, lease generation, principal ID, connection ID, and command ID.
