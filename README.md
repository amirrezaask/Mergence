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
| `Mod-k x` | Close tool |
| `Mod-k Shift-X` | Close Session |
| `Mod-k ,` or `Mod-,` | Settings |

## Desktop app

The Electron wrapper keeps the renderer sandboxed and runs the existing host on a loopback-only ephemeral port. Development starts both the Vite renderer and host automatically:

```bash
pnpm install
pnpm dev:desktop
```

Build a packaged desktop app after the normal runtime build:

```bash
pnpm build            # on macOS, also creates a DMG
pnpm package:desktop  # package for the current platform
pnpm make:desktop     # create ZIP and DMG artifacts for the current platform
```

The macOS DMG is written under `apps/desktop/out/make/`. The desktop window uses the top Session/Window tab bar as its custom titlebar while retaining native window controls.

Pass a workspace explicitly with `--workspace /path/to/project`. Desktop builds keep host data under Electron's `userData` directory and do not register the browser PWA service worker. Forge packaging uses Node 22 LTS; set `YAADE_PACKAGER_NODE` when it is not discoverable locally.

## Development

```bash
pnpm install
pnpm dev
pnpm -r typecheck
pnpm test
pnpm test:e2e
pnpm build
```

The internal material gallery is available at `/__yaade/glass-gallery`.

## Deployment warning

YAADE currently has no HTTP or WebSocket authentication. The default bind is loopback-only. Do not expose it to an untrusted network. `pnpm dev:lan` is intended only for trusted LANs.

See [AGENTS.md](AGENTS.md) for architecture and contribution rules.
