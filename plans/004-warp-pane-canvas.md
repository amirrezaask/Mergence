# Plan 004: Match the reference multiplexer’s pane chrome and canvas

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat b3b2219c..HEAD -- packages/yaade-ui/src/mux/MuxPaneChrome.tsx packages/yaade-app/src/tools/ToolTilingWorkspace.tsx packages/yaade-ui/src/styles/materials.css packages/yaade-ui/src/components/glass.tsx tests/electron/tool-sessions.electron.spec.ts tests/electron/liquid-glass.electron.spec.ts README.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.
>
> **Prerequisite**: Plan 003 (`plans/003-warp-top-chrome.md`) must be DONE.
> This plan assumes the desktop top bar already has search, Session dropdown,
> Window pills, and Settings, and that the Agents sidebar does not occupy
> width when empty.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/003-warp-top-chrome.md
- **Category**: direction
- **Planned at**: commit `b3b2219c`, 2026-08-18

## Why this matters

After the top bar matches the reference, the remaining visual miss is the
work surface: YAADE’s pane header is a busy mux toolbar (context chevron,
split right, split down, zoom, close in a glass control group) on a liquid
ambient canvas. The reference screenshot’s second row is a thin quiet
header — process glyph, title, expand, overflow — over an opaque white
terminal field with a hairline under the tab bar.

This plan makes a single tiled pane in light mode read as that inner
frame. It does **not** clone Claude Code’s pixel mascot, MCP warning, or
status footer; those are PTY cells.

## Current state

Reference inner frame:

