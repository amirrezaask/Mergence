# Terminal release checklist

Run the focused gates before a terminal-runtime release:

```bash
vp run --filter @yaade/node-host typecheck
vp run --filter @yaade/host-server typecheck
vp run --filter @yaade/rpc typecheck
vp test packages/yaade-node-host/src/terminal-protocol
vp test packages/yaade-node-host/src/terminal-control.test.ts packages/yaade-node-host/src/terminal-runtime-registry.test.ts packages/yaade-node-host/src/terminal-recovery-store.test.ts
vp test packages/yaade-host-server/src/route-policy.test.ts packages/yaade-host-server/src/security-scopes.integration.test.ts packages/yaade-host-server/src/ws/client-mailbox.test.ts
```

For a release, also run the process-level suites under `tests/terminal-runtime`
when present and verify Linux, macOS, and Windows jobs. Do not remove legacy
protocol fixtures until a legacy supervisor can be discovered, attached, and
safely drained by the current host.

## Required observations

- repeated host restart leaves the child PID unchanged;
- a slow WebSocket is bounded or disconnected, while the PTY and a fast client
  continue;
- observe-only devices cannot mutate or administer terminals;
- stale writer commands fail with a lease error;
- legacy and current runtime manifests can coexist;
- a draining owner rejects new creates but serves existing terminals;
- recovery files are atomic, bounded, privacy-configured, and never displayed
  as live processes;
- no auth token, pairing code, terminal input, or full terminal output appears
  in structured logs.
