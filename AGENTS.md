# AGENTS.md — YAADE

## Product

YAADE is a browser terminal multiplexer. The TypeScript host owns PTYs and persistence. The browser renders Sessions → Windows → tiled terminals.

The only supported terminal type is `terminal` — host PTY, replay, flow control, and mobile controls.

Do not add standalone Git, search, editor, or file-browser surfaces. External command-line programs run inside terminals like any other command.

## Layout

- `apps/server` — thin server executable that uses `@yaade/host-server`
- `apps/web` — thin Vite web executable that uses `@yaade/app`
- `packages/yaade-app` — React Session shell
- `packages/yaade-rpc` — Effect Schema contracts
- `packages/yaade-host-server` — reusable HTTP/WS host and terminal lifecycle
- `packages/yaade-host-client` — browser transport
- `packages/yaade-node-host` — filesystem and PTY implementation
- `packages/yaade-panels` — dock tree
- `packages/yaade-ui` — design system and Terminal surfaces
- `packages/yaade-workspace` — shared terminal host ports and keyboard helpers

Keep package imports acyclic. Lower layers must not import React.

## Commands

```bash
vp install
vp run typecheck
vp run test:server
vp run test:web
vp run lint
vp run build:server
vp run build:web
vp run test:web:e2e
vp exec playwright test --project=platform-e2e
```

Tests run through Vite+ (`vp test`) with Vitest. App tests must be listed in `packages/yaade-app/package.json`.

The web dev server runs through Vite+; start the Bun-backed host with
`vp run @yaade/server#dev` (or `vp run dev:server`).

## Application isolation

The repository has exactly two executable applications:

- `apps/server` owns only the server process entrypoint.
- `apps/web` owns only Vite configuration and web packaging.

Reusable implementation belongs in `packages/`. Applications may depend on
packages, but they must not import another application's source. The root
build and development commands are intentionally independent: `build:server`,
`build:web`, `dev:server`, and `dev:web`. Web development does not start a host
process; start `dev:server` separately when the web proxy needs one.

## Architecture invariants

- `/?s=&t=&term=` identifies Session, Window, and terminal.
- PTY output never enters React state.
- Browser disconnect/reload unsubscribes but does not kill a PTY.
- Explicit terminal close kills its PTY.
- Terminal control uses the binary WebSocket path with replay and flow control.
- Host work must stay behind typed RPC boundaries.
- Paths are validated against `allowedRoots` on the host.
- Default bind is loopback and may stay open without a token. Binding off loopback requires `--token` / `YAADE_HOST_TOKEN`.
- The host process owns PTYs directly. Browser disconnects do not kill PTYs, but host restart/shutdown kills all PTYs and resets Session/Window/terminal state. There is no detached supervisor or restart durability; users are responsible for keeping the host alive during long-running commands.

## UI rules

Read `packages/yaade-ui/AGENTS.md` before changing visible UI.

- Use `@yaade/ui/primitives`; do not deep-import shadcn files.
- Use semantic theme and motion tokens; no hardcoded colors, font sizes, or durations.
- Visible state transitions need intentional, interruptible motion and reduced-motion behavior.
- Any user-visible change must be verified with Playwright.

## Coding rules

- Keep diffs minimal and follow existing ESM `.js` imports.
- Backward compatibility for persisted Session state is not required yet. Prefer a database/state reset over migration or compatibility machinery when a breaking change keeps the implementation simpler.
- No `any`, unsafe casts, or broad unvalidated external values.
- Use Effect typed errors/services/layers where the surrounding host code does.
- Package exports point to source, never stale `dist` output.
- Do not commit unless asked.

## Verification

For UI work, assert scoped DOM state and resulting behavior. For list UIs, verify row count, real row content, non-empty state, spacing, and visibility. For terminal keyboard behavior, assert PTY output rather than only browser events.

Core E2E suites:

- `tests/web/e2e/terminal-multiplexer.web.spec.ts`
- `tests/web/e2e/terminal-compatibility.web.spec.ts`
