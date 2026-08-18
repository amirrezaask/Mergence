# Plan 003: Match the reference multiplexer’s top chrome

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat b3b2219c..HEAD -- packages/yaade-app/src/tools/ToolSessionApp.tsx packages/yaade-app/src/tools/SessionWindowTabStrip.tsx packages/yaade-app/src/tools/SessionSwitcher.tsx packages/yaade-ui/src/shell/RunningAgentsSidebar.tsx tests/electron/tool-sessions.electron.spec.ts tests/electron/liquid-glass.electron.spec.ts packages/yaade-ui/src/styles/materials.css packages/yaade-ui/AGENTS.md README.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `b3b2219c`, 2026-08-18
- **Status note**: Implemented 2026-08-18. Desktop top bar is search → Session → pill Windows → + → Settings. Empty Agents sidebar no longer occupies width.

## Why this matters

YAADE is a Session → Window → tiled ToolUse multiplexer. The pixel reference
(`/Users/amirrezaask/Desktop/Screenshot 2026-08-18 at 23.49.55.png`) is the
same information architecture rendered as a single quiet top bar: search,
workspace dropdown, disconnected pill tabs, plus, Settings. YAADE already has
those objects, but the default desktop shell does not look like that: Settings
sits on the left, Window tabs are a connected 32px strip with no index or
overflow, the Session switcher lives inside the always-on Agents sidebar, and
the active tab is explicitly tested to have **no** shadow.

This plan restyles and restacks **only the desktop top chrome** so a light-mode
screenshot of YAADE’s default `tabs` layout reads as the same row as the
reference. It does not clone the Claude Code TUI inside the PTY, does not add
tools, and does not change `Mod-k` prefix behavior.

## Current state

Target mapping (do not invent a fourth navigation layer):

| Reference | YAADE object | Today’s chrome |
| --- | --- | --- |
| Magnifying glass | Tool switcher (`tool.switch` / `ToolUseSwitcher`) | No top-bar search control |
| “Default ▾” | Session (`SessionSwitcher`) | Lives in Agents sidebar header |
| Pill tabs `title ⌥N ⋯` | Windows (`SessionWindowTabStrip`) | Connected strip, close-on-hover `X`, no index, no overflow, no process icon |
| `+` | New Window | Present, far right of the strip |
| “Settings” | Settings overlay | Icon-only, **left** of the tabs |

Relevant files:

- `packages/yaade-app/src/tools/ToolSessionApp.tsx` — desktop shell. Default layout is `tabs`. Top bar is Settings + `SessionWindowTabStrip`. Agents sidebar is always mounted and owns `SessionSwitcher`.
- `packages/yaade-app/src/tools/SessionWindowTabStrip.tsx` — Window tabs. Height `h-8`, `gap-0`, `rounded-md`, hover `X`. Active tab has no explicit fill/shadow in the class list.
- `packages/yaade-app/src/tools/SessionSwitcher.tsx` — ghost `h-8` button with `FolderKanban` tile + title + `ChevronsUpDownIcon`.
- `packages/yaade-ui/src/shell/RunningAgentsSidebar.tsx` — complementary “Running agents”; `header` slot is the session switcher.
- `packages/yaade-app/src/hooks/useAppearanceSettings.ts` — `sessionLayout` normalizes to `"tabs"`.
- `packages/yaade-app/src/tools/ToolUseSwitcher.tsx` — existing `PaletteShell` search for tools. Wire the magnifying glass to this; do not add a Search ToolKind.
- `packages/yaade-ui/src/mux/process-identity.ts` — `claude` → `✦`, shells → `>_`. Use this for tab leading icons.
- `tests/electron/liquid-glass.electron.spec.ts` — **blocker**: asserts the active Window tab `boxShadow` is `"none"` and inactive background is fully transparent.
- `tests/electron/tool-sessions.electron.spec.ts` — asserts the session switcher is **inside** the Running agents complementary.

