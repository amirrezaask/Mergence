# YAADE

**Browser multiplexer for local or remote machines — Sessions, Windows, and ToolUses.**

YAADE follows tmux's hierarchy while adding IDE tools: a **Session** contains
multiple **Windows** (shown as tabs), and each Window contains ToolUses arranged
with the existing tiled pane system. In tmux terms: Session = session, Window =
tab, ToolUse = pane. Project and checkout belong to each ToolUse, never to the
Session or Window. PTYs outlive browser tabs.

```
http://localhost:5174/                         → Session shell
http://localhost:5174/?s=ses-…&t=tab-…&u=use-… → Session + Window + ToolUse
```

Legacy project-path URLs and mux workspaces remain available for one release of
compatibility; the primary product surface is the Session shell.

---

## What it does

### Sessions, Windows, and panes

- The Session switcher creates and switches top-level Sessions. `Mod-k w` opens it; `Mod-k c` creates a Session.
- Every Session has one or more Windows (tabs). Create one with the `+` beside the Window tab strip or `Mod-k n`; switch with `Mod-k h` / `Mod-k l`.
- Each Window owns a host-persisted tiled layout: split geometry, ratios, focus, zoom, and ToolUse placement survive reloads and reconnects.
- Every non-empty pane owns exactly one ToolUse. Creating a tool from a shortcut fills an empty pane or splits the focused pane; it never replaces the visible tool. A seventh pane opens in a new Window rather than hiding an existing ToolUse.
- Drag anywhere on a pane's non-interactive title bar to move it. Center drops swap panes; edge drops split. The translucent pane chrome keeps split, zoom, and close controls available on hover or keyboard focus.
- Closing a ToolUse archives it and stops its process. Closing a Window archives its ToolUses; closing a Session with live tools offers Keep running / Stop tools / Cancel.
- Project, worktree, and provider settings belong to each ToolUse. ToolUse titles stay live: Search uses its query, Agent uses its first prompt then terminal title, and Terminal follows its terminal title.
- Archived Sessions restore from the Session switcher.

### Tools (v1)

| Tool             | Behavior                                                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **AgentTool**    | Launches a supported agent CLI in a PTY                                                                                       |
| **TerminalTool** | Launches a shell in a PTY                                                                                                     |
| **SearchTool**   | Host-owned project content search with durable per-file context cards; opening a hit reuses one Neovim terminal pane for that SearchTool and opens the absolute file path at the selected line |
| **GitHistoryTool** | Opens the active checkout's virtualized commit history, including uncommitted changes and commit diffs |

Git History is an interactive repository surface backed by the host's existing native Git API; it does not launch a PTY. Agent and Terminal share the existing PTY path (`terminal:data` binary frames,
attach replay, flow control). Search streams bounded result batches via
`tools:event` and persists rows for reconnect.

Terminal panes use a pinned `libghostty-vt` WebAssembly parser with a Canvas
renderer. PTYs start independently of font/WASM setup, all panes in the visible
Window remain mounted across focus and retiling, host PTYs survive Window or
browser switches, and buffer inspection never suppresses a pending repaint. Rebuild the vendored Ghostty assets with
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
| `Mod-k g`        | New Git History                             |
| `Mod-k b`        | Collapse or restore the navigation sidebar |
| `Mod-k j` / `k`  | Next / previous ToolUse                     |
| `Mod-k h` / `l`  | Previous / next Window                      |
| `Mod-k u`        | Switch ToolUse                              |
| `Mod-k w`        | Switch Session                              |
| `Mod-k 1`–`9`    | Jump to ToolUse by index                    |
| `Mod-k c`        | New Session                                 |
| `Mod-k n`        | New Window                                  |
| `Mod-k x`        | Close ToolUse                               |
| `Mod-k Shift-X`  | Close Session                               |
| `Mod-k ,`        | Settings                                    |

Direct and context-local:

| Chord                | Action                                                                      |
| -------------------- | --------------------------------------------------------------------------- |
| `Mod-,`              | Settings                                                                    |

### Appearance

Settings applies one palette consistently to the app shell, Git states,
terminals, and every ToolUse. Bundled families include all four Catppuccin
flavors, Tokyo Night (Night, Storm, Moon, Day), Rosé Pine (main, Moon, Dawn),
and Ayu (Dark, Mirage, Light). Geist Mono is the bundled default; the font
picker can select another installed monospace face for terminals and code UI
text. File navigation uses Neovim in a terminal pane; browser-based file editing
is currently unavailable.

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
