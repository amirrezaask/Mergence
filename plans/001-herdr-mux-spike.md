# Plan 001: Spike Herdr as the only multiplexer; keep YAADE mux until the contract holds

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ce6a08dc..HEAD -- packages/yaade-rpc/src/herdr.ts packages/yaade-rpc/src/tool-session.ts packages/yaade-app/src/tools/ToolSessionApp.tsx packages/yaade-app/src/tools/tool-tiling.ts apps/host-server/src/tool-session-store.ts packages/yaade-node-host/src/terminal.ts packages/yaade-ui/src/panels/TerminalPanel.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `ce6a08dc`, 2026-08-20

## Why this matters

YAADE currently *is* a multiplexer: Session → Window (`tab-*`) → tiled ToolUses, with host-owned PTYs and `layoutJson` in SQLite. Herdr 0.7.4 already *is* that multiplexer: Workspace → Tab → Pane, with a durable daemon, agent detection, worktrees, and layout as host truth.

Running both is the expensive shape. The cheap shape is: Herdr owns identity, layout, and processes; YAADE is chrome (Git overlay, theme, Electron) plus a projection of `session.snapshot`.

That cut is **not** "delete `tools:*` this week." Herdr's public socket API is control + screen-buffer read, not YAADE's binary PTY WebSocket. This plan proves (or disproves) that a browser client can be a first-class Herdr terminal. Only then may a later plan delete the YAADE mux.

## Current state

### Two hierarchies

YAADE (`packages/yaade-rpc/src/tool-session.ts`):

- `SessionId` branded `ses-*`
- `SessionTabId` branded `tab-*` — comment: "tmux-window equivalent"
- `ToolUseId` branded `use-*` — kinds exactly `terminal` | `git`
- `SessionTab.layoutJson` — versioned split tree for `yaade-panels`

Herdr (`herdr api schema`, protocol 16):

- `workspaces[]`, `tabs[]`, `panes[]`, `layouts[]`, `agents[]` in `session.snapshot`
- Layout is cell rects + splits, not a dock tree the browser mutates locally
- Worktree metadata hangs off the **workspace**, not a per-tool checkout

Natural mapping (use these names in code and comments; do not invent a third vocabulary):

| YAADE today | Herdr | Keep in YAADE after cut? |
| --- | --- | --- |
| Session | Workspace | No — projection only |
| Window / `SessionTab` | Tab | No — projection only |
| Terminal ToolUse | Pane | No — projection only |
| Git ToolUse | none | Yes — overlay bound to focused pane `cwd` / workspace `worktree` |
| `layoutJson` in SQLite | `layouts[]` / `layout.export` / `layout.apply` | No |
| Host PTY + supervisor | Herdr daemon PTY | No, **if** spike passes |
| `/?s=&t=&u=` | workspace/tab/pane ids | Replace later |

### YAADE already typed Herdr, but nothing calls it

`packages/yaade-rpc/src/herdr.ts` defines `HerdrSnapshot`, `HerdrWorkspace`, `HerdrTab`, `HerdrPane`, `HerdrLayout`. `packages/yaade-rpc/src/index.ts` re-exports it. No app or host-server import uses those types for I/O.

The comment in `packages/yaade-app/src/tools/ToolSessionApp.tsx` around the layout-adopt effect ("Herdr keeps layout authoritative on the host") describes **YAADE's own** revision-checked `tools:saveTabLayout` path, not a live Herdr socket.

### Working thin client already exists (donor, do not rewrite)

`/Users/amirrezaask/dev/herdr-web` (sibling repo, not this workspace):

- Unix socket bridge: `server/bridge.ts` → `~/.config/herdr/herdr.sock` or `HERDR_SOCKET_PATH`
- RPC: `POST /api/herdr/rpc` with `{ id, method, params }`
- Events: `WS /api/herdr/events` via `events.subscribe`
- UI: `src/components/herdr-shell.tsx` renders Herdr layout rects as `position:absolute` panes
- Terminal: `pane.read` ANSI snapshot into Ghostty WASM; input via `pane.send_input`
- `onResize` is a no-op

YAADE already has a higher-quality Ghostty path: `packages/yaade-ui/src/panels/TerminalPanel.tsx` attaches a live PTY over the binary WebSocket (`packages/yaade-rpc/src/terminal-ws.ts`) with replay, ack/flow control, and cols/rows resize.

### Herdr 0.7.4 public API (authoritative)

Inspect live schema with `herdr api schema --json`. Methods that matter:

