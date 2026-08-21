# Browser verification

The historical `tests/electron/` directory contains the shared product scenarios; the name is retained to avoid a noisy move. The suite drives Chromium against a separately launched server application.

```bash
vp run test:web:e2e
YAADE_HEADED=1 vp run test:web:e2e
vp run test:bench
```

Global setup builds the React frontend. Every scenario launches one TypeScript host-server process on a free loopback port with a temporary data directory. Browser scenarios use an in-process PTY host and kill it during teardown. Test projects are restricted to repository fixtures through `JET_ALLOWED_ROOTS`.

Failures retain Playwright traces, screenshots, video, browser console output, and server logs. New UI or browser-visible behavior must include scoped DOM assertions and runtime verification; query echoes do not count as result-list proof.

## Durable runtime E2E

These suites use a real API process, detached PTY supervisor, real PTY, and the cross-platform mock agent. They do not replace the boundary under test with mocks.

```bash
vp run test:runtime:e2e
vp run test:web:durability
vp run test:desktop:e2e
vp run test:recovery:e2e
vp run test:multi-server:e2e
vp run test:security:e2e
vp run test:platform:e2e
vp run test:chaos
vp run test:soak
vp run test:e2e:critical
vp run test:e2e:all
```

`test:e2e:critical` is P0 only. `test:e2e:all` is P0 and P1, excluding soak. Soak runs on a schedule and before a release. Process-owning tasks set `cache: false`. Historical Chromium journeys stay under `tests/electron/`; actual Electron tests belong in `tests/desktop/`.

P0 Batch 1–2 covers A01–A12, P01–P08, and D01–D07. Packaged D06 skips when `apps/desktop/out` is absent. Batch 3 recovery covers T01–T09 and R01–R10. Writer leases cover L01–L07. Multi-server covers M01–M10. Device pairing covers S01–S10 through `vp run test:security:e2e`. Batch 6 covers O01–O06 (`vp run test:platform:e2e`; O01/O02 skip in CI unless `YAADE_SERVICE_E2E=1`), C02–C05 (`vp run test:chaos`), and C01 (`vp run test:soak`, duration via `YAADE_SOAK_MS` / `YAADE_SOAK_PTYS`).

| Suite | Directory | Boundary |
| --- | --- | --- |
| Runtime | `tests/runtime/` | API, supervisor, process identity |
| Web durability | `tests/web/durability/` | Browser + detached supervisor |
| Desktop | `tests/desktop/` | Real Electron + local daemon |
| Recovery | `tests/recovery/` | Checkpoints and provider resume |
| Multi-server | `tests/multi-server/` | Independent hosts in one client |
| Security | `tests/security/` | Pairing, auth, revocation |
| Platform | `tests/platform/` | User service, storage, diagnostics |
| Chaos | `tests/chaos/` | Fault injection |
| Soak | `tests/soak/` | Long-running resource bounds |

## Product coverage

The suite is split by the boundary it protects rather than by implementation file:

- **Host/server tests** cover SQLite migrations and recovery, project/checkouts, ToolUse revisions, PTY lifecycle and supervisor reattach, flow control, binary terminal frames, WebSocket replay/gaps, authorization, notifications, agent telemetry, Git commands, and the two-client live PTY fan-out (`packages/yaade-host-server/src/server-multiclient.test.ts`).
- **Host-client/RPC tests** cover route schemas, typed errors, HTTP text-file versioning, realtime decoding, reconnect backoff, delta replay, and optional-argument serialization.
- **Package tests** cover session routing/state, tiling, keyboard handling, terminal rendering/input, Git review mutation queues and hunk patching, themes, panels, telemetry reduction, and desktop security policy.
- **Browser journeys** cover release boot, shell chrome, settings/focus restoration, terminal input and replay after reload, durable Windows/panes, project discovery, split/zoom controls, mobile terminal accessory keys, Git history/no-repository/working-tree staging/commit/mobile diff, DA1 compatibility, and a long-running agent with permission attention.

A product change is not covered until the relevant boundary test exists. Run the complete gates with:

```bash
vp run typecheck
vp run lint
vp run test:server
vp run test:web
vp run test:desktop
vp run test:web:e2e
vp run test:e2e:critical
```
