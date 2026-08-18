export {
  PanelDock,
  PanelDockInDnd,
  type PanelDockInDndProps,
  type PanelDockProps,
  type PanelSlotMeta,
} from "./dock/PanelDock.js"
export { TabDndRoot, type TabDndHandlers, useDropHot } from "./dock/TabDndRoot.js"
export {
  DockTabBarDropTarget,
  DockTabHandle,
  type DockTabBarDropTargetProps,
  type DockTabHandleProps,
} from "./dock/DockTabHandle.js"
export { DockSourceHandle, type DockSourceHandleProps } from "./dock/DockSourceHandle.js"
export {
  PanelFloatingPopover,
  type PanelFloatingPopoverProps,
  type PanelFloatCorner,
} from "./dock/PanelFloatingPopover.js"
export { AppShell } from "./shell/AppShell.js"
export {
  InstanceSidebar,
  type InstanceSidebarItem,
  type InstanceSidebarProps,
} from "./shell/InstanceSidebar.js"
export {
  ProjectSidebar,
  type ProjectSidebarProject,
  type ProjectSidebarProps,
} from "./shell/ProjectSidebar.js"
export { SidebarShell, type SidebarShellProps } from "./shell/SidebarShell.js"
export { useIsMobile } from "./hooks/use-mobile.js"
export {
  ProjectWorkspaceSidebar,
  type ProjectWorkspaceSidebarProcess,
  type ProjectWorkspaceSidebarProps,
  type ProjectWorkspaceSidebarSearch,
  type ProjectWorkspaceSidebarView,
  type ProjectWorkspaceSidebarWorktree,
} from "./shell/ProjectWorkspaceSidebar.js"
export {
  ModalEditorTabBar,
  SessionHeaderChromeProvider,
  SessionHeaderChromePortal,
  sessionHeaderContextRef,
  AGENT_CLI_DRIVERS,
  agentCliDriverById,
  AgentProviderIcon,
  AgentCliPickerOverlay,
  type AgentCliDriver,
  type AgentCliLaunchSelection,
  type AgentCliPickerOverlayProps,
  type AgentCliPickerProject,
  type ModalEditorBuffer,
  type ModalEditorTabBarProps,
} from "./home/index.js"
export { SidebarProvider, SidebarInset, SidebarTrigger } from "./components/ui/sidebar.js"
export { focusExplorerPanel } from "./explorer/focus.js"
export { CommandPalette } from "./components/CommandPalette.js"
export {
  PaletteShell,
  type PaletteShellItem,
  type PaletteShellProps,
} from "./components/palette/PaletteShell.js"
export {
  Lister,
  fuzzyFilter,
  fuzzyScore,
  PALETTE_LISTER_CHROME_PX,
  measureLongestItemContentWidth,
  measureTextWidthPx,
  readListerLabelFont,
  readPaletteRowHeight,
  readPaletteSizeMinWidthPx,
  type ListerDataSource,
  type ListerFilterMode,
  type ListerItemContext,
  type ListerNode,
  type ListerNodeId,
  type ListerProps,
  type ListerLabelFontOptions,
  type MeasureLongestItemOptions,
  type PaletteRowLayout,
} from "./lister/index.js"
export { GotoLineModal } from "./components/GotoLineModal.js"
export { QuickOpenOverlay, type QuickOpenWorkspace } from "./components/QuickOpenOverlay.js"
export { BufferListOverlay } from "./components/BufferListOverlay.js"
export {
  LocationList,
  ReferencesLocationList,
  DefinitionsLocationList,
  DiagnosticsLocationList,
  problemsToListItems,
  searchHitToListItem,
  taskErrorsToListItems,
  lspLocationToListItem,
  lspLocationsToListItems,
  type LocationListProps,
  type LocationListTabProps,
} from "./panels/location-list/index.js"
export { ExplorerTab, type ExplorerSelection } from "./tabs/ExplorerTab.js"
export {
  PierreWorkspaceFileTree,
  type PierreWorkspaceFileTreeProps,
} from "./tabs/PierreWorkspaceFileTree.js"
export { CdOverlay } from "./components/CdOverlay.js"
export { ProjectSwitcherOverlay } from "./components/ProjectSwitcherOverlay.js"
export {
  SettingsOverlay,
  type ColorSchemeMode,
  type JetAppearanceSettings,
  type SessionLayout,
} from "./components/SettingsOverlay.js"
export {
  DEFAULT_UI_FONT_FAMILY,
  DEFAULT_MONO_FONT_FAMILY,
  DEFAULT_MONO_FONT_NAME,
  NERD_FONT_FAMILY,
  buildMonoFontStack,
  preloadNerdFont,
  CURATED_MONO_FONT_NAMES,
} from "./theme/appearance-defaults.js"
export { listSystemMonoFonts, isMonospaceFontFamily } from "./theme/system-mono-fonts.js"
export {
  WhichKeyPanel,
  type WhichKeyEntry,
  type WhichKeyGroup,
} from "./components/WhichKeyPanel.js"
export { KeyBindingKbd } from "./components/KeyBindingKbd.js"
export { PromptDialog, type PromptDialogProps } from "./components/PromptDialog.js"
export {
  bundledThemes,
  bundledThemeList,
  defaultDark,
  defaultLight,
  defaultThemeId,
  defaultThemeIdForScheme,
  getThemeById,
  siblingThemeForScheme,
  themeFamilyForId,
  themePreviewSwatches,
  themeForScheme,
  type ColorScheme,
} from "./theme/bundled.js"
export { defaultYaadeTheme, applyYaadeThemeCss, applyColorScheme } from "@yaade/shared"
export {
  yaadeMotion,
  yaadeOverlayContentClass,
  yaadePopoverContentClass,
  yaadeMenuContentClass,
  yaadePressClass,
  yaadeInteractiveRowClass,
  type YaadeOverlayMotion,
} from "./motion/tokens.js"
export { useReducedMotion } from "./motion/useReducedMotion.js"
export { YaadeTabDragGhost } from "./motion/YaadeOverlayMotion.js"
export {
  animateLayoutMorph,
  capturePanelLeafRects,
  type LayoutMorphOptions,
  type PanelRect,
} from "./motion/layoutMorph.js"
export { cn } from "./lib/utils.js"
export { GlassMaterialGallery } from "./components/GlassMaterialGallery.js"
export {
  AmbientCanvas,
  GlassControlGroup,
  GlassDivider,
  GlassFocusRing,
  GlassSurface,
  type AmbientCanvasProps,
  type GlassControlGroupProps,
  type GlassDividerProps,
  type GlassFocusRingProps,
  type GlassMaterial,
  type GlassSurfaceProps,
} from "./components/glass.js"
export { formatKeyBinding } from "./lib/format-key.js"
export { TooltipProvider } from "./components/ui/tooltip.js"
export { MessageScroller } from "./components/ui/message-scroller.js"
export { Toaster } from "./components/ui/sonner.js"
export {
  ConfirmDialogHost,
  requestConfirm,
  requestSaveDiscard,
  type SaveDiscardDecision,
  type SaveDiscardOptions,
} from "./components/ConfirmDialogHost.js"
export { showYaadeToast } from "./toast.js"
export {
  registerListPanel,
  getListPanel,
  getListItems,
  focusListPanel,
  focusFirstListItem,
  getListPanelController,
  type ListFocusAction,
  type ListPanelController,
} from "./lib/list-registry.js"
export { ListRow, type ListRowProps } from "./components/ListRow.js"
export { PanelEmpty } from "./components/PanelEmpty.js"
export {
  MuxPaneChrome,
  MuxEmptyState,
  processIdentity,
  deckTileStyle,
  formatMuxTitle,
  type MuxPaneChromeProps,
  type MuxEmptyActionId,
  type MuxEmptyStateProps,
  type ProcessIdentity,
  type TabOrientation,
} from "./mux/index.js"
export {
  NotificationCenter,
  NotificationItem,
  groupNotificationsByTime,
  formatRelativeTime,
  type NotificationCenterProps,
  type NotificationItemProps,
} from "./notifications/index.js"