**Mux control (replace `tools:createSession` / `createTab` / `saveTabLayout` / splits):**

- `session.snapshot`
- `workspace.{create,list,get,focus,rename,close,move}`
- `tab.{create,list,get,focus,rename,close,move}`
- `pane.{split,zoom,focus,focus_direction,resize,close,swap,move,layout}`
- `layout.{export,apply,set_split_ratio}`
- `worktree.{list,create,open,remove}`
- `agent.{list,get,start,focus,send,read}`
- `events.subscribe`

**Terminal I/O (the spike target):**

- `pane.send_input` / `pane.send_text` / `pane.send_keys` — input
- `pane.read` — `{ text, revision, truncated, source, format }` screen dump
- Event `pane_output_changed` `{ pane_id, workspace_id, revision }` — **not** bytes
- `pane.resize` — tmux **direction** (`left|right|up|down`) + amount, **not** PTY cols/rows
- No method named like `pane.stream`, `terminal.attach`, or `pty.write` in the request schema `oneOf` (85 methods)

**Not a React Git host:** `plugin.pane.open` launches `PluginManifestPane.command`. Git stays a YAADE overlay.

### Mux code that a later deletion plan would remove (do not touch in 001)

Approximate size at `ce6a08dc`:

- `packages/yaade-app/src/tools/ToolSessionApp.tsx` — 2556 lines, session shell
- `apps/host-server/src/tool-session-store.ts` — 1276 lines, SQLite mux
- `packages/yaade-app/src/tools/tool-tiling.ts` — 502 lines, `yaade-panels` adapter
- `packages/yaade-rpc/src/tool-session.ts` — 571 lines, Session/Tab/ToolUse schemas
- `packages/yaade-node-host/src/terminal.ts` — 918 lines, PTY implementation

Host routes to keep even after a later cut: `git:*`, `fs:*` (if Git overlay still needs them), appearance/settings. Host routes that become Herdr: `tools:*` session/tab/use, `terminal:*` create/attach/write/ack/resize/dispose.

### Repo conventions

- ESM `.js` imports, Effect Schema in `@yaade/rpc`, no `any`
- Tests: `node:test` via `tsx`, listed in the package's `package.json`
- UI: `@yaade/ui/primitives`, semantic tokens (`packages/yaade-ui/AGENTS.md`)
- Do not add Agent/Search/Editor ToolKinds (`AGENTS.md`)
- Do not commit unless asked

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Herdr version | `herdr --version` | `herdr 0.7.4` or newer with the same protocol 16 methods |
| Schema dump | `herdr api schema --json` | JSON with `protocol` and `schemas.request` |
| Snapshot | `herdr api snapshot` | Live workspaces/tabs/panes (Herdr server must be running) |
| Typecheck | `pnpm -r typecheck` | exit 0 |
| Unit tests | `pnpm test` | all pass |
| herdr-web typecheck | `(cd /Users/amirrezaask/dev/herdr-web && pnpm typecheck)` | exit 0 if that repo is present |

## Suggested executor toolkit

- Read `/Users/amirrezaask/dev/herdr-web/README.md` and `src/lib/herdr-rpc.ts` before writing any Yaade Herdr client.
- Use Effect Schema in `@yaade/rpc` if you add a typed client; match `packages/yaade-rpc/src/herdr.ts` rather than inventing parallel types.

## Scope

**In scope** (the only files you should modify):

- `plans/001-herdr-mux-spike.md` — append a **Spike report** section with measured results (required)
- `plans/README.md` — status row only
- Optional, only if the spike needs a throwaway probe **outside the app shell**:
  - `scripts/herdr-mux-spike.mjs` (create; must not be imported by `apps/` or `packages/`)
  - `packages/yaade-rpc/src/herdr.ts` — extend schemas to match live `herdr api schema` **only if** the probe should share types; do not wire them into `routes.ts`

**Out of scope** (do NOT touch):

- `packages/yaade-app/src/tools/ToolSessionApp.tsx` and `tool-tiling.ts`
- `apps/host-server/src/tool-session-store.ts` and `dispatch.ts` `tools:*` handlers
- `packages/yaade-node-host/src/terminal.ts` and the PTY supervisor
- `packages/yaade-rpc/src/routes.ts` / `tool-session.ts` (no route swaps)
- Electron packaging, keybindings catalog, Git UI
- Copying `herdr-web` into this monorepo
- Dual-writing layout to SQLite and Herdr

## Git workflow