Excerpt — default `tabs` header today (`ToolSessionApp.tsx`):

```tsx
{!sidebarLayout ? (
  <GlassSurface material="shell" asChild>
  <header
    className="flex h-10 shrink-0 items-center gap-0 border-b border-border/80 bg-transparent px-1.5"
    data-yaade-session-tabs=""
    data-yaade-top-tabbar=""
  >
    <ShortcutTooltip label="Settings" …>
      <Button … data-yaade-session-settings=""><Settings /></Button>
    </ShortcutTooltip>
    <SessionWindowTabStrip … />
  </header>
  </GlassSurface>
) : null}
```

Excerpt — Agents sidebar always takes width (`ToolSessionApp.tsx`):

```tsx
{!isMobile ? (
  <div className="relative h-full shrink-0" style={{ width: `${agentSidebarWidth}px` }}>
    <RunningAgentsSidebar
      header={<SessionSwitcher … />}
      …
    />
```

Excerpt — Window tab classes (`SessionWindowTabStrip.tsx`):

```tsx
className={cn(
  "group relative flex h-full min-w-20 max-w-48 cursor-pointer items-center gap-1 rounded-md px-1.5 …",
  active && "text-foreground",
)}
```

Repo conventions the executor must match:

- Semantic tokens only. Never `bg-[#…]`, `text-[#…]`, or raw hex. If a role is missing, add it in `packages/yaade-ui/src/styles/globals.css` / `materials.css` and consume the token.
- Icons: `lucide-react` only. Default `size-4` unless a smaller existing control size is already used (`size-3` appears in this strip).
- Motion: `yaadeMotion` / `--yaade-motion-*`. Do not hardcode durations.
- Import with `.js` ESM suffixes. No `any`. No new ToolKinds.
- Primitives from `@yaade/ui/primitives` in app code (`Button`, `DropdownMenu*`).
- Keyboard catalog is `packages/yaade-app/src/keybindings.ts`. Do **not** bind `Mod-1`…`Mod-9` (browser-reserved). Do **not** rebind `Mod-k 1`–`9` (those jump **tools**, not Windows).
- Visible UI changes need Playwright coverage (`tests/electron/*.electron.spec.ts`).
- Mobile (`MobileToolView`) is out of scope.

Target wireframe (desktop, `tabs` layout, light mode):

```text
┌─ chrome bar (muted, ~40px, hairline bottom) ─────────────────────────┐
│ 🔍   Default ▾   [>_ alasdairmonk ⌥1 ⋯]  [>_ ~ fish ⌥2 ⋯]            │
│                  [✦ Claude Code ⌥3 ⋯]  +                  Settings ⚙ │
└──────────────────────────────────────────────────────────────────────┘
│ pane chrome + content (plan 004)                                      │
```

Active pill: opaque `background` / `card`, large pill radius, soft raised
shadow, sits on the muted bar. Inactive pill: filled muted chip, no shadow,
dark text. Gap between pills. The first reference tab that is dark-on-dark is
a **custom tab color** — do not make that the default inactive style.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Typecheck | `pnpm -r typecheck` | exit 0 |
| Unit tests | `pnpm --filter @yaade/app test` | all pass |
| Lint | `pnpm lint` | exit 0 |
| Electron chrome tests | `pnpm exec playwright test tests/electron/liquid-glass.electron.spec.ts tests/electron/tool-sessions.electron.spec.ts --project=electron` | all pass |

If the Playwright project name differs, read `playwright.config.ts` and use the
Electron project already used by those spec files. Do not invent a new config.

## Suggested executor toolkit

- Read `packages/yaade-ui/AGENTS.md` before changing visible chrome.
- Use existing `DropdownMenu` usage in `packages/yaade-app/src/tools/ToolUseTabStrip.tsx` as the overflow-menu exemplar.
- Use `processIdentity` + `deckTileStyle` from `packages/yaade-ui/src/mux/process-identity.ts` for the leading tab tile (Claude `✦` on a tinted square; shells `>_`).
- `KeyBindingKbd` / `formatKeyBinding` from `@yaade/ui/session` for the index badge.

