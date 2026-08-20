# Browser verification

The historical `tests/electron/` directory contains the shared product scenarios; the name is retained to avoid a noisy move. The suite drives Chromium against a separately launched server application.

```bash
vp run test:web:e2e
YAADE_HEADED=1 vp run test:web:e2e
vp run test:bench
```

Global setup builds the React frontend. Every scenario launches one TypeScript host-server process on a free loopback port with a temporary data directory. Browser scenarios use an in-process PTY host and kill it during teardown; detached-supervisor durability is covered by the node-host/process-driver tests. Test projects are restricted to repository fixtures through `JET_ALLOWED_ROOTS`.

Failures retain Playwright traces, screenshots, video, browser console output, and server logs. New UI or browser-visible behavior must include scoped DOM assertions and runtime verification; query echoes do not count as result-list proof.

## Product coverage

The suite is split by the boundary it protects rather than by implementation file:

- **Host/server tests** cover SQLite migrations and recovery, project/checkouts, ToolUse revisions, PTY lifecycle and supervisor reattach, flow control, binary terminal frames, WebSocket replay/gaps, authorization, notifications, agent telemetry, Git commands, and the two-client live PTY fan-out (`packages/yaade-host-server/src/server-multiclient.test.ts`).
- **Host-client/RPC tests** cover route schemas, typed errors, HTTP text-file versioning, realtime decoding, reconnect backoff, delta replay, and optional-argument serialization.
- **Package tests** cover session routing/state, tiling, keymaps, terminal rendering/input, Git review mutation queues and hunk patching, themes, panels, telemetry reduction, and desktop security policy.
- **Browser journeys** cover release boot, shell chrome, settings/focus restoration, terminal input and replay after reload, durable Windows/panes, project discovery, split/zoom controls, mobile terminal accessory keys, Git history/no-repository/working-tree staging/commit/mobile diff, DA1 compatibility, and a long-running agent with permission attention.

A product change is not covered until the relevant boundary test exists. Run the complete gates with:

```bash
vp run typecheck
vp run lint
vp run test:server
vp run test:web
vp run test:desktop
vp run test:web:e2e
```
