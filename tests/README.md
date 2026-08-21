# Browser verification

Browser product scenarios live under `tests/web/e2e/` and drive Chromium against
a separately launched server application.

```bash
vp run test:web:e2e
YAADE_HEADED=1 vp run test:web:e2e
vp run test:bench
```

Global setup builds the React frontend. Every scenario launches one TypeScript
host-server process on a free loopback port with a temporary data directory.
Browser scenarios use an in-process PTY host and kill it during teardown. Test
projects are restricted to repository fixtures through `JET_ALLOWED_ROOTS`.

Failures retain Playwright traces, screenshots, video, browser console output,
and server logs. New UI or browser-visible behavior must include scoped DOM
assertions and runtime verification; query echoes do not count as result-list
proof.

## Runtime E2E

These suites use one real API process, its in-process PTY host, and real PTYs.
Host restart is destructive and is not a recovery scenario.

```bash
vp run test:web:durability
vp run test:multi-server:e2e
vp run test:security:e2e
vp run test:platform:e2e
vp run test:e2e:critical
vp run test:e2e:all
```

`test:e2e:critical` is P0 only and `test:e2e:all` includes P0 and P1.
Process-owning tasks set `cache: false`.

| Suite | Directory | Boundary |
| --- | --- | --- |
| Runtime | `tests/runtime/` | API, PTY lifecycle, process identity |
| Web product | `tests/web/e2e/` | Browser Session and terminal behavior |
| Web terminal control | `tests/web/durability/` | Browser reconnect and writer leases |
| Multi-server | `tests/multi-server/` | Independent hosts in one client |
| Security | `tests/security/` | Pairing, auth, revocation |
| Platform | `tests/platform/` | User service, storage, diagnostics |

Run the complete gates with:

```bash
vp run typecheck
vp run lint
vp run test:server
vp run test:web
vp run test:web:e2e
vp run test:e2e:critical
```
