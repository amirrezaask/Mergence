# YAADE

**Browser IDE for local or remote machines — Session tabs with composable ToolUses.**

YAADE opens at `/` with top-level **Session** tabs. Each Session is an ordered
collection of **ToolUses** (Agent, Terminal, Search, Git History). Project and checkout
belong to each ToolUse, never to the Session. Layout and PTYs live on the host,
so closing a browser tab does not kill shells.

```
http://localhost:5174/              → Session shell (Session tabs + ToolUse taskbar)
http://localhost:5174/?s=ses-…&u=use-… → deep-link a Session + ToolUse
```

Legacy project-path URLs and mux workspaces remain available for one release of
compatibility; the primary product surface is the Session shell.

---

## What it does

### Sessions

- Top tab strip of Sessions (`+` creates an empty Session)
- A horizontal ToolUse taskbar is docked at the bottom of the screen, with high-contrast selection and semantic status; each tool pane retains its project and checkout context
- Titles stay live: Search uses its query, Agent uses its first prompt then terminal title, and Terminal follows its terminal title
- Taskbar shortcuts create Search, Agent, Terminal, or Git History immediately
- Each ToolUse tab opens a context popover for project, worktree, and kind-specific options (project names are shown; IDs remain internal)
- Changing project or agent provider restarts the underlying process; the change itself does not fail
- Selecting a ToolUse renders only that ToolUse in the main viewport
- Closing a Session with live tools offers Keep running / Stop tools / Cancel
- Archived Sessions restore from the Session switcher (`Ctrl-a w` / palette)

### Tools (v1)

| Tool             | Behavior                                                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **AgentTool**    | Launches a supported agent CLI in a PTY                                                                                       |
| **TerminalTool** | Launches a shell in a PTY                                                                                                     |
| **SearchTool**   | Host-owned project content search with durable per-file context cards; selecting a result opens its source location in Monaco |
| **GitHistoryTool** | Opens the active checkout's virtualized commit history, including uncommitted changes and commit diffs |

Git History is an interactive repository surface backed by the host's existing native Git API; it does not launch a PTY. Agent and Terminal share the existing PTY path (`terminal:data` binary frames,
attach replay, flow control). Search streams bounded result batches via
`tools:event` and persists rows for reconnect.

### Checkout isolation

Each ToolUse picks Main, an existing worktree, or an isolated branch worktree
under `~/.yaade/worktrees/`. Two ToolUses in one Session may target different
projects and worktrees. Branches never switch Main as a side effect.

### Agent CLIs (PTY)

| Agent    | Binary         |
| -------- | -------------- |
| Codex    | `codex`        |
| Claude   | `claude`       |
| OpenCode | `opencode`     |
| Cursor   | `cursor-agent` |
| Grok     | `grok`         |
| Pi       | `pi`           |

---

## Keyboard

Prefix: **`Ctrl-a`** (press twice to send literal `^A` into a terminal).

| Chord            | Action                     |
| ---------------- | -------------------------- |
| `Ctrl-a c`       | New Session                |
| `Ctrl-a t`       | New ToolUse                |
| `Ctrl-a w`       | Switch Session             |
| `Ctrl-a j` / `k` | Next / previous ToolUse    |
| `Ctrl-a x`       | Close ToolUse              |
| `Ctrl-a Shift-X` | Close Session              |
| `Ctrl-a p`       | Session switcher / palette |
| `Ctrl-a ,`       | Settings                   |

Direct: `Mod-Shift-p`, `Mod-,`.

---

## Develop

```bash
pnpm install
pnpm dev          # host-server + Vite
pnpm -r typecheck
pnpm test
pnpm test:e2e     # Playwright web E2E
pnpm test:bench
pnpm build
```

Focused Tool Session E2E:

```bash
pnpm exec playwright test --project=web-e2e tests/electron/tool-sessions.electron.spec.ts
```

---

## Security note

There is **no authentication** on HTTP or WS yet. Startup refuses a non-loopback
bind; paths are gated by `allowedRoots` (default `$HOME`). A shared-secret token
on HTTP + WS is required before shipping remote.

See [AGENTS.md](AGENTS.md) for architecture invariants and [NEXT.md](NEXT.md)
for the migration checklist.