- Branch: `advisor/001-herdr-mux-spike` if you need a branch; otherwise keep the spike report in the plan file on the current branch
- Commit only if the operator asked; message style like `fix git issues` / `fix zoom` (imperative, short)
- Do NOT push or open a PR unless asked

## Steps

### Step 1: Confirm Herdr is the live mux daemon

Run:

```bash
herdr --version
herdr status
herdr api snapshot | head -c 2000
```

**Verify**: version prints; `status` shows a running server; snapshot JSON includes `workspaces`, `tabs`, `panes`, `layouts`. If the server is not running, tell the operator to start Herdr (`herdr`) and stop.

Record in the spike report: protocol number, workspace count, whether `worktree` appears on any workspace.

### Step 2: Confirm the PTY stream gap in the live schema

Run:

```bash
herdr api schema --json | python3 -c '
import json,sys
d=json.load(sys.stdin)
methods=[]
for item in d["schemas"]["request"]["oneOf"]:
    t=item.get("properties",{}).get("method",{})
    if isinstance(t, dict) and "const" in t:
        methods.append(t["const"])
print("protocol", d.get("protocol"))
for needle in ("stream","attach","pty","resize","send_input","read","graphics"):
    hits=[m for m in methods if needle in m]
    print(needle, hits)
print("pane.resize" in methods, "pane.read" in methods, "pane.send_input" in methods)
'
```

**Verify**: `pane.read` and `pane.send_input` exist; no `*stream*` / `*pty*` method. `pane.resize` exists.

In the spike report, quote the `PaneResizeParams` shape (direction vs cols/rows). If a newer Herdr adds `pane.stream` or cols/rows resize, **stop the "viewer-only" conclusion** and re-evaluate Step 3 against that new method instead of `pane.read`.

### Step 3: Measure terminal quality of `pane.read` + `pane.send_input`

Use `/Users/amirrezaask/dev/herdr-web` if present (`pnpm dev`, Herdr already running). If that repo is missing, write `scripts/herdr-mux-spike.mjs` that:

1. Connects to `HERDR_SOCKET_PATH` or `~/.config/herdr/herdr.sock`
2. Sends newline-delimited JSON `{id,method,params}` (see `herdr-web/server/bridge.ts` `sendUnixRequest`)
3. Calls `session.snapshot`, picks the focused pane
4. Calls `pane.send_input` with a unique marker (e.g. `echo SPIKE-<unix>\n`)
5. Polls `pane.read` with `source: visible`, `format: ansi` until the marker appears or 2s elapses
6. Prints elapsed ms, `revision` before/after, `truncated`

Manual checks (operator or executor with a display) — record pass/fail, do not skip:

| Check | Pass means |
| --- | --- |
| Typing latency | Keys in herdr-web appear in the pane without multi-hundred-ms batching feel |
| `vim` or `htop` | Alternate screen, cursor, and redraw are usable — not a frozen or torn dump |
| Agent TUI (`pi` / `claude` in a pane) | Spinner/stream updates continuously, not in 200–500ms snapshot jumps |
| Split + zoom | `pane.split` / `pane.zoom` then snapshot `layouts[]` matches what Ghostty Herdr shows |
| Two clients | Native Herdr (Ghostty) and herdr-web both open: focus/input do not steal the PTY into a broken state |
| Resize | Changing the **browser** pane size does **not** change Herdr PTY cols/rows (document as known gap unless schema now has cols/rows) |

**Verify**: the probe script exits 0 and prints elapsed ms. The table is filled. If herdr-web is missing and you cannot run the UI checks, mark those rows `BLOCKED — needs display` and do not claim the spike passed.

### Step 4: Map YAADE Git onto Herdr without a second mux

Read `packages/yaade-app/src/tools/renderers/GitToolView.tsx` and `packages/yaade-ui/src/home/GitWorkspace.tsx` headers only — do not edit.

In the spike report, write the overlay contract (no code):

- Git root = focused pane `cwd` or workspace `worktree.checkout_path`
- Opening Git does **not** create a YAADE ToolUse or a Herdr pane
- Herdr `worktree.create` / `worktree.open` is the checkout primitive that replaces `tools:listCheckoutTargets` + managed worktrees **if** a later plan lands
- `plugin.pane.open` is **not** the Git host

**Verify**: the spike report contains those four bullets verbatim-or-equivalent.

### Step 5: Write the go / no-go

Append **Spike report** to this file with:

