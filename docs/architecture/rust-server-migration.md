# Rust server migration

## Goal

Replace the TypeScript host process with Rust without changing browser or desktop behavior. The Rust process must consume the existing HTTP, JSON RPC, WebSocket, binary terminal, SQLite, command-line, and user-service interfaces.

The release stays on the TypeScript server until the Rust server passes the parity gates below. Both implementations live under `apps/server` during the migration, so YAADE still has three executable applications.

## Parity scope

The current server behavior spans `apps/server`, `packages/yaade-host-server`, `packages/yaade-node-host`, and the wire definitions in `packages/yaade-rpc`. The Rust implementation must cover:

- CLI configuration, runtime manifests, static files, service install/control, status, doctor, and pairing commands
- loopback defaults, bearer and device authentication, scope checks, CORS, WebSocket origin checks, and allowed-root validation
- SQLite identity, sessions, windows, layouts, terminal metadata, optimistic revisions, WAL settings, integrity checks, and storage failure records
- all routes in `HOST_ROUTES`, with matching status codes and error envelopes
- protocol 1 replay and protocol 2 hello/snapshot/auth flows
- PTY create, attach, replay, write, resize, process inspection, exit ordering, cancellation, and disposal
- writer leases, mutation fences, duplicate-command protection, per-client flow control, slow-client isolation, semantic snapshots, and binary terminal frames
- shutdown behavior: client disconnects preserve PTYs; explicit close and host shutdown terminate them

A database reset remains acceptable because the repository does not require persisted-state compatibility yet. The wire interface cannot break.

## Module seams

The Rust host uses these modules:

1. `config`: resolves CLI and environment input into one validated `HostConfig`.
2. `database`: owns one SQLite connection on a dedicated bounded worker. Session repositories never receive connection lifecycle controls.
3. `mux`: owns persisted Session, Window, and terminal mutations.
4. `terminal`: owns PTYs, replay, semantic state, leases, and process cleanup behind one interface.
5. `event_hub`: sequences events, retains bounded non-PTY history, and fans out shared event references.
6. `transport`: handles HTTP and WebSocket admission, then calls the same dispatch interface.
7. `runtime`: wires the modules and controls startup and shutdown.

The terminal interface is the critical seam. Unix and Windows PTY adapters vary behind it; callers do not know which adapter runs.

## Library choices

Parity work uses stable, maintained libraries with small hot-path costs:

- Tokio for the async runtime.
- Axum and Hyper for HTTP and WebSocket admission. Binary terminal output remains `bytes::Bytes` through the socket sink. A lower-level WebSocket crate is justified only if profiles show framing overhead.
- `pty-process` on Unix for Tokio-native PTY I/O. Windows uses a ConPTY adapter behind the same terminal interface; `portable-pty` is the fallback if a direct adapter does not pass lifecycle tests.
- `rusqlite` with bundled SQLite on one database worker. This avoids async SQLite wrapper overhead and prevents synchronous queries from blocking Tokio workers.
- Serde for wire structs. Rust models mirror `packages/yaade-rpc`; TypeScript remains the canonical browser contract until cutover.
- `bytes` for terminal output and binary frame assembly.
- Ghostty's terminal model for semantic parity. The terminal stage must compare a native Ghostty adapter with the current WASM ABI before selecting the integration. Replacing Ghostty with a different parser would change terminal behavior.

These choices are hypotheses until measurement. The migration does not claim a performance win from language or crate selection alone.

## Parity gates

Cutover requires all of these checks:

1. Unit tests for config, storage, mux mutations, replay, flow control, leases, framing, auth, and path policy.
2. A differential protocol suite runs the same normalized HTTP and WebSocket scenarios against both servers. It ignores UUIDs, timestamps, PIDs, and epochs while comparing every stable field, status, frame type, event order, and error code.
3. Existing server, web, security, platform, and terminal integration suites pass against Rust.
4. The two core browser E2E suites pass with real PTY output:
   - `tests/web/e2e/terminal-multiplexer.web.spec.ts`
   - `tests/web/e2e/terminal-compatibility.web.spec.ts`
5. Linux, macOS, and Windows PTY lifecycle tests pass.
6. Shutdown, reconnect, replay-gap, stale-lease, slow-client, corrupt-database, and full-terminal-limit tests pass.

After these gates pass, root `dev:server` and `build:server` switch to Cargo and the TypeScript server implementation can be removed.

## Performance gates after parity

Record the TypeScript baseline and compare the Rust release build on the same machine and workloads:

| Workload | Counters |
| --- | --- |
| Idle host, zero terminals | RSS, private memory, threads, startup time |
| 1, 8, and 64 idle PTYs | RSS and threads per PTY |
| Interactive echo | input-to-output p50, p95, p99 |
| 64 KiB and sustained output | bytes/s, CPU, allocations, p99 delivery delay |
| 1, 8, and 32 WebSocket observers | throughput, per-client queue memory, dropped/resync frames |
| Session mutation burst | RPC p50, p95, p99, SQLite busy time |
| Reconnect with maximum replay | attach latency and peak RSS |

Use release builds and identical shells, output, terminal dimensions, SQLite files, and client schedules. Keep changes only when repeated measurements move the intended counter without breaking a parity gate.

## Current migration state

The first Rust slice ports configuration, protocol-v2 identity and capability models, binary terminal framing, the bounded event hub, and the complete writer-lease/mutation-fence registry. Unit tests cover their current TypeScript behavior. The TypeScript executable remains the release server.
