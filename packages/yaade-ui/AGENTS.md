# @yaade/ui — Design System

Unified UI primitives + shells for every YAADE surface. Shadcn-derived, semantic tokens, single motion + typography scale.

## Public surface

- `@yaade/ui` — high-level shells (overlays, dialogs, panels, tabs, editor host).
- `@yaade/ui/primitives` — shadcn primitives. Live chrome is composed from `Button`, `Card`, `Item`, `Badge`, `Tabs`, `Dialog`, `Popover`, `Command`, `Input`, `Checkbox`, `Empty`, `Skeleton`, `Alert`, `Separator`, `Tooltip`, and `Sonner`.
- `@yaade/ui/styles.css` — theme tokens + globals.

**Apps must never import shadcn primitives from `@yaade/ui/src/components/ui/*` directly.** Import from `@yaade/ui/primitives`.

## Design tokens

The required `YaadeTheme.tokens: YaadeSemanticTokens` object is the authored color source. `applySemanticTokens()` publishes it to CSS before React mounts; `globals.css` maps those properties through Tailwind's `@theme inline`. `JetColors` is an sRGB compatibility view derived for canvas/editor consumers and must not be authored independently.

### Color
Semantic: shadcn roles plus `success`, `warning`, `info`, `backdrop`, Git added/modified/deleted/conflict foreground pairs, and `sidebar-*`. Never hardcode palette colors outside token/theme files. Exact provider-brand and language-file-icon colors are the documented exceptions.

### Radius
`--radius: 0.5rem` (8px at default zoom). Use `rounded-md` for controls and compact surfaces; reserve full pills for badges.

### Typography
Scale (rem, ~px):
- `text-4xs` — 0.69rem (~9px at the 13px default; badge-only)
- `text-3xs` — 0.77rem (~10px)
- `text-2xs` — 0.82rem (~11px)
- `text-xs` — 0.88rem (~11.5px)
- `text-sm` — 0.95rem (~12.5px)
- `text-base` — 1rem (~16px)
- `text-lg` — 1.15rem (~18px)
- `text-xl` — 1.85rem (~30px)

Never write `text-[Npx]`. If a size is missing from the scale, add a token — don't inline.

Fonts: `--font-sans` Geist, `--font-mono` Geist Mono.

### Motion
`yaadeMotion` (from `@yaade/ui`) is the single source of animation timings: 100ms interaction, 160ms menus, and 200ms panels. CSS vars: `--yaade-motion-fast/hot/menu/overlay/panel/slow-menu/scroll/entity`; easing vars: `--yaade-ease-out/in-out/drawer`. Never hardcode durations; reference the token. Press feedback is the restrained global `0.98` scale.

High-frequency palette surfaces use `<DialogContent motion="instant" placement="quick-input" size="picker" />`. Standard prompts and dialogs use the menu/panel motion tokens. Dialog sizes are semantic: `prompt` (24rem), `picker` (32rem), `wide` (42rem), and `default`; PaletteShell applies VS Code-like quick-input minimums (`picker` 44rem, `wide` 52rem) with viewport caps.

Reduced motion is handled globally by `data-yaade-reduced-motion` and `prefers-reduced-motion` in `globals.css`.

### Icons
Only `lucide-react`. Default size class: `size-4`. Do not import other icon libraries.

## Shells

### Overlay palettes → `PaletteShell<T>`

Location: `src/components/palette/PaletteShell.tsx`.

PaletteShell uses shared VS Code-like quick-input chrome: top-docked placement, no backdrop dim/blur, an inset focused search field, dense square selection rows, and a compact floating shadow. `CdOverlay` uses the same chrome while retaining its bespoke path completion controls.

List engine: **`Lister`** (`src/lister/`) — flat/tree virt list, fuzzy filter, search input. `showInput` = initial visibility only; typing always reveals the field while query non-empty. PaletteShell = Dialog chrome + Lister (`showInput`, `flatVariant="palette"`). Explorer / LocationList use same Lister (`showInput={false}` until type).

All "Dialog + list + input + result" palettes MUST use PaletteShell. Adapters:
- `CommandPalette`
- `BufferListOverlay`
- `OutlineOverlay`
- `QuickOpenOverlay`
- `ProjectSwitcherOverlay`

Exceptions (bespoke): `CdOverlay` — carries interactive path input, ghost autocomplete, footer hint bar, top-right primary button, and file/dir mode. All file/folder open flows (openFile, openFolder, cd, addWorkspace, switchFolder, folderPicker) route through it.

#### Adding a new palette

```tsx
import { PaletteShell, type PaletteShellItem } from "@yaade/ui"

const items: PaletteShellItem<MyItem>[] = data.map(x => ({
  key: x.id,
  value: `${x.name} ${x.hint}`,
  data: x,
}))

<PaletteShell
  open={open}
  onOpenChange={onOpenChange}
  title="My palette"
  description="Search my things…"
  placeholder="Filter…"
  size="picker"              // picker | wide; grows with fitContent (default)
  fitContent                 // measure longest item → dialog width (viewport-capped)
  contentWidthMono           // file-path rows (QuickOpen)
  items={items}
  onSelect={item => run(item)}
  emptyLabel="No matches."
  renderItem={item => <span>{item.name}</span>}
/>
```

Preferred width helpers (`measureLongestItemContentWidth`, `PALETTE_LISTER_CHROME_PX`) live in `@yaade/ui` / `lister/measure` so hosts can size chrome without guessing. Lister fires `onContentWidthChange` for the current visible rows.

Async? Provide `query` + `onQueryChange` + `shouldFilter={false}` + optional `statusRow`.

### Modal input → `PromptDialog`

Single-input modal (line jump, rename, etc.). `GotoLineModal` is an adapter.

### Confirm → `requestConfirm()` + `<ConfirmDialogHost/>`

Only path for destructive confirms. Never `window.confirm`.

### Popovers

- Panel-anchored floating: `PanelFloatingPopover` (used by `FindReplacePopover`).
- Anchored menu (button-attached): shadcn `Popover` from `@yaade/ui/primitives`.

### Context menus

`createContextMenuHost()` + `dispatchContextMenuAt()` from `@yaade/ui`. Used by `EditorContextMenu` (via `registerEditorContextMenuHandler` / `showEditorContextMenuAt`).

## Surface composition

Use full shadcn `Card` anatomy for grouped surfaces and `Item`/`ItemGroup` for compact data rows. Background, card, and sidebar layers stay flat; shadows belong only to floating popovers and dialogs. The removed `Surface`, `Text`, `SectionLabel`, and liquid-glass abstractions must not be reintroduced.

## Rules

1. Never import shadcn primitives outside `@yaade/ui`. Use `@yaade/ui/primitives`.
2. Never inline color hex or arbitrary Tailwind color values (`bg-[#...]`, `text-[#...]`). Add semantic token in `globals.css` if missing.
3. Never inline `text-[Npx]`. Extend `--yaade-fs-*` scale + `@theme inline` mapping instead.
4. Never hardcode animation duration ms. Use `yaadeMotion` or `--yaade-motion-*`.
5. Palettes use `PaletteShell`, prompts use `PromptDialog`, confirms use `requestConfirm`. Bespoke only with justification.
6. Icons come from `lucide-react`. No other icon libraries.

## Sequencing when adding new surfaces

1. Reach for `@yaade/ui/primitives` first.
2. If a pattern already has a shell (`PaletteShell`, `PromptDialog`, `ConfirmDialogHost`, `PanelFloatingPopover`), use it.
3. If none fits, add the surface locally BUT extract a shell to `@yaade/ui` before the second usage lands.