## Scope

**In scope**:

- `packages/yaade-app/src/tools/ToolSessionApp.tsx`
- `packages/yaade-app/src/tools/SessionWindowTabStrip.tsx`
- `packages/yaade-app/src/tools/SessionSwitcher.tsx`
- `packages/yaade-ui/src/shell/RunningAgentsSidebar.tsx` (only if the header slot must tolerate `undefined`)
- `packages/yaade-ui/src/styles/materials.css` and/or `packages/yaade-ui/src/styles/globals.css` (tab pill tokens only)
- `tests/electron/liquid-glass.electron.spec.ts`
- `tests/electron/tool-sessions.electron.spec.ts`
- `README.md` (session-switcher sentence)

**Out of scope**:

- `MobileToolView` and any mobile layout.
- `MuxPaneChrome`, tiling, terminal PTY, Git UI, Claude Code branding inside the PTY (plan 004).
- Adding Agent / Search / Editor / Neovim ToolUses.
- Rebinding `Mod-k 1`–`9` or binding `Mod-1`–`Mod-9`.
- Dark-mode redesign beyond keeping tokens dual-scheme (light must match the screenshot; dark must remain coherent, not a broken inversion).
- Changing `sessionLayout` away from `"tabs"`.
- Visual screenshot snapshots (this repo asserts DOM + computed styles).
- Committing, pushing, or opening a PR.

## Git workflow

- Branch: `advisor/003-warp-top-chrome` if a branch is needed; otherwise work on the current branch.
- Commit style in this repo is short lowercase (“fixes and improvements”). Prefer one commit per logical unit, e.g. `match reference window tab pills`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add named tokens for pill tabs

In `packages/yaade-ui/src/styles/materials.css` (or `globals.css` if that is where component roles already live), add semantic tokens consumed by the Window strip. Do not hardcode hex in components. Suggested roles (names can match local convention, values must read as the screenshot in light mode):

- `--yaade-tab-pill-inactive-fill` — muted chip, slightly darker than shell
- `--yaade-tab-pill-active-fill` — opaque paper/`background`
- `--yaade-tab-pill-active-shadow` — soft low-alpha raised shadow
- `--yaade-tab-bar-height` — keep ~40px (`h-10`)

Honor `prefers-reduced-transparency` / `data-yaade-reduced-transparency` by keeping fills opaque (the reference chrome is already matte).

**Verify**: `rg "yaade-tab-pill" packages/yaade-ui/src/styles` shows the new tokens.

### Step 2: Restyle `SessionWindowTabStrip` into disconnected pills

Rewrite the strip (same file, same callbacks) to match the reference:

1. Outer row: `h-10`, horizontal gap between pills (`gap-1` / `gap-1.5`), no full-height attached tabs, no `border-b` on the strip itself (the header owns the hairline).
2. Each tab is a pill (`rounded-full` or `--yaade-pill-radius` / a large control radius — match the screenshot’s stadium pills, not `rounded-md`).
3. Content, left to right: process tile (16–18px), truncated title (`text-xs`, sans, medium), index badge, overflow trigger.
4. Active: `data-active="true"`, `--yaade-tab-pill-active-fill`, `--yaade-tab-pill-active-shadow`.
5. Inactive: filled muted chip, **not** `background-color: transparent`.
6. Remove the hover `X` close button. Close lives in the overflow menu.
7. Overflow (`DropdownMenu`, `Ellipsis` / `EllipsisVertical` from lucide): Rename, Close. Keep double-click-to-rename. Keep drag-reorder.
8. `+` stays immediately after the last pill (`data-yaade-new-session-tab`).
9. Keep `data-yaade-window-tabs`, `data-yaade-session-tab`, `role="tablist"` / `role="tab"`.