```markdown
## Spike report

- Date / Herdr version / protocol:
- pane.read round-trip ms (echo marker):
- TUI usable (vim/htop): yes/no — evidence:
- Agent TUI usable: yes/no — evidence:
- Independent browser PTY resize: yes/no
- Dual-client (Ghostty + web) safe: yes/no
- Verdict: FIRST_CLASS | VIEWER | NO_GO
```

Verdict meanings:

- **FIRST_CLASS** — later plan may replace YAADE `terminal:*` and `tools:*` mux with a Herdr bridge + Ghostty surfaces. Host-server shrinks to: Unix proxy + `git:*`/`fs:*`.
- **VIEWER** — later plan may replace the **session chrome** (rail, tabs, splits as projections) but **must keep** YAADE PTYs **or** accept snapshot terminals. Do not delete `packages/yaade-node-host/src/terminal.ts`.
- **NO_GO** — keep YAADE mux; treat Herdr as an external daemon the user already runs. Do not dual-map.

**Verify**: `grep -n "Verdict:" plans/001-herdr-mux-spike.md` shows exactly one of `FIRST_CLASS|VIEWER|NO_GO`.

### Step 6: Update the index

Set `plans/README.md` row 001 to `DONE` or `BLOCKED (reason)`.

**Verify**: `pnpm -r typecheck` still exits 0 (you should not have changed app code). `git status` shows only `plans/` and optionally `scripts/herdr-mux-spike.mjs` and `packages/yaade-rpc/src/herdr.ts`.

## Test plan

- No production tests in 001. The probe script is the characterization test.
- If you add `scripts/herdr-mux-spike.mjs`, it must be runnable with `node scripts/herdr-mux-spike.mjs` and exit non-zero when the socket is missing.
- Do not add herdr-web tests into this repo.

Verification: `pnpm test` still passes (unchanged). `node scripts/herdr-mux-spike.mjs` exits 0 when Herdr is up, if the script was created.

## Done criteria

- [ ] Drift check against `ce6a08dc` was run
- [ ] Spike report section exists in this file with round-trip ms and the six-row manual table
- [ ] Verdict is exactly `FIRST_CLASS`, `VIEWER`, or `NO_GO`
- [ ] No changes to `ToolSessionApp`, `tool-session-store`, `terminal.ts`, or `routes.ts`
- [ ] `pnpm -r typecheck` exits 0
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Herdr is not installed or the socket API is a different protocol **and** `pane.read` / `session.snapshot` are gone
- You believe you must edit `ToolSessionApp.tsx` or delete `tools:*` to complete the spike
- A live schema **does** include a byte-stream attach **and** you are about to implement it in host-server — that is a new plan, not 001
- You are about to copy herdr-web into `apps/` or vendor a second Ghostty WASM
- `herdr api snapshot` returns production secrets you would paste into the plan — record counts and ids only, never pane text that may contain tokens

## Maintenance notes

- Reviewer: the only valuable artifact is the verdict plus evidence. A green typecheck with no spike report is a failed execution.
- If verdict is `VIEWER`, a follow-up plan should port **chrome only**: replace Session/Window pills with Herdr workspace/tab rail, keep `TerminalPanel`'s PTY attach. That still requires a policy for "who owns the PTY" — default: YAADE keeps PTYs, Herdr is not in-process. Mixing Herdr panes with YAADE PTYs is the rejected dual-mux.
- If verdict is `FIRST_CLASS`, the next plan should:
  1. Add a loopback Herdr bridge in `apps/host-server` modeled on `herdr-web/server/bridge.ts` (allowlist methods; newline JSON)
  2. Render `snapshot.layouts` instead of `restoreToolWorkspace`
  3. Point Ghostty `onData` at `pane.send_input` and feed output from a **stream if it exists**, else document remaining `pane.read` gaps
  4. Bind Git overlay to focused pane cwd
  5. Delete `tools:*` and `terminal:*` only after Electron e2e (`tests/electron/tool-sessions.electron.spec.ts`, `terminal-compatibility.electron.spec.ts`) are rewritten against Herdr
- `packages/yaade-rpc/src/herdr.ts` should be regenerated from `herdr api schema` when protocol increments; it is currently a hand subset.
- Product docs: `AGENTS.md` still says YAADE is the multiplexer. After a later cut, that sentence becomes "YAADE is a Herdr client plus Git." `advisor-plans/PRODUCT-DEFINITION.md` still assumes YAADE replaces tmux; this cut **accepts Herdr as tmux**.
