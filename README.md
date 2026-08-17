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

Search, browser editors, standalone AgentTool, and Neovim ToolUse were retired. Run Codex, Claude, Pi, or another CLI inside Terminal.

## Sessions

- Sessions contain Windows; Windows contain tiled Terminal and Git ToolUses.
- Layout, project, checkout, and ToolUse metadata persist across reloads.
- PTYs survive browser reloads and tab switches while the host remains running.
- Closing a Terminal ToolUse stops its PTY.
- Mobile uses a list-first Terminal/Git shell with retained terminal surfaces.

## Keyboard

Prefix: **`Mod-k`** (`⌘K` on macOS, `Ctrl+K` elsewhere). Press it twice in a terminal to send literal `^K`.

| Chord | Action |
| --- | --- |
| `Mod-k t` | New Terminal |
| `Mod-k g` | New Git |
| `Mod-k j` / `k` | Next / previous tool |
| `Mod-k h` / `l` | Previous / next Window |
| `Mod-k u` | Switch tool |
| `Mod-k w` | Switch Session |
| `Mod-k 1`–`9` | Jump to tool |
| `Mod-k c` | New Session |
| `Mod-k n` | New Window |
| `Mod-k x` | Close tool |
| `Mod-k Shift-X` | Close Session |
| `Mod-k ,` or `Mod-,` | Settings |

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
