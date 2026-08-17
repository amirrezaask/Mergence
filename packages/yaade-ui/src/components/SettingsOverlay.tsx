import type { YaadeTheme } from "@yaade/shared"
import {
  Bell,
  Brush,
  Monitor,
  Moon,
  RotateCcw,
  SlidersHorizontal,
  Sun,
  X,
} from "lucide-react"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button.js"
import { Checkbox } from "@/components/ui/checkbox.js"
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@/components/ui/combobox.js"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field.js"
import { Input } from "@/components/ui/input.js"
import { ScrollArea } from "@/components/ui/scroll-area.js"
import { Separator } from "@/components/ui/separator.js"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs.js"
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group.js"
import {
  siblingThemeForScheme,
  themePreviewSwatches,
} from "@/theme/bundled.js"
import { DEFAULT_MONO_FONT_NAME } from "../theme/appearance-defaults.js"
import { listSystemMonoFonts } from "../theme/system-mono-fonts.js"

/** Navigation chrome for the Session shell. */
export type SessionLayout = "tabs" | "two-sidebars" | "single-sidebar"
export type ColorSchemeMode = "system" | "light" | "dark"
export type InterfaceMaterial = "classic" | "liquid-glass"
export type JetAppearanceSettings = {
  themeId: string
  colorSchemeMode: ColorSchemeMode
  /** Chrome material treatment; content surfaces remain matte in either mode. */
  interfaceMaterial: InterfaceMaterial
  /** Disable translucency and blur while preserving material geometry. */
  reducedTransparency: boolean
  fontSize: number
  /** Primary monospace face name (CSS stack built via `buildMonoFontStack`). */
  monoFontFamily: string
  /** Session and ToolUse navigation chrome. */
  sessionLayout: SessionLayout
  /** Whether the Session/ToolUse sidebars are collapsed. */
  sidebarCollapsed: boolean
  /** Sidebar expanded width in px (clamped 240–480). */
  sidebarWidth: number
  /**
   * Project filter (`null` = All).
   * Persisted as absolute project path (stable across reloads).
   */
  sidebarProjectFilterPath: string | null
}

export type SettingsOverlayProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  themes: YaadeTheme[]
  settings: JetAppearanceSettings
  onSettingsChange: (settings: JetAppearanceSettings) => void
  onReset: () => void
  notificationPrefs?: import("@yaade/shared").NotificationPreferences | null
  onNotificationPrefsChange?: (
    patch: Partial<import("@yaade/shared").NotificationPreferences>,
  ) => void
}

