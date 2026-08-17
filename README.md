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
- Drag anywhere on a pane's non-interactive title bar to move it. Center drops swap panes; edge drops split. The translucent pane chrome keeps split, zoom, and close controls available on hover or keyboard focus. Use the down arrow before a pane title to change that ToolUse's project or worktree.
- Closing a ToolUse archives it and stops its process. Closing a Window archives its ToolUses; closing a Session with live tools offers Keep running / Stop tools / Cancel.
- Project and worktree settings belong to each ToolUse. ToolUse titles stay live: Search uses its query and Terminal follows its terminal title. Agent CLIs run inside TerminalTool rather than as a separate tool.
- Archived Sessions restore from the Session switcher.
- On narrow screens, Window and pane chrome disappear. The shell lists mobile-supported Terminal and Git ToolUses under each Session; selecting one opens its full-screen surface, and Back returns to the grouped list. Each Session row creates its own tools, a long press opens Session actions, and New session lives after the groups.

### Tools (v1)

| Tool             | Behavior                                                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **TerminalTool** | Launches a shell or supported agent CLI in a PTY                                                                                |
| **SearchTool**   | Host-owned project content search with durable per-file context cards; opening a hit reuses or creates a standalone Neovim ToolUse in the same checkout and opens the absolute file path at the selected line |
| **NeovimTool**   | Host-owned Neovim server rendered as a direct WebGL2 ext-linegrid surface; the process survives browser reloads, pane retile, and Window switches while the ToolUse remains live |
| **GitHistoryTool** | Opens the active checkout's virtualized commit history, including uncommitted changes and commit diffs |

Git History is an interactive repository surface backed by the host's existing native Git API; it does not launch a PTY. Terminal shells and agent CLIs share the existing PTY path (`terminal:data` binary frames,
attach replay, flow control). Search streams bounded result batches via
`tools:event` and persists rows for reconnect. Neovim requires version 0.10 or
newer (override the executable with `YAADE_NVIM_BIN` for tests), runs one
headless server per ToolUse, and sends redraw traffic over the dedicated binary
`/ws/neovim/<tool-use>?generation=<n>` channel. The browser uses WebGL2 for the
final surface; it never falls back to Canvas 2D. Closing a Neovim ToolUse stops
its server; browser reloads preserve it, while a host restart marks it
`disconnected`.

Neovim v1 uses the normal single grid (`ext_multigrid=false`) and preserves the
user's Neovim configuration, plugins, keymaps, and clipboard provider. It
requires WebGL2; there is no Canvas display fallback. Temporary channel loss
reconnects the browser lease without replacing the host process, while WebGL,
API, protocol, and process failures expose category-specific recovery actions.
Search locations use one-based UTF-16 character columns at the app boundary and
are converted to Neovim's UTF-8 byte columns before the cursor is placed.
Visual-selection copy requires browser clipboard permission and reports a
non-blocking notice when permission is unavailable. The production renderer
uses bounded retained packets and atlas resources (up to four instanced draws);
its local benchmark budgets are 300/500/750 ms for first paint at median/p95/p99,
12/24/40 ms for input-to-paint, and 8/16/24 ms for 10k-cell renderer CPU.

Terminal panes use a pinned `libghostty-vt` WebAssembly parser with a Canvas
renderer. PTYs start independently of font/WASM setup, all panes in the visible
Window remain mounted across focus and retiling, host PTYs survive Window or
browser switches, and buffer inspection never suppresses a pending repaint. Rebuild the vendored Ghostty assets with
`pnpm --filter @yaade/ui build:ghostty-wasm`.

### Mobile and installable app

The narrow-screen shell intentionally exposes Terminal and Git. Terminal
surfaces stay mounted in a bounded six-surface LRU when returning to the Session
list. One-finger drag scrolls scrollback (or sends arrows to alternate-screen
apps), long press selects text, and the accessory row provides Escape, Tab,
one-shot Ctrl/Alt, arrows, and paste. Git uses a list-first drill-down: commits
→ changed files → file diff, with a Back action at each detail level.

YAADE ships a web app manifest, 192/512px and maskable icons, safe-area metadata,
and a bounded service-worker cache, so a supported browser can add it to the
home screen from a secure origin. The cached shell can reopen without a network,
but tools still require the YAADE host. The host remains loopback-only because
HTTP and WebSocket authentication plus TLS are prerequisites for exposing a
shell to a phone, LAN, or remote network.

### Checkout isolation

Each ToolUse picks Main, an existing worktree, or an isolated branch worktree
under `~/.yaade/worktrees/`. Two ToolUses in one Session may target different
projects and worktrees. Branches never switch Main as a side effect.

### Agent CLIs in TerminalTool (PTY)

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
| `Mod-k e`        | New Neovim                                 |
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
terminals, and every ToolUse. The only bundled palettes are Default Dark and
Default Light; Auto follows the operating system's appearance. The shell uses
rounded, translucent materials with adaptive blur and luminous edges, while the
reduced-transparency option keeps the same geometry with opaque surfaces. Geist
Mono is the bundled default; the font picker can select another installed
monospace face for terminals and code UI text. Tool pane headers use a compact
monospace process glyph and title with split and close controls. File navigation
from Search opens the standalone Neovim ToolUse in the active Window;
browser-based Monaco editing remains unavailable.

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

The internal material gallery is available at `/__yaade/glass-gallery` while
working on the chrome system.

Focused Tool Session E2E:

```bash
pnpm exec playwright test --project=web-e2e tests/electron/tool-sessions.electron.spec.ts
pnpm exec playwright test --project=web-e2e tests/electron/neovim-tool.electron.spec.ts
```

---

## Security note

There is **no authentication** on HTTP or WS yet. Startup refuses a non-loopback
bind; paths are gated by `allowedRoots` (default `$HOME`). A shared-secret token
on HTTP + WS is required before shipping remote.

See [AGENTS.md](AGENTS.md) for architecture invariants and [NEXT.md](NEXT.md)
for the migration checklist.
