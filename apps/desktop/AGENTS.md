# YAADE Desktop

- This application is a thin Tauri shell around the production React client from `@yaade/app`.
- Do not add desktop-only Session, Window, terminal, transport, or state implementations. Shared client behavior belongs in `packages/` and must remain usable by the browser.
- The shell never starts or owns the YAADE host, PTYs, or agent processes. Start `dev:server` separately.
- Keep Tauri permissions minimal. Add commands, plugins, or capabilities only for a concrete native requirement.
- First-party verification commands:
  - `vp run test:desktop`
  - `vp run build:desktop`
  - `vp run test:web`
