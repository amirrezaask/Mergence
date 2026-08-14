# YAADE

**Browser IDE for local or remote machines — Session navigation with composable ToolUses.**

YAADE opens at `/` with top-level **Session** navigation. Each Session is an ordered
collection of **ToolUses** (Editor, Git History, Agent, Terminal, Search). Sessions open empty; add the tools you need. Project and checkout
belong to each ToolUse, never to the Session. Layout and PTYs live on the host,
so closing a browser tab does not kill shells.

```
http://localhost:5174/              → Session shell (Session navigation + ToolUse viewport)
http://localhost:5174/?s=ses-…&u=use-… → deep-link a Session + ToolUse
```

Legacy project-path URLs and mux workspaces remain available for one release of
compatibility; the primary product surface is the Session shell.

---

## What it does

### Sessions

- Sessions and ToolUses support three navigation layouts: **Tab bar** keeps Sessions at the top and ToolUses in a bottom taskbar; **Two sidebars** puts Sessions on the left and ToolUses on the right; **Single sidebar** combines both into one left rail with ToolUses above Sessions. Switch layouts from Settings → Appearance → Navigation layout. In either sidebar layout, `Ctrl-a b` collapses or restores the navigation.
- In any layout, `+` creates an empty Session; add tools from the Session shell. Settings stays beside the Session navigation.
- The sidebar layouts keep the active ToolUse in the center viewport; each tool pane retains its project and checkout context
- ToolUse tab titles include the project name (for example, `yaade: Git History`) and stay live: Search uses its query, Agent uses its first prompt then terminal title, and Terminal follows its terminal title
- Sessions do not auto-open tools; all ToolUse tabs can be reordered or closed
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
| **SearchTool**   | Host-owned project content search with durable per-file context cards; opening a hit enters the same Monaco workspace surface as EditorTool, including the left Explorer, shared buffers/LSP, breadcrumbs, and VS Code-style Quick Open |
| **EditorTool** | Opens the active checkout in a compact Monaco editor with a togglable Explorer; LSP references open in Monaco's inline references view |
| **GitHistoryTool** | Opens the active checkout's virtualized commit history, including uncommitted changes and commit diffs; one tab is created per Session |

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

| Chord            | Action                                      |
| ---------------- | ------------------------------------------- |
| `Ctrl-a a`       | New Agent                                   |
| `Ctrl-a t`       | New Terminal                                |
| `Ctrl-a s`       | New Search                                  |
| `Ctrl-a e`       | New Editor                                  |
| `Ctrl-a g`       | New Git History                             |
| `Ctrl-a b`       | Collapse or restore the navigation sidebar |
| `Ctrl-a j` / `k` | Next / previous ToolUse                     |
| `Ctrl-a u`       | Switch ToolUse                              |
| `Ctrl-a w`       | Switch Session                              |
| `Ctrl-a 1`–`9`   | Jump to ToolUse by index                    |
| `Ctrl-a c`       | New Session                                 |
| `Ctrl-a x`       | Close ToolUse                               |
| `Ctrl-a Shift-X` | Close Session                               |
| `Ctrl-a ,`       | Settings                                    |

Direct and context-local:

| Chord                | Action                                                                      |
| -------------------- | --------------------------------------------------------------------------- |
| `Mod-,`              | Settings                                                                    |
| `Cmd-p` / `Ctrl-p`   | Quick-open a project file while Editor or Search is focused                |

### Appearance

Settings applies one palette consistently to the app shell, Monaco, Git states,
terminals, and every ToolUse. Bundled families include all four Catppuccin
flavors, Tokyo Night (Night, Storm, Moon, Day), Rosé Pine (main, Moon, Dawn),
and Ayu (Dark, Mirage, Light). Geist Mono is the bundled default; the font
picker can select another installed monospace face for terminals, Monaco, and
code UI text.

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