```text
┌──────────────────────────────────────────────────────────────┐
│  >_   * Claude Code                          ⤢   ⋯           │  ← ~28px
├──────────────────────────────────────────────────────────────┤
│  (opaque paper terminal / git surface)                       │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

YAADE today (`packages/yaade-ui/src/mux/MuxPaneChrome.tsx`):

- Height `h-7`, `border-b border-border/50`, `bg-transparent`.
- Left: process glyph (`processIdentity`), optional context `ChevronDown`
  (`data-yaade-mux-context-trigger`), mono `font-semibold` title.
- Right: `GlassControlGroup` with split right, split down, zoom (only if
  `canZoom`), close. Controls are `opacity-60` until hover.
- Context menu duplicates split / zoom / close.

`packages/yaade-app/src/tools/ToolTilingWorkspace.tsx` wraps that chrome
with a project/worktree popover anchored on the whole header.

`packages/yaade-ui/src/styles/materials.css` paints `.yaade-ambient-canvas`
with radial primary/info washes and noise. The reference chrome is flat
light gray; the content pane is flat white.

`tests/electron/tool-sessions.electron.spec.ts` clicks
`[data-yaade-mux-context-trigger]` to open project context — that selector
must keep working, even if the trigger moves into the overflow menu.

Repo conventions: same as plan 003. `MuxPaneChrome` currently deep-imports
`@/components/ui/button.js` and context-menu. Match **this file’s** existing
import style; do not “clean up” the rest of the mux package.

Do not copy the `*` before the reference title. YAADE already has focused
vs muted title color; use that instead of a literal asterisk.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Typecheck | `pnpm -r typecheck` | exit 0 |
| Lint | `pnpm lint` | exit 0 |
| Electron | `pnpm exec playwright test tests/electron/tool-sessions.electron.spec.ts tests/electron/liquid-glass.electron.spec.ts tests/electron/git-tool.electron.spec.ts --project=electron` | all pass |

## Suggested executor toolkit

- `packages/yaade-ui/AGENTS.md` — tokens, lucide, motion, Playwright.
- Overflow exemplar: `DropdownMenu` in `packages/yaade-app/src/tools/ToolUseTabStrip.tsx`.
- Keep `processIdentity()` glyph on the left (`>_` for shells). That already
  matches the reference.

## Scope

**In scope**:

- `packages/yaade-ui/src/mux/MuxPaneChrome.tsx`
- `packages/yaade-app/src/tools/ToolTilingWorkspace.tsx` (only as needed to
  keep split/context wiring when controls move into overflow)
- `packages/yaade-ui/src/styles/materials.css` (light-mode canvas flattening)
- Electron specs that assert pane chrome
- `README.md` only if pane close/zoom UX needs a one-line mention (skip if
  unchanged user-facing commands)

**Out of scope**:

- Top bar / Window pills / Agents sidebar (plan 003).
- Mobile.
- Terminal renderer, Ghostty theme, PTY, Git diff internals.
- Cloning Claude Code’s TUI, mascot, or status line.
- Binding new zoom/close chords.
- Dark-mode ambient canvas removal (flatten **light** so it matches the
  screenshot; keep dark canvas distinctive unless the same tokens make it
  look broken — if flattening light also kills dark atmosphere, gate the
  quiet canvas on `:root:not(.dark)` / light scheme).

## Git workflow

- Same as plan 003. Example message: `quiet pane chrome to match reference`.
- Do NOT push or open a PR unless asked.

## Steps

### Step 1: Quiet `MuxPaneChrome`

Keep drag-to-dock, double-click zoom, context menu, and all existing
`data-yaade-mux-*` attributes that tests use.

Visible controls, left to right:

1. Process glyph (unchanged).
2. Title (switch pane title from `font-mono` to `font-sans` `text-xs`
   `font-medium` so it matches the reference UI chrome, not the PTY).
3. Spacer.
4. Zoom/expand `Maximize2` / `Minimize2` — **always visible** when the pane
   can zoom **or** when there is only one pane (still show expand; no-op or
   hide only if zoom is meaningless). The reference shows expand on a single
   pane. Prefer: always show the button; if `!canZoom`, disable it with
   `aria-disabled` rather than hiding, unless that confuses tests — then show
   only when `canZoom` OR `paneCount === 1` as a non-toggle visual. Simplest
   correct behavior: show zoom whenever `canZoom`; when a single pane, omit
   it. The screenshot’s expand on a single Claude pane is Warp-specific
   fullscreen. Map it to existing `pane.zoom` (`Mod-k z`). Showing it only
   when `canZoom` is acceptable.
5. Overflow `EllipsisVertical` (`data-yaade-mux-pane-overflow=""`):
   - Set project / worktree → call `onOpenContext` (this **is** the
     `data-yaade-mux-context-trigger` — keep that attribute on this item or
     on a menu item that tests can click).
   - Split right / split down (keep `data-yaade-mux-split` on the menu items
     or on hidden-but-present controls if tests query the toolbar — grep
     tests before removing toolbar splits).
   - Close pane (`data-yaade-mux-close-pane`).

Remove the always-visible `GlassControlGroup` split/close cluster.

**Critical test compatibility**: `tests/electron/tool-sessions.electron.spec.ts`
does `page.locator('[data-yaade-mux-context-trigger=""]').click()`. After
this change that click must still open the project/worktree popover. Either:

- Keep a visible, quiet chevron **or**
- Put `data-yaade-mux-context-trigger` on the overflow item and change the
  test to open overflow then choose “Project and worktree”.

Prefer updating the test: click overflow, then the menu item. Grep for
`data-yaade-mux-split`, `data-yaade-mux-close-pane`, `data-yaade-mux-zoom`
across `tests/` and update locators rather than leaving invisible buttons.

Title: do not prefix `*`. Focused title uses `text-foreground`; unfocused
uses `text-muted-foreground`.

**Verify**: `rg "data-yaade-mux-" tests` — every locator still has a target
in `MuxPaneChrome.tsx` or the overflow menu.

### Step 2: Keep split picker popovers working

`ToolTilingWorkspace.tsx` wraps split buttons with `PaneNewToolMenu`. After
splits move into a menu, trigger `onSplitButton` / `wrapSplitButton` from
the overflow items the same way. Do not lose “split then pick Terminal/Git”.

**Verify**: `pnpm -r typecheck` exits 0.

### Step 3: Flatten light-mode canvas under the work surface

The reference content area is opaque white; the chrome around it is flat
light gray. In `materials.css`:

- For light scheme only, set `--yaade-canvas-background` to `var(--background)`
  or a `color-mix` of `--muted` and `--background` with **no** primary/info
  radials, and `--yaade-canvas-noise-opacity: 0`.
- Keep dark-mode canvas as it is unless the light-only override is messy —
  then use `:root:not(.dark)` for the quiet canvas.
- Content panes (`material="content"`) stay matte (`--yaade-material-content-blur: 0` already).
- Do not introduce hex. The paper field is `--background`; the chrome field
  is `--muted` / `--sidebar`.

Do not disable liquid-glass globally. Settings still have no material
switch (existing test). Quiet canvas is enough for screenshot parity.

**Verify**: glass gallery test still passes (`tests/electron/liquid-glass.electron.spec.ts`
gallery assertions about blur on floating/content). If a gallery test
requires a radial canvas, do not change the gallery page; only the session
shell canvas.

### Step 4: Playwright for pane chrome

Add or extend an Electron test (same file as tool-sessions is fine):

- Open a Terminal pane.
- Assert `[data-yaade-mux-pane-chrome]` is visible.
- Assert the overflow trigger is visible (`[data-yaade-mux-pane-overflow]`).
- Assert toolbar no longer shows two always-visible split icon buttons
  (count of `[data-yaade-mux-split]` in the header row is 0; they may exist
  inside the open menu).
- Open overflow, choose project context, existing folder-picker flow still
  works (adapt the current context test).
- With two panes, zoom control is visible and toggling `data-yaade-pane-zoomed`
  still works (`Mod-k z` remains the command; do not add animation on that
  keyboard path).

Git tool spec should still find the Git surface.

**Verify**: Electron commands in the table all pass.

## Test plan

- Adapt `tool-sessions.electron.spec.ts` context-popover test to the overflow
  entry point.
- Add pane overflow / hidden split assertions as in Step 4.
- Pattern: that file’s existing `data-yaade-*` locators.
- No PNG snapshots.

## Done criteria

- [ ] Single-pane header reads as glyph + title + (zoom if applicable) + overflow
- [ ] Split and close are not always-visible icon buttons
- [ ] Project/worktree is still reachable; Electron context test passes
- [ ] Light-mode session canvas has no colored radial wash or noise
- [ ] `pnpm -r typecheck` exits 0
- [ ] Electron specs listed above pass
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row for 004 updated

## STOP conditions

Stop and report if:

- Plan 003 is not actually done (top bar still Settings-left + connected tabs).
- Grep shows pane locators in tests you cannot retarget without editing
  out-of-scope packages.
- Flattening the canvas requires deleting `GlassSurface` or the material
  gallery.
- Zoom-on-single-pane seems to need a new “fullscreen window” feature.
- You are tempted to restyle Ghostty colors to mimic Claude Code’s light TUI.

## Maintenance notes

- Keyboard-initiated zoom (`Mod-k z`) must stay instant (no decorative
  motion on a high-frequency chord).
- Reviewers: overflow menus should use existing `DropdownMenu` / context
  menu primitives; do not add a third menu system.
- Deferred: `Alt-1`…`Alt-9` Window jump (Electron-only), custom tab colors,
  collapsing Agents into a trailing icon when agents exist.
