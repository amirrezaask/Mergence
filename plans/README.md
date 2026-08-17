# Implementation plans

Plans in this directory are implementation-ready handoffs. They describe
scope, exact code surfaces, verification gates, risks, and stop conditions.

## Execution order and status

| Plan | Title | Priority | Effort | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| [001](001-webgl-neovim-tool.md) | Add a standalone WebGL2 Neovim ToolUse backed by one host process per tool | P1 | XL | — | SUPERSEDED |
| [002](002-production-webgl-neovim-client.md) | Finish, harden, and optimize the WebGL2 Neovim client for production use | P1 | XL | 001 baseline | TODO |

Status values: TODO | IN PROGRESS | DONE | BLOCKED | REJECTED | SUPERSEDED

## Dependency notes

- Plan 001 established the baseline process, transport, linegrid, WebGL2,
  Session-shell, Search, E2E, and benchmark slice in the current working tree.
  Do not re-execute it.
- Plan 002 is now authoritative. It consumes that baseline and proceeds in this
  order: truthful baseline + real-Neovim contracts → bounded reducer →
  instrumentation → retained packed GPU packets → atlas/typography → input and
  lifecycle hardening → correctness/stress/performance gates → documentation.

## Findings considered and rejected

- Rendering Neovim in the existing terminal: rejected because the requested
  feature is a first-class GPU-rendered Neovim ToolKind, not another PTY view.
- WebGPU: rejected because the requested renderer is WebGL and WebGL2 has the
  required instancing, texture arrays, and browser reach without another API.
- Reusing the disabled `editor` ToolKind: rejected because Neovim must coexist
  as its own ToolKind alongside Search and Git.