New props (keep existing ones):

```ts
readonly tabMeta?: ReadonlyMap<SessionTabId, {
  readonly kind: "terminal" | "git"
  readonly processName?: string | null
}>
readonly indexBase?: number // default 1; badge shows 1-based index, hide after 9
```

Leading icon: `processIdentity(processName ?? kind)` and a small tinted square via `deckTileStyle` for non-shell identities (Claude `✦`). Shells: muted `>_` / `Terminal` lucide — prefer the `>_` glyph so pane and tab agree.

Index badge: visual only in this plan. Render `⌥N` on macOS and `Alt+N` elsewhere using existing `formatKeyBinding`. Do not register a new chord here.

**Verify**: `pnpm --filter @yaade/app test` still passes (no strip unit tests today; this is a smoke gate).

### Step 3: Rebuild the `tabs` layout header

In `ToolSessionApp.tsx`, replace the Settings-left + strip header with one `data-yaade-top-tabbar` row:

Left cluster:

1. Search `Button` `size="icon-xs"` `variant="ghost"`, `Search` lucide, `aria-label="Switch tool"`, `data-yaade-tool-search=""`. `onClick` → `setToolUseSwitcherOpen(true)`. Tooltip uses `toolSessionShortcutFor("tool.switch")`.
2. `SessionSwitcher` (existing component). Tighten the trigger: drop the `FolderKanban` tile; title + chevron only, so it reads like “Default ▾”. Keep `data-yaade-session-switcher`.
3. `SessionWindowTabStrip` with `tabMeta` derived from the focused ToolUse in each Window (scan `activeToolWorkspace` / per-tab workspaces + `usesById`; if a Window has no tool, `kind: "terminal"`).

Right cluster (`ml-auto`):

4. Settings **text** + gear. Visible label “Settings”. Keep `data-yaade-session-settings`. Keep `Mod-,` tooltip.

Header surface: muted shell, hairline bottom, **no** heavy glass gradient on this row. Prefer `material="chrome"` or a matte class; the reference bar is flat `#F8F8F8`-like, which in tokens is `muted` / `sidebar` / `secondary`, not a colored ambient wash.

Pass `tabMeta` only on desktop. Do not change `sidebarLayout` branches except: session switcher must also appear in those headers if those layouts still hide it — actually **out of scope to restyle sidebar layouts**, but the switcher must remain reachable. If `tabs` is the only layout (`normalizeSessionLayout` forces `"tabs"`), you can ignore two-sidebar/single-sidebar chrome besides not breaking compile.

**Verify**: `pnpm -r typecheck` exits 0.

### Step 4: Move SessionSwitcher out of the Agents sidebar and hide the sidebar when empty

- Stop passing `header={<SessionSwitcher … />}` into `RunningAgentsSidebar`.
- When `!isMobile && runningAgentItems.length === 0` (and not loading with a previous non-empty list), do not reserve the 256px column. The shell content should be full width under the top bar, matching the reference.
- When agents exist, show the sidebar **without** a session switcher in its header. An empty header is fine; do not add a visible “Agents” heading (`tool-sessions.electron.spec.ts` currently forbids that word).
- Keep resize handle only when the sidebar is visible.
- `RunningAgentsSidebar` may keep `header?: ReactNode` optional.

**Verify**: mentally check `isMobile` still uses `MobileToolView` unchanged.

### Step 5: Update Electron tests

`tests/electron/tool-sessions.electron.spec.ts` first test today expects the session switcher inside the Running agents complementary. Change it to:

