# YAADE

**Browser IDE for local or remote machines — Session navigation with composable ToolUses.**

YAADE opens at `/` with top-level **Session** navigation. Each Session is an ordered
collection of **ToolUses** (Editor, Git History, Agent, Terminal, Search). Sessions open empty; add the tools you need. Project and checkout
belong to each ToolUse, never to the Session. Layout and PTYs live on the host,
so closing a browser tab does not kill shells.

```
http://localhost:5174/              → Session shell (Session navigation + tiled ToolUse workspace)
http://localhost:5174/?s=ses-…&u=use-… → deep-link a Session + ToolUse
```

Legacy project-path URLs and mux workspaces remain available for one release of
compatibility; the primary product surface is the Session shell.

---

## What it does

### Sessions

- The sidebar has two sections: Sessions, then Agents from every Session. `Mod-k b` (`⌘K` / `Ctrl+K`, then `b`) collapses or restores it; hover the workspace edge to reveal the same toggle. Older tab-bar and two-sidebar preferences migrate automatically to this layout.
- The Sessions section creates and switches Sessions; the Agents section creates agents and lists agents across every Session. Terminal ToolUses running a recognized agent CLI are detected from foreground-process/Ghostty identity and appear there too.
- The center workspace is a tiled pane tree, and each pane is a tab group of ToolUses. Dropping on a pane center groups a ToolUse as a tab; dropping on an edge creates a split, up to six panes.
- Each pane titlebar has a `+` menu for Terminal, Git, Editor, and Search. Agents are created from the Agents section, not the tool menu.
- Closing a ToolUse tab—or closing its containing pane—archives the ToolUse and kills its process. Dragging and rearranging tabs does not restart them.
- Right-click a pane tab to open its project, worktree, and kind-specific context popover. Changing project or agent provider persists the change and restarts the underlying process.
- ToolUse tab titles stay live: Search uses its query, Agent uses its first prompt then terminal title, and Terminal follows its Ghostty terminal title.
- Closing a Session with live tools offers Keep running / Stop tools / Cancel
- Archived Sessions restore from the Session switcher (`Mod-k w` / palette)

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

Terminal panes use a pinned `libghostty-vt` WebAssembly parser with a Canvas
renderer. PTYs start independently of font/WASM setup, hidden panes keep their
processes and parser state alive without painting, and buffer inspection never
suppresses a pending repaint. Rebuild the vendored Ghostty assets with
`pnpm --filter @yaade/ui build:ghostty-wasm`.

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

Prefix: **`Mod-k`** (`⌘K` on macOS, `Ctrl+K` on Windows/Linux). Press twice
to send literal `^K` (kill-line) into a terminal.

| Chord            | Action                                      |
| ---------------- | ------------------------------------------- |
| `Mod-k t`        | New Terminal                                |
| `Mod-k s`        | New Search                                  |
| `Mod-k e`        | New Editor                                  |
| `Mod-k g`        | New Git History                             |
| `Mod-k b`        | Collapse or restore the navigation sidebar |
| `Mod-k j` / `k`  | Next / previous ToolUse                     |
| `Mod-k u`        | Switch ToolUse                              |
| `Mod-k w`        | Switch Session                              |
| `Mod-k 1`–`9`    | Jump to ToolUse by index                    |
| `Mod-k c`        | New Session                                 |
| `Mod-k x`        | Close ToolUse                               |
| `Mod-k Shift-X`  | Close Session                               |
| `Mod-k ,`        | Settings                                    |

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
