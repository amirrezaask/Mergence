# YAADE

**A server-hosted browser multiplexer for running coding agents.**

YAADE runs a TypeScript host on the server and exposes a browser Session shell. The server launches and owns PTYs; the browser is a control and observation client. A Session contains Windows (tabs), and each Window contains tiled terminals.

```text
http://localhost:5174/                         Session shell
http://localhost:5174/?s=ses-…&t=tab-…&term=term-… Deep link
```

## Terminals

The only terminal type is **Terminal**: a server-side PTY with disk-backed, incrementally paged replay, isolated client queues, mobile accessory keys, and support for running shells, commands, and coding-agent CLIs directly.

Agent CLIs are ordinary processes inside server-side terminals, not a separate chat or agent runtime. YAADE has no separate workspace, Git, search, editor, or agent surfaces. The top bar holds the Session dropdown, Window pills, and Settings.

## Sessions

- Sessions contain Windows; Windows contain tiled terminals.
- Windows and panes organize independent server-side shell, command, and agent runs.
- Empty Windows open a Terminal automatically; empty panes use the same Terminal fallback.
- Layout and terminal metadata persist across browser reloads while the host is running.
- The host process owns PTYs directly. Browser reloads and disconnects leave terminal and agent processes running; restarting the host intentionally kills every PTY and starts with a fresh Session.
- Closing a terminal is the explicit destructive action that stops its PTY and any agent running inside it during normal operation.
- Reconnects to the same host process restore from a Ghostty snapshot plus sequence-indexed, block-compressed history under the host data directory. History is delivered in bounded pages instead of one large payload.
- Multiple viewers can attach to one terminal. Every authenticated client with control scope can write input and resize; explicitly observe-only clients remain viewers. Each viewer acknowledges parsed output independently; a lagging viewer is resynchronized from durable history without disconnecting other terminals. The per-terminal credit window defaults to 8 MiB and can be tuned with `YAADE_TERMINAL_UNACKNOWLEDGED_BYTES`. Disk-writer backpressure may briefly pause only the producing PTY to keep host memory bounded.
- Mobile uses a list-first Terminal shell with retained terminal surfaces.
- Clicking a pane split control opens a Terminal.
- Drag a Window tab or pane title onto the center or directional dock targets to move, swap, or retile terminals. Docking a Window moves its focused terminal without interrupting the process.
- Settings → **Servers** lets you add multiple remote host URLs and optional access tokens. Sessions from every reachable host appear in the same session switcher; each session keeps its host context when you work in it.
- The client host is shown automatically, while remote servers are optional. A new client can therefore start with no remote servers configured.

## Applications

YAADE has three isolated applications. Shared TypeScript implementation lives
in `packages/`; application directories own executable wiring and packaging.

- **Server** — `apps/server`, the HTTP/WebSocket host and execution boundary for server-side PTYs, commands, and agent processes.
- **Web** — `apps/web`, the Vite+ browser control and observation application; it never owns agent processes.
- **Desktop** — `apps/desktop`, the native Rust + GPUI client. It connects to the same host and preserves the web shell's Sessions → Windows → terminal experience without a WebView or a second PTY runtime.

Start the web and server development processes together; the web process has hot reload:

```bash
vp run dev             # web + server
```

Run an application individually when needed:

```bash
vp run @yaade/server#dev # server only; defaults to port 4747
vp run dev:web           # web/Vite+ only
vp run dev:desktop       # native GPUI client; connects to port 4747 by default
```

The desktop client follows `YAADE_HOST_URL` and `YAADE_HOST_TOKEN`. Its visual
contract is generated from the web theme, material, metric, and motion sources:

```bash
vp run check:desktop-design
```

The standalone server can be installed as a user-level service (systemd user
on Linux, LaunchAgent on macOS, and a least-privilege scheduled task on
Windows):

```bash
yaade-server install
yaade-server start
yaade-server status
yaade-server doctor
yaade-server pair
yaade-server stop
yaade-server uninstall
```

Use the packaged artifact's actual command name when running these commands.

Build the release artifacts:

```bash
vp run build:server   # dist/yaade-server, standalone server runtime
vp run build:web      # apps/web/dist, standalone static web artifact
vp run build:desktop  # apps/desktop/target/release/yaade-desktop
vp run build:release  # dist/yaade, one self-contained API + web executable
vp run build          # server + web release artifacts
```

Run the combined release directly:

```bash
./dist/yaade --port 4747
```

It serves the browser application at `/` and the host APIs/WebSocket at `/api` and `/ws`.

## Development

Vite+ (`vp`) is the frontend/tooling runner. Use Node.js 22.18+ and install the CLI
once with `curl -fsSL https://vite.plus | bash`. The server development runtime
also runs on Node.js. Vite+ provides dependency installation, Vite/Rolldown builds, Vitest
tests, Oxlint checks, and workspace task execution.

```bash
vp install
vp run typecheck
vp run lint
vp run test:server
vp run test:web
vp run test:desktop
vp run check:desktop-design
vp run test:web:e2e
vp run build
```

The internal material gallery is available at `/__yaade/glass-gallery`.

### Runtime lifetime

The host is a single multiplexer process and the server-side execution boundary
for Sessions, terminals, and agent processes. It owns every PTY directly.
Browser refreshes, temporary network disconnects, and browser reloads reattach to
that same process using bounded in-memory replay. A host restart kills all PTYs,
interrupts running agents, and discards Session, Window, and terminal state; the
user is responsible for not restarting the host while a long-running agent or
command matters.

There is no detached supervisor, runtime generation handoff, disk-backed terminal
recovery, or session-format compatibility promise. Breaking state changes may
reset the database. This keeps the terminal path small, fast, and locally
debuggable. The runtime design is documented in
`docs/architecture/terminal-runtime.md`.

### Remote host connections

Run the server on the machine where agents should execute and connect to it from
any browser you trust. A remote host bound outside loopback must be started with
a bearer token, for example:

```bash
YAADE_HOST_TOKEN=replace-me vp run @yaade/server#dev -- --host 0.0.0.0 --token replace-me
```

Token-authenticated hosts allow browser clients to connect from another origin. Modern WebSocket connections authenticate in-band rather than placing the token in the WebSocket URL. Browser server metadata is persisted in localStorage, while legacy bearer tokens are kept only for the current session during migration. Configure explicit origins with `YAADE_CORS_ORIGINS` when you want to restrict that access further.

Authenticated administrators can create one-time device pairing codes at
`POST /api/v1/security/pairing-code`. A paired device signs a short-lived
challenge; devices can be listed and revoked through `/api/v1/security/devices`.


## Deployment warning

The host API is unauthenticated on loopback by default and requires a bearer token for non-loopback binds. Do not expose an unauthenticated host to an untrusted network. To expose the web development server on a trusted LAN, run `vp run dev:web -- --host 0.0.0.0` and configure the separately running server with its own host/token options. Both applications use Node-compatible runtimes; the server development task uses `scripts/run-ts.mjs`.

See [AGENTS.md](AGENTS.md) for architecture and contribution rules.
