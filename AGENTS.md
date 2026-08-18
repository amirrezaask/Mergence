# AGENTS.md — YAADE

## Product

YAADE is a browser multiplexer for **Terminal and Git**. The TypeScript host owns PTYs, persistence, filesystem access, and Git operations. The browser renders Sessions → Windows → tiled ToolUses.

Supported ToolKinds are exactly:

- `terminal` — host PTY, replay, flow control, mobile controls
- `git` — repository history and diff UI

Do not add standalone Agent, Search, Editor, or Neovim ToolUses. Agent CLIs run inside Terminal.

## Layout

- `apps/host-server` — Effect-based HTTP/WS host and ToolUse lifecycle
- `apps/yaade` — Vite frontend
- `packages/yaade-app` — React Session shell
- `packages/yaade-rpc` — Effect Schema contracts
- `packages/yaade-host-client` — browser transport
- `packages/yaade-node-host` — filesystem, Git, and PTY implementation
- `packages/yaade-panels` — dock tree
- `packages/yaade-ui` — design system, Terminal and Git surfaces
- `packages/yaade-workspace` — shared host API and keyboard helpers (legacy surface should continue shrinking)
- `packages/yaade-agent-telemetry` — optional telemetry for agent CLIs launched in terminals

Keep package imports acyclic. Lower layers must not import React.

## Commands

```bash
pnpm install
pnpm -r typecheck
pnpm test
pnpm lint
pnpm test:e2e
pnpm build
```

Tests use `node:test` through `tsx`, not Vitest. App tests must be listed in `packages/yaade-app/package.json`.

## Architecture invariants

- `/?s=&t=&u=` identifies Session, Window, and ToolUse.
- Project and checkout belong to each ToolUse.
- PTY output never enters React state.
- Browser disconnect/reload unsubscribes but does not kill a PTY.
- Explicit Terminal ToolUse close kills its PTY.
- Terminal control uses the binary WebSocket path with replay and flow control.
- Host work must stay behind typed RPC boundaries.
- Paths are validated against `allowedRoots` on the host.
- The service has no authentication; keep the default loopback bind and never claim remote deployment is secure.

## Keyboard

The canonical catalog is `packages/yaade-app/src/keybindings.ts`.

- Prefix is `Mod-k`.
- Tool creation keys: `t` Terminal, `g` Git.
- Never bind browser-reserved chords.
- A match must call both `preventDefault()` and `stopPropagation()`.
- Never bind bare Escape globally.
- Pressing the prefix twice in Terminal sends literal `^K`.

## UI rules

Read `packages/yaade-ui/AGENTS.md` before changing visible UI.

- Use `@yaade/ui/primitives`; do not deep-import shadcn files.
- Use semantic theme and motion tokens; no hardcoded colors, font sizes, or durations.
- Visible state transitions need intentional, interruptible motion and reduced-motion behavior.
- Any user-visible change must be verified with Playwright.

## Coding rules

- Keep diffs minimal and follow existing ESM `.js` imports.
- No `any`, unsafe casts, or broad unvalidated external values.
- Use Effect typed errors/services/layers where the surrounding host code does.
- Package exports point to source, never stale `dist` output.
- Do not commit unless asked.

## Verification

For UI work, assert scoped DOM state and resulting behavior. For list UIs, verify row count, real row content, non-empty state, spacing, and visibility. For terminal keyboard behavior, assert PTY output rather than only browser events.

Core E2E suites:

- `tests/electron/tool-sessions.electron.spec.ts`
- `tests/electron/terminal-compatibility.electron.spec.ts`
- `tests/electron/git-tool.electron.spec.ts`
