# YAADE

**A browser multiplexer for Terminal and Git workflows.**

YAADE runs a TypeScript host on your machine and exposes a browser Session shell. A Session contains Windows (tabs), and each Window contains tiled ToolUses. Each ToolUse owns its project and checkout.

```text
http://localhost:5174/                         Session shell
http://localhost:5174/?s=ses-…&t=tab-…&u=use-… Deep link
```

## Tools

| Tool | Behavior |
| --- | --- |
| **Terminal** | Persistent PTY with replay, flow control, mobile accessory keys, and support for running shell or agent CLIs directly. |
| **Git History** | Virtualized commit history, changed files, and diffs for the selected checkout. |

Search, browser editors, standalone AgentTool, and Neovim ToolUse were retired. Run Codex, Claude, Pi, or another CLI inside Terminal. The top bar holds the Session dropdown, Window pills, and Settings. A resizable **Agents** sidebar appears when agent CLIs are running and focuses their session, window, and pane when selected.

## Sessions

- Sessions contain Windows; Windows contain tiled Terminal and Git ToolUses.
- Empty Windows open a Terminal automatically; empty panes use the same Terminal fallback.
- Layout, project, checkout, and ToolUse metadata persist across reloads.
- PTYs survive browser reloads and tab switches while the host remains running.
- Closing a Terminal ToolUse stops its PTY.
- Add projects from any ToolUse context with folder-path autocomplete; terminals offer to remember a newly visited folder after `cd`.
- Mobile uses a list-first Terminal/Git shell with retained terminal surfaces.
- Clicking a pane split control opens a Terminal by default; hold Cmd/Ctrl while clicking to choose a tool.
- Settings → **Servers** lets you add multiple remote host URLs and optional access tokens. Sessions from every reachable host appear in the same session switcher; each session keeps its host context when you work in it.
- The client host is shown automatically, while remote servers are optional. A new client can therefore start with no remote servers configured.

## Keyboard

Prefix: **`Mod-k`** (`⌘K` on macOS, `Ctrl+K` elsewhere). Press it twice in a terminal to send literal `^K`. Pane split shortcuts are direct chords; use the pane context menu if a browser claims one.

| Chord | Action |
| --- | --- |
| `Mod-k t` | New Terminal |
| `Mod-k g` | New Git |
| `Mod-k j` / `k` | Next / previous tool |
| `Mod-k h` / `l` | Previous / next Window |
| `Mod-d` | Split focused pane right |
| `Mod-Shift-d` | Split focused pane down |
| `Mod-k u` | Switch tool |
| `Mod-k b` | Toggle sidebar |
| `Mod-k w` | Switch Session |
| `Mod-k 1`–`9` | Jump to tool |
| `Mod-k c` | New Session |
| `Mod-k n` | New Window |
| `Mod-k Shift-N` | Close Window |
| `Mod-k x` | Close tool |
| `Mod-k Shift-X` | Close Session |
| `Mod-k z` | Zoom / unzoom pane |
| `Mod-k ,` or `Mod-,` | Settings |
| `Mod-=` / `Mod-Shift-=` | Increase UI and terminal font |
| `Mod--` / `Mod-Shift--` | Decrease UI and terminal font |
| `Mod-0` | Reset UI and terminal font |

## Applications

YAADE has three isolated applications. Shared implementation lives in
`packages/`; the application directories contain only their executable
wiring and packaging.

- **Server** — `apps/server`, the HTTP/WebSocket host and PTY runtime.
- **Web** — `apps/web`, the Vite+ browser application.
- **Desktop** — `apps/desktop`, the sandboxed Electron wrapper.

Start the web and server development processes together with hot reload:

```bash
vp run dev             # web + server
```

Run an application individually when needed:

```bash
vp run @yaade/server#dev # server only; defaults to port 4747
vp run dev:web           # web/Vite+ only
vp run dev:desktop       # Electron application
```

Build each isolated release artifact independently:

```bash
vp run build:server   # dist/yaade-server, standalone server runtime
vp run build:web      # apps/web/dist, standalone static web artifact
vp run build:desktop  # Electron ZIP/DMG for the current platform
vp run build          # all three artifacts, in order
```

The desktop development application starts its own local runtime so it can be
run independently. It does not change the server or web development commands.

Package a desktop app directly after `build:desktop` with:

```bash
vp run package:desktop
vp run make:desktop
```

The macOS DMG is written under `apps/desktop/out/make/`. The desktop window uses the top Session/Window tab bar as its custom titlebar while retaining native window controls.

Pass a workspace explicitly with `--workspace /path/to/project`. Desktop builds keep host data under Electron's `userData` directory and do not register the browser PWA service worker. Forge packaging uses Node 22 LTS; set `YAADE_PACKAGER_NODE` when it is not discoverable locally.

## Development

Vite+ (`vp`) is the frontend/tooling runner. Use Node.js 22.18+ and install the CLI
once with `curl -fsSL https://vite.plus | bash`. Install Bun for the server
runtime. Vite+ provides dependency installation, Vite/Rolldown builds, Vitest
tests, Oxlint checks, and workspace task execution.

```bash
vp install
vp run typecheck
vp run lint
vp run test:server
vp run test:web
vp run test:desktop
vp run test:web:e2e
vp run build
```

The internal material gallery is available at `/__yaade/glass-gallery`.

### Remote host connections

A remote host bound outside loopback must be started with a bearer token, for example:

```bash
YAADE_HOST_TOKEN=replace-me vp run @yaade/server#dev -- --host 0.0.0.0 --token replace-me
```

Token-authenticated hosts allow browser and desktop clients to connect from another origin. Configure explicit origins with `YAADE_CORS_ORIGINS` when you want to restrict that access further.

## Deployment warning

The host API is unauthenticated on loopback by default and requires a bearer token for non-loopback binds. Do not expose an unauthenticated host to an untrusted network. To expose the web development server on a trusted LAN, run `vp run dev:web -- --host 0.0.0.0` and configure the separately running server with its own host/token options. The web uses Vite+; the server development task runs directly on Bun with hot reload.

See [AGENTS.md](AGENTS.md) for architecture and contribution rules.