function parseNumber(
  value: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number.parseFloat(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function settingPatch(
  settings: JetAppearanceSettings,
  patch: Partial<JetAppearanceSettings>,
): JetAppearanceSettings {
  return { ...settings, ...patch }
}

function colorSchemeForMode(mode: ColorSchemeMode): "light" | "dark" {
  if (mode !== "system") return mode
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light"
}

function MonoFontPicker({
  value,
  onChange,
}: {
  value: string
  onChange: (family: string) => void
}) {
  const [fonts, setFonts] = useState<string[]>([DEFAULT_MONO_FONT_NAME])

  useEffect(() => {
    let cancelled = false
    void listSystemMonoFonts().then(list => {
      if (cancelled) return
      setFonts(list)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const items = (() => {
    const set = new Set(fonts)
    const current = value.trim() || DEFAULT_MONO_FONT_NAME
    set.add(current)
    return [...set].sort((a, b) => a.localeCompare(b))
  })()

  return (
    <div data-yaade-mono-font-picker="" className="w-full min-w-0">
      <Combobox
        items={items}
        value={value.trim() || DEFAULT_MONO_FONT_NAME}
        onValueChange={next => {
          if (typeof next === "string" && next.trim()) onChange(next.trim())
        }}
        itemToStringValue={item => String(item)}
      >
        <ComboboxInput
          id="yaade-mono-font"
          placeholder="Select monospace font…"
          showClear={false}
          size="sm"
          className="w-full min-w-0"
          inputClassName="font-mono"
          aria-label="Terminal font"
        />
        <ComboboxPopup className="w-(--anchor-width)">
          <ComboboxEmpty>No monospace fonts found.</ComboboxEmpty>
          <ComboboxList>
            {(item: string) => (
              <ComboboxItem
                key={item}
                value={item}
                style={{
                  fontFamily: `"${item.replaceAll('"', '\\"')}", monospace`,
                }}
              >
                <span data-yaade-mono-font-option={item}>{item}</span>
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
    </div>
  )
}

function ThemeButton({
  theme,
  active,
  onSelect,
}: {
  theme: YaadeTheme
  active: boolean
  onSelect: () => void
}) {
  return (
    <Button
      type="button"
      variant={active ? "secondary" : "ghost"}
      data-yaade-theme-option={theme.id}
      aria-pressed={active}
      onClick={onSelect}
      className="h-auto min-h-12 w-full justify-start gap-3 px-3 py-2 text-left"
    >
      <span className="block min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-current">
          {theme.name}
        </span>
        <span className="mt-1 block font-mono text-3xs text-muted-foreground">
          {theme.scheme ?? "dark"}
        </span>
      </span>
      <span className="flex w-28 shrink-0 overflow-hidden rounded-sm border border-border">
        {themePreviewSwatches(theme)
          .slice(0, 10)
          .map((color, index) => (
            <span
              key={`${theme.id}:${index}:${color}`}
              aria-hidden
              className="h-5 flex-1"
              style={{ backgroundColor: color }}
            />
          ))}
      </span>
    </Button>
  )
}

type SettingsCategory = "appearance" | "notifications"

const SETTINGS_CATEGORIES = {
  appearance: {
    label: "Appearance",
    description: "Tune the theme and typography across the app.",
    icon: Brush,
  },
  notifications: {
    label: "Notifications",
    description: "Choose which events can interrupt you.",
    icon: Bell,
  },
} satisfies Record<
  SettingsCategory,
  { label: string; description: string; icon: typeof SlidersHorizontal }
>

function SettingsSectionHeader({ category }: { category: SettingsCategory }) {
  const item = SETTINGS_CATEGORIES[category]
  return (
    <header className="flex flex-col gap-1">
      <h2 className="text-base font-semibold tracking-tight text-foreground">
        {item.label}
      </h2>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {item.description}
      </p>
    </header>
  )
}

function useCompactSettingsNavigation(): boolean {
  const [compact, setCompact] = useState(() =>
    window.matchMedia("(max-width: 767px)").matches,
  )

  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)")
    const sync = () => setCompact(media.matches)
    media.addEventListener("change", sync)
    return () => media.removeEventListener("change", sync)
  }, [])

  return compact
}

export function SettingsOverlay({
  open,
  onOpenChange,
  themes,
  settings,
  onSettingsChange,
  onReset,
  notificationPrefs: notificationPrefsProp,
  onNotificationPrefsChange: onNotificationPrefsChangeProp,
}: SettingsOverlayProps) {
  const [localPrefs, setLocalPrefs] = useState<
    import("@yaade/shared").NotificationPreferences | null
  >(null)
  const [category, setCategory] = useState<SettingsCategory>("appearance")
  const compactNavigation = useCompactSettingsNavigation()

  useEffect(() => {
    if (!open || notificationPrefsProp) return
    const api = window.yaade?.notifications
    if (!api) return
    void api
      .getPreferences()
      .then(setLocalPrefs)
      .catch(() => {})
  }, [open, notificationPrefsProp])

  const notificationPrefs = notificationPrefsProp ?? localPrefs
  const onNotificationPrefsChange =
    onNotificationPrefsChangeProp ??
    ((patch: Partial<import("@yaade/shared").NotificationPreferences>) => {
      const api = window.yaade?.notifications
      if (!api) return
      void api.setPreferences(patch).then(setLocalPrefs)
    })

  const categories: SettingsCategory[] = ["appearance"]
  if (notificationPrefs) categories.push("notifications")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-yaade-settings-overlay=""
        showCloseButton={false}
        size="wide"
        className="h-[calc(100dvh-2rem)] gap-0 overflow-hidden border-border bg-popover p-0 text-popover-foreground sm:h-[min(44rem,calc(100dvh-2rem))] sm:max-w-[50rem]"
        style={{
          width: "min(50rem, calc(100vw - 2rem))",
          maxWidth: "min(50rem, calc(100vw - 2rem))",
        }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Configure appearance and notifications.
          </DialogDescription>
        </DialogHeader>
        <Tabs
          value={category}
          onValueChange={(value) => setCategory(value as SettingsCategory)}
          orientation={compactNavigation ? "horizontal" : "vertical"}
          className="min-h-0 flex-1 flex-col gap-0 md:flex-row"
          data-yaade-settings-tabs=""
        >
          <aside className="flex shrink-0 flex-col border-b border-border bg-muted/35 md:w-52 md:border-r md:border-b-0">
            <div className="flex h-14 items-center justify-between gap-3 px-4">
              <div className="min-w-0">
                <div className="text-sm font-semibold tracking-tight text-foreground">
                  Settings
                </div>
                <div className="text-3xs text-muted-foreground">
                  YAADE preferences
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={onReset}
                  aria-label="Reset appearance"
                  className="md:hidden"
                >
                  <RotateCcw />
                </Button>
                <DialogClose asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Close settings"
                  >
                    <X />
                  </Button>
                </DialogClose>
              </div>
            </div>
            <Separator />
            <TabsList
              variant="line"
              aria-label="Settings categories"
              className="scroll-fade-x flex h-auto w-full justify-start overflow-x-auto rounded-none p-2 md:flex-1 md:flex-col md:justify-start md:overflow-visible"
            >
              {categories.map((id) => {
                const item = SETTINGS_CATEGORIES[id]
                const Icon = item.icon
                return (
                  <TabsTrigger
                    key={id}
                    value={id}
                    data-yaade-settings-category={id}
                    className="h-9 flex-none px-3 md:w-full"
                  >
                    <Icon aria-hidden />
                    {item.label}
                  </TabsTrigger>
                )
              })}
            </TabsList>
            <div className="hidden p-3 md:block">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onReset}
                className="w-full justify-start"
              >
                <RotateCcw data-icon="inline-start" />
                Reset appearance
              </Button>
            </div>
          </aside>

          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            <TabsContent
              value="appearance"
              className="min-h-0 flex-1"
              data-yaade-settings-panel="appearance"
            >
              <ScrollArea className="size-full">
                <section className="flex flex-col gap-6 p-5 sm:p-7">
                  <SettingsSectionHeader category="appearance" />
                  <Separator />
                  <FieldGroup className="gap-0">
                    <div className="pb-3">
                      <h3 className="text-sm font-medium text-foreground">
                        Theme
                      </h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Choose a color palette.
                      </p>
                    </div>
                    <Field
                      orientation="responsive"
                      className="grid items-start gap-3 py-4 first:pt-0 last:pb-0 sm:grid-cols-[minmax(10rem,13rem)_minmax(14rem,1fr)] sm:gap-6"
                    >
                      <FieldContent className="min-w-0">
                        <FieldLabel className="text-sm font-medium leading-snug text-foreground">
                          Color mode
                        </FieldLabel>
                        <FieldDescription className="mt-1 text-xs leading-relaxed">
                          Auto follows your system's light or dark appearance.
                        </FieldDescription>
                      </FieldContent>
                      <ToggleGroup
                        type="single"
                        variant="outline"
                        size="sm"
                        value={settings.colorSchemeMode}
                        aria-label="Color mode"
                        className="w-full"
                        onValueChange={value => {
                          if (
                            value !== "system" &&
                            value !== "light" &&
                            value !== "dark"
                          ) {
                            return
                          }
                          const scheme = colorSchemeForMode(value)
                          onSettingsChange(
                            settingPatch(settings, {
                              colorSchemeMode: value,
                              themeId: siblingThemeForScheme(
                                settings.themeId,
                                scheme,
                              ).id,
                            }),
                          )
                        }}
                      >
                        <ToggleGroupItem
                          value="system"
                          aria-label="Auto color mode"
                          className="flex-1"
                          data-yaade-color-mode-option="system"
                        >
                          <Monitor aria-hidden />
                          Auto
                        </ToggleGroupItem>
                        <ToggleGroupItem
                          value="light"
                          aria-label="Light color mode"
                          className="flex-1"
                          data-yaade-color-mode-option="light"
                        >
                          <Sun aria-hidden />
                          Light
                        </ToggleGroupItem>
                        <ToggleGroupItem
                          value="dark"
                          aria-label="Dark color mode"
                          className="flex-1"
                          data-yaade-color-mode-option="dark"
                        >
                          <Moon aria-hidden />
                          Dark
                        </ToggleGroupItem>
                      </ToggleGroup>
                    </Field>
                    <Field
                      orientation="responsive"
                      className="grid items-start gap-3 py-4 first:pt-0 last:pb-0 sm:grid-cols-[minmax(10rem,13rem)_minmax(14rem,1fr)] sm:gap-6"
                    >
                      <FieldContent className="min-w-0">
                        <FieldLabel className="text-sm font-medium leading-snug text-foreground">
                          Interface material
                        </FieldLabel>
                        <FieldDescription className="mt-1 text-xs leading-relaxed">
                          Liquid glass is limited to navigation and temporary chrome.
                        </FieldDescription>
                      </FieldContent>
                      <ToggleGroup
                        type="single"
                        variant="outline"
                        size="sm"
                        value={settings.interfaceMaterial}
                        aria-label="Interface material"
                        className="w-full"
                        onValueChange={value => {
                          if (value !== "classic" && value !== "liquid-glass") return
                          onSettingsChange(
                            settingPatch(settings, { interfaceMaterial: value }),
                          )
                        }}
                      >
                        <ToggleGroupItem
                          value="classic"
                          aria-label="Classic interface material"
                          className="flex-1"
                          data-yaade-interface-material-option="classic"
                        >
                          Classic
                        </ToggleGroupItem>
                        <ToggleGroupItem
                          value="liquid-glass"
                          aria-label="Liquid glass interface material"
                          className="flex-1"
                          data-yaade-interface-material-option="liquid-glass"
                        >
                          Liquid glass
                        </ToggleGroupItem>
                      </ToggleGroup>
                    </Field>
                    <Field
                      orientation="responsive"
                      className="grid items-start gap-3 py-4 first:pt-0 last:pb-0 sm:grid-cols-[minmax(10rem,13rem)_minmax(14rem,1fr)] sm:gap-6"
                    >
                      <FieldContent className="min-w-0">
                        <FieldLabel
                          htmlFor="yaade-reduced-transparency"
                          className="text-sm font-medium leading-snug text-foreground"
                        >
                          Reduced transparency
                        </FieldLabel>
                        <FieldDescription className="mt-1 text-xs leading-relaxed">
                          Use opaque surfaces when translucency is distracting or expensive.
                        </FieldDescription>
                      </FieldContent>
                      <div className="flex justify-start sm:justify-end">
                        <Checkbox
                          id="yaade-reduced-transparency"
                          checked={settings.reducedTransparency}
                          onCheckedChange={checked =>
                            onSettingsChange(
                              settingPatch(settings, {
                                reducedTransparency: checked === true,
                              }),
                            )
                          }
                          data-yaade-reduced-transparency-toggle=""
                        />
                      </div>
                    </Field>
                    <div className="grid gap-4">
                      {Array.from(
                        themes.reduce((map, theme) => {
                          const family = theme.family ?? "Default"
                          const list = map.get(family) ?? []
                          list.push(theme)
                          map.set(family, list)
                          return map
                        }, new Map<string, typeof themes>()),
                      ).map(([family, familyThemes]) => (
                        <div key={family} className="grid gap-1.5">
                          <p className="text-3xs font-bold uppercase tracking-[0.09em] text-muted-foreground">
                            {family}
                          </p>
                          <div className="grid gap-1.5 lg:grid-cols-2">
                            {familyThemes.map(theme => (
                              <ThemeButton
                                key={theme.id}
                                theme={theme}
                                active={settings.themeId === theme.id}
                                onSelect={() =>
                                  onSettingsChange(
                                    settingPatch(settings, {
                                      themeId: theme.id,
                                      colorSchemeMode:
                                        theme.scheme ?? "dark",
                                    }),
                                  )
                                }
                              />
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </FieldGroup>
                  <Separator />
                  <FieldGroup className="divide-y divide-border gap-0">
                    <Field
                      orientation="responsive"
                      className="grid items-start gap-3 py-4 first:pt-0 last:pb-0 sm:grid-cols-[minmax(10rem,13rem)_minmax(14rem,1fr)] sm:gap-6"
                    >
                      <FieldContent className="min-w-0">
                        <FieldLabel
                          htmlFor="yaade-ui-font-size"
                          className="text-sm font-medium leading-snug text-foreground"
                        >
                          UI font size
                        </FieldLabel>
                      </FieldContent>
                      <Input
                        id="yaade-ui-font-size"
                        type="number"
                        min={10}
                        max={24}
                        step={1}
                        value={settings.fontSize}
                        onChange={(event) =>
                          onSettingsChange(
                            settingPatch(settings, {
                              fontSize: parseNumber(
                                event.target.value,
                                settings.fontSize,
                                10,
                                24,
                              ),
                            }),
                          )
                        }
                        className="h-8 font-mono"
                      />
                    </Field>
                    <Field
                      orientation="responsive"
                      className="grid items-start gap-3 py-4 first:pt-0 last:pb-0 sm:grid-cols-[minmax(10rem,13rem)_minmax(14rem,1fr)] sm:gap-6"
                    >
                      <FieldContent className="min-w-0">
                        <FieldLabel
                          htmlFor="yaade-mono-font"
                          className="text-sm font-medium leading-snug text-foreground"
                        >
                          Terminal font
                        </FieldLabel>
                        <FieldDescription className="mt-1 text-xs leading-relaxed">
                          Sets the terminal and code monospace face. Lists fonts available on this system.
                        </FieldDescription>
                      </FieldContent>
                      <MonoFontPicker
                        value={settings.monoFontFamily || DEFAULT_MONO_FONT_NAME}
                        onChange={family =>
                          onSettingsChange(
                            settingPatch(settings, { monoFontFamily: family }),
                          )
                        }
                      />
                    </Field>
                  </FieldGroup>
                </section>
              </ScrollArea>
            </TabsContent>

            {notificationPrefs ? (
              <TabsContent
                value="notifications"
                className="min-h-0 flex-1"
                data-yaade-settings-panel="notifications"
              >
                <ScrollArea className="size-full">
                  <section
                    className="flex flex-col gap-6 p-5 sm:p-7"
                    data-yaade-notification-prefs=""
                  >
                    <SettingsSectionHeader category="notifications" />
                    <Separator />
                    <FieldGroup className="divide-y divide-border gap-0">
                      {(
                        [
                          [
                            "desktopEnabled",
                            "Desktop notifications",
                            "Show native notifications outside YAADE.",
                          ],
                          [
                            "soundEnabled",
                            "Notification sounds",
                            "Allow native notifications to play a sound.",
                          ],
                          [
                            "notifyOnCompleted",
                            "Turn completed",
                            "Notify when an agent finishes its current turn.",
                          ],
                          [
                            "notifyOnInputRequired",
                            "Input required",
                            "Notify when a session is waiting for your response.",
                          ],
                          [
                            "notifyOnPermissionRequired",
                            "Permission required",
                            "Notify when a session needs approval to continue.",
                          ],
                          [
                            "notifyOnFailure",
                            "Failures",
                            "Notify when a session fails.",
                          ],
                          [
                            "includeBackgroundOutput",
                            "Background terminal output",
                            "Include output produced by terminals that are not focused.",
                          ],
                        ] as const
                      ).map(([key, label, detail]) => {
                        const id = `yaade-notification-${key}`
                        const disabled =
                          key === "soundEnabled" &&
                          !notificationPrefs.desktopEnabled
                        return (
                          <Field
                            key={key}
                            orientation="responsive"
                            className="grid items-start gap-3 py-4 first:pt-0 last:pb-0 sm:grid-cols-[minmax(10rem,13rem)_minmax(14rem,1fr)] sm:gap-6"
                          >
                            <FieldContent className="min-w-0">
                              <FieldLabel
                                htmlFor={id}
                                className="text-sm font-medium leading-snug text-foreground"
                              >
                                {label}
                              </FieldLabel>
                              <FieldDescription className="mt-1 text-xs leading-relaxed">
                                {detail}
                              </FieldDescription>
                            </FieldContent>
                            <div className="flex justify-start sm:justify-end">
                              <Checkbox
                                id={id}
                                checked={Boolean(notificationPrefs[key])}
                                disabled={disabled}
                                data-yaade-notification-pref={key}
                                onCheckedChange={(checked) =>
                                  onNotificationPrefsChange({
                                    [key]: checked === true,
                                  })
                                }
                              />
                            </div>
                          </Field>
                        )
                      })}
                    </FieldGroup>
                  </section>
                </ScrollArea>
              </TabsContent>
            ) : null}
          </main>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
