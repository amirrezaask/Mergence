# YAADE Desktop

A thin [Tauri 2](https://v2.tauri.app/) shell around YAADE's React client.
The browser and desktop applications use the same `@yaade/app` implementation,
terminal renderer, typed host client, settings, and Session → Window → terminal
interaction model. The Rust side only creates the native window.

The desktop client connects to `http://127.0.0.1:4747` as its built-in local
host. Add authenticated or remote hosts through **Settings → Servers**, just as
in the browser client. It never starts a host or owns PTYs and agent processes.

```bash
vp install
vp run dev:server   # separate terminal
vp run dev:desktop
```

Build the native application and installers with:

```bash
vp run build:desktop
```

Tauri runs the web build automatically and embeds `apps/web/dist`, so desktop
releases cannot drift onto a separate client implementation.
