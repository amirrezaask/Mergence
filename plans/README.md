# Implementation plans

Plans in this directory are implementation-ready handoffs. They describe
scope, exact code surfaces, verification gates, risks, and stop conditions.

## Execution order and status

| Plan | Title | Priority | Effort | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| [001](001-webgl-neovim-tool.md) | Add a standalone WebGL2 Neovim ToolUse backed by one host process per tool | P1 | XL | — | TODO |

Status values: TODO | IN PROGRESS | DONE | BLOCKED | REJECTED

## Dependency notes

- Plan 001 is one vertical feature plan. Execute its internal steps in order:
  contracts/mock → host lifecycle → binary proxy → linegrid → WebGL2 → shell →
  Search migration → E2E/performance/docs.

## Findings considered and rejected

- Rendering Neovim in the existing terminal: rejected because the requested
  feature is a first-class GPU-rendered Neovim ToolKind, not another PTY view.
- WebGPU: rejected because the requested renderer is WebGL and WebGL2 has the
  required instancing, texture arrays, and browser reach without another API.
- Reusing the disabled `editor` ToolKind: rejected because Neovim must coexist
  as its own ToolKind alongside Search and Git.
