# AGENTS.md — YAADE

## Product

YAADE is a server-hosted browser terminal multiplexer for running coding agents. The TypeScript server owns PTYs, child processes, and persistence; the browser renders Sessions → Windows → tiled terminals as a control and observation UI.

The only supported terminal type is `terminal` — a server-side PTY with replay, flow control, and mobile controls. Coding agents are ordinary CLI processes launched inside these terminals.

Do not add standalone Git, search, editor, file-browser, or agent-chat surfaces. Agent input and output belong in the terminal multiplexer; agents run on the server, never in the browser.

## Layout

- `apps/server` — Rust HTTP/WS host, session multiplexer, PTY lifecycle, persistence, and service CLI
- `apps/web` — thin Vite web executable that uses `@yaade/app`
- `packages/yaade-app` — React Session shell
- `packages/yaade-rpc` — Effect Schema contracts
- `packages/yaade-host-client` — browser control and observation transport
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
vp run build:desktop
vp run test:desktop
vp run test:web:e2e
vp exec playwright test --project=platform-e2e
```

Tests run through Vite+ (`vp test`) with Vitest. App tests must be listed in `packages/yaade-app/package.json`.

The web dev server runs through Vite+; start the Bun-backed host with
`vp run @yaade/server#dev` (or `vp run dev:server`).

## Application isolation

The repository has exactly three executable applications:

- `apps/server` owns the server process entrypoint and the server-side execution boundary.
- `apps/web` owns only Vite configuration and browser packaging.
- `apps/desktop` is a thin Tauri shell that embeds the same `@yaade/app` React client as the browser. It never owns PTYs or agent processes.

Reusable client implementation belongs in `packages/`; do not fork browser and
desktop Session, Window, terminal, transport, or state behavior. Native Rust in
`apps/desktop` must remain limited to the Tauri application boundary unless a
concrete platform feature requires more. Applications may depend on packages or
wire contracts, but they must not import another application's source. The root build and
development commands are intentionally independent: `build:server`,
`build:web`, `build:desktop`, `dev:server`, `dev:web`, and `dev:desktop`. Web and
desktop development do not start a host process; start `dev:server` separately.
Never add a separate agent server or provider-specific process boundary: launch
agent CLIs through the existing server terminal runtime.

## Architecture invariants

- `/?s=&t=&term=` identifies Session, Window, and terminal.
- PTY output never enters React state.
- Browser disconnect/reload unsubscribes but does not kill a PTY or the agent running inside it.
- Agents always run on the server inside a terminal PTY; the browser only sends input and renders output through typed host APIs.
- Explicit terminal close kills its PTY and the agent process it owns.
- Terminal control uses the binary WebSocket path with replay and flow control.
- Host work must stay behind typed RPC boundaries.
- Paths are validated against `allowedRoots` on the host.
- Default bind is loopback and may stay open without a token. Binding off loopback requires `--token` / `YAADE_HOST_TOKEN`.
- The host process owns PTYs directly. Browser disconnects do not kill PTYs, but host restart/shutdown kills all PTYs and resets Session/Window/terminal state. There is no detached supervisor, agent control plane, or restart durability; users are responsible for not restarting the host while a long-running agent or command matters.

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
