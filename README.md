# YAADE

**Mission Control for AI coding agents.**

YAADE is a web app for running and watching CLI coding agents across your projects. Pick a repo, launch Codex / Claude / Cursor / OpenCode / Grok / Pi in a real PTY, keep sessions alive, and jump back in when they need you.

No chat wrapper. No fake agent API. Agents are the same CLIs you already use — just hosted in one place.

---

## What it does

### Home — project mission control
- Browse projects as a catalog, not a file tree
- See live session cards per project (status, agent, last activity)
- Start a blank shell or an agent session in a few clicks
- Persist multi-root project lists across reloads

### Terminal sessions
- Full PTY terminals (via `node-pty`) in modal workspaces
- Multiple terminal tabs per session
- Reopen any past session from its home card
- Escape / go-home returns you to Mission Control without killing the session

### Agent CLIs (PTY)
Launch the real binary in the project directory:

| Agent    | Binary         |
| -------- | -------------- |
| Codex    | `codex`        |
| Claude   | `claude`       |
| OpenCode | `opencode`     |
| Cursor   | `cursor-agent` |
| Grok     | `grok`         |
| Pi       | `pi`           |

Resume support for providers that expose a session id (Codex, Claude, Cursor).

### Session workspace
Inside a session modal you get more than a dumb terminal:
- Terminal tabs + session switcher
- Optional Monaco editor pane (open / edit files without leaving the session)
- Project todos
- Git / explorer dialogs when you need them

### Notifications
- In-app notification center for agent stop / activity hooks
- Provider ingest endpoint for Codex / Claude Stop events
- Bell + timeline so background agents can ping you when they finish

### Appearance
- Dark / light color schemes
- Bundled themes + theme picker
- Zoom and shell settings, persisted locally

### Keyboard-first shell
Useful defaults (macOS `Mod` = ⌘):

| Action            | Shortcut      |
| ----------------- | ------------- |
| New session       | `Mod-n`       |
| Switch session    | `Mod-k`       |
| Quick open        | `Mod-p`       |
| Command palette   | `Mod-Shift-p` |
| Settings          | `Mod-,`       |
| Toggle sidebar    | `Mod-b`       |
| Go home           | `Mod-Shift-h` / `Esc` |
| Show terminal     | `Ctrl-\``     |

---

## Architecture

TypeScript only — **no Rust, no Tauri**.

| Layer | Role |
| ----- | ---- |
| Vite SPA (`@yaade/app` + `@yaade/ui`) | Mission Control UI, session modals, themes |
| `@yaade/host-server` | Effect host — FS, PTY, git, search, LSP, notifications |
| `@yaade/node-host` | Node implementations (PTY, FS, git, …) |

Renderer talks to the host over HTTP RPC (`/api/v1/rpc`) + WebSocket (`/ws`).

```
Browser
        │  HTTP + WS
        ▼
  host-server (:4747)
        │
        ▼
  node-host (PTY, FS, git, LSP, …)
```

---

## Quick start

```bash
pnpm install
pnpm dev          # host-server + Vite
```

Open the Vite URL (proxies `/api` and `/ws` to the host).

The dev startup registers `ide.local` to loopback, so the app is also available
at `http://ide.local:5174`. The first startup may ask for administrator access
to update the system hosts file. Set `JET_SKIP_LOCAL_HOST=1` to skip that step.

**Browser-first projects:** each browser tab is one project. Pathnames are home-relative — `http://localhost:5174/dev/consultation` opens `~/dev/consultation` as the initial terminal cwd (you can still `cd` freely). Layout and panes persist on the host keyed by machine hostname + absolute path. There is no in-app window tab strip — use browser tabs to juggle projects.

Some OS/browser-reserved shortcuts (`Mod-t`, `Mod-n`, `Mod-w`, `Mod-k`, `Mod-,`) may not reach the page in a normal Chrome tab.

### Production build

```bash
pnpm build              # SPA + self-extracting server binary
pnpm build:server       # same (compatibility alias)

./dist/yaade              # serve SPA + API on http://127.0.0.1:4747
./dist/yaade /path/repo   # open workspace at path
./dist/yaade --open       # also open the default browser
```

Artifacts:
- `dist/yaade` — single-file self-extracting server (scp + run)
- `dist/runtime/` — unpacked runtime (SEF source)

Host stays loopback-only; on a remote machine use SSH `-L 4747:127.0.0.1:4747`.

---

## Develop

```bash
pnpm -r typecheck
pnpm test           # unit tests across packages
pnpm test:e2e       # Playwright against TS host (Chromium)
pnpm test:bench     # UX latency budgets
```

Headed E2E:

```bash
YAADE_HEADED=1 pnpm test:e2e
```

---

## Monorepo map

```
apps/
  yaade/            Vite frontend shell
  host-server/      Effect host (HTTP/WS + PTY)
packages/
  yaade-app/        React app wiring
  yaade-ui/         Home, modals, overlays, themes
  yaade-node-host/  Node FS / git / PTY / LSP bridge
  yaade-host-client/Effect client + Promise shim
  yaade-rpc/        Shared IPC schemas
  yaade-shared/     URIs, theme types, primitives
  yaade-workspace/  Workspace + tab registry
  yaade-monaco/     Monaco editor host (session modal)
  yaade-agents/     Agent CLI id helpers
tests/
  electron/             Shared Playwright UI specs (web E2E)
```

---

## Policy

Host IPC and desktop shell are TypeScript. Do not add Rust crates, Cargo, or Tauri to this repo.