- Shell visible.
- `[data-yaade-top-tabbar]` visible.
- `[data-yaade-tool-search]` visible in the top bar.
- `[data-yaade-session-switcher]` visible in the top bar (not inside the agents complementary).
- `[data-yaade-session-settings]` visible in the top bar and its accessible name includes `Settings`.
- With zero running agents, the “Running agents” complementary is **not** visible (or `aria-hidden` / width 0 — pick one and assert it). Do not leave a 256px empty column.
- Keep HUD assertions: prefix still offers New Terminal / New Git, not Search/Neovim as ToolKinds. The new search **button** is allowed; the HUD must still not list a Search tool.

Other tests in that file that click `[data-yaade-mux-context-trigger]` stay valid (pane chrome is unchanged).

`tests/electron/liquid-glass.electron.spec.ts` “top Window tabs…” test:

- Create a second Window, then:
  - Inactive tab computed `background-color` is **not** `rgba(0, 0, 0, 0)`.
  - Active tab `border-radius` is not `0px` and is larger than 8px (pill).
  - Active tab `boxShadow` is **not** `"none"`.
  - Top bar still has no leftover `<span>` chrome (`[data-yaade-top-tabbar] > span` count 0) unless you introduced none.
- Assert the search button and Settings label exist.

Follow existing Playwright style in those files: `data-yaade-*` locators, `expect` on counts and computed styles. No screenshot diffs.

**Verify**: `pnpm exec playwright test tests/electron/liquid-glass.electron.spec.ts tests/electron/tool-sessions.electron.spec.ts --project=electron` → all pass.

### Step 6: README

In `README.md`, replace the sentence that says the Agents sidebar header is the session switcher. State that the top bar holds search, the Session dropdown, Window pills, and Settings; the Agents sidebar appears when agent CLIs are running.

**Verify**: `rg "session switcher" README.md` no longer claims it lives in the Agents sidebar header.

## Test plan

- Update `tests/electron/tool-sessions.electron.spec.ts` as in Step 5 (happy path: empty agents, top-bar switcher).
- Update `tests/electron/liquid-glass.electron.spec.ts` pill geometry (active shadow + radius, inactive fill).
- Pattern: existing tests in those two files. Do not add visual regression PNGs.
- Optional cheap unit test only if you extract a pure `windowTabMeta` helper; not required.

Verification: Electron specs above pass; `pnpm --filter @yaade/app test` passes; `pnpm -r typecheck` exits 0.

## Done criteria

- [ ] Desktop `tabs` layout top bar order is search → SessionSwitcher → Window pills → `+` → Settings.
- [ ] Window tabs are disconnected pills; active has fill + shadow; inactive has muted fill.
- [ ] Each Window tab shows process tile, title, index 1–9, overflow (Rename/Close). No hover `X`.
- [ ] Agents sidebar does not render a column when there are no running agents.
- [ ] Session switcher is not required inside the agents complementary.
- [ ] `pnpm -r typecheck` exits 0
- [ ] `pnpm --filter @yaade/app test` exits 0
- [ ] Updated Electron specs pass
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row for 003 updated

## STOP conditions

Stop and report back (do not improvise) if:

- In-scope files no longer match the excerpts (drift).
- `normalizeSessionLayout` no longer forces `"tabs"` and another layout is the real default.
- Matching the screenshot appears to require a new ToolKind or a Search tool.
- Playwright Electron project cannot launch after two attempts with the existing fixture (`tests/fixtures/e2e.js`).
- You believe `Mod-k 1`–`9` must move from tools to Windows to show `⌥N`.
- A change seems to require editing `MobileToolView` to compile.

## Maintenance notes

- Plan 004 restyles `MuxPaneChrome` and the light canvas. Leave pane headers alone here so the two diffs do not fight.
- Reviewers should check token usage (no hex in TSX) and that the empty-agent hide does not unmount running-agent subscriptions incorrectly — hide in layout, do not stop `useRunningAgents`.
- Index badges are visual-only; a later change may bind `Alt-1`…`Alt-9` to Window jump on Electron only. Do not do that in this plan.
- Custom per-tab colors (the dark “alasdairmonk” chip in the screenshot) are deferred.
