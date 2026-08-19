# Implementation Plans

Generated 2026-08-20 against `ce6a08dc`. Execute in order. Each executor: read the plan fully, honor STOP conditions, and update your row when done.

This batch is the Herdr-as-multiplexer cut: YAADE stops owning Sessions → Windows → tiled ToolUses and treats Herdr as the source of truth for workspaces, tabs, panes, PTYs, layout, and agent status.

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| 001  | Spike Herdr as the only multiplexer; do not delete YAADE mux until the PTY/layout contract holds | P1 | M | — | TODO |

Status values: TODO | IN PROGRESS | DONE | BLOCKED | REJECTED

## Dependency notes

- 001 is a **gate**, not a deletion. A later plan to replace `ToolSessionApp` / `tools:*` / the PTY supervisor must not start until 001's done criteria pass, or until a human explicitly accepts the viewer-quality tradeoff documented in 001.
- Do not write a 002 that dual-writes YAADE SQLite layout and Herdr layout. That is the rejected approach.

## Findings considered and rejected

- **Keep YAADE Session/Window/ToolUse and map them 1:1 onto Herdr workspace/tab/pane.** Two authoritative muxes. Focus, zoom, split, and PTY lifetime fight. Higher cost than either a thin Herdr client or the status quo.
- **Feed Herdr layout into `yaade-panels` while YAADE still owns PTYs.** Mux-in-mux. Herdr panes would wrap YAADE PTYs that Herdr cannot see; agent detection and worktrees would desync.
- **Ship Git as a Herdr `plugin.pane.open`.** Herdr plugin panes spawn a `command` process (`PluginManifestPane.command`), not a React surface. The existing `GitWorkspace` UI cannot live there without a new native/TUI host.
- **Delete the YAADE PTY stack in the same change as the UI swap.** Herdr 0.7.4 has no byte-stream PTY + cols/rows resize in the public socket API. Blind deletion would replace a working terminal with snapshot `pane.read`.
