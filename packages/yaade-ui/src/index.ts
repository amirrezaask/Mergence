export { PanelDock, type PanelDockProps, type PanelSlotMeta } from "./dock/PanelDock.js"
export { TabDndRoot, type TabDndHandlers, useDropHot } from "./dock/TabDndRoot.js"
export {
  AgentActivityList,
  type AgentActivityListProps,
} from "./home/AgentActivityList.js"
export {
  PanelFloatingPopover,
  type PanelFloatingPopoverProps,
  type PanelFloatCorner,
} from "./dock/PanelFloatingPopover.js"
export { PanelBody } from "./dock/PanelBody.js"
export { PanelTabBar, tabIdsOf, type PanelTab } from "./dock/PanelTabBar.js"
export {
  SessionPaneChrome,
  type SessionPaneChromeProps,
} from "./dock/SessionPaneChrome.js"
export { TabHost } from "./tabs/TabHost.js"
export {
  TabStore,
  TabTypeRegistry,
  type TabInstance,
  type TabType,
  type TabRenderCtx,
} from "./tabs/registry.js"
export { AppShell } from "./shell/AppShell.js"
export {
  InstanceSidebar,
  type InstanceSidebarItem,
  type InstanceSidebarProps,
} from "./shell/InstanceSidebar.js"
export {
  TerminalSessionModal,
  formatSessionHeaderTitle,
  SessionTerminalWorkspace,
  SessionTerminalTabBar,
  SessionModeDock,
  SessionHeaderChromeProvider,
  SessionHeaderChromePortal,
  sessionHeaderContextRef,
  TERMINAL_MODAL_SESSION_LIST_ID,
  ModalEditorPane,
  ModalEditorTabBar,
  NewSessionButton,
  OpenInAppMenu,
  OPEN_IN_APP_TARGETS,
  AgentCliPickerOverlay,
  AGENT_CLI_DRIVERS,
  detectSessionProvider,
  GharagahSidebar,
  sidebarWidthStyle,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_DEFAULT,
  mapHomeGroupsToSidebar,
  type HomeProjectGroup,
  type HomeTerminalEntry,
  type SessionDialogMode,
  type ModalEditorBuffer,
  type ModalEditorPaneProps,
  type ModalEditorTabBarProps,
  type TerminalSessionModalProps,
  type SessionTerminalItem,
  type SessionTerminalWorkspaceProps,
  type SessionTerminalTabBarProps,
  type SessionModeDockProps,
  type AgentSessionHeaderMeta,
  type SessionCardModel,
  type SessionCardStatus,
  type OpenInAppId,
  type OpenInAppMenuProps,
  type OpenInAppTarget,
  type NewSessionButtonProps,
  type AgentCliDriver,
  type AgentCliLaunchSelection,
  type AgentCliPickerOverlayProps,
  type AgentCliPickerProject,
  type ProjectTodo,
  type ProjectTodoStatus,
  type ProjectTodosApi,
  type ProjectTodosRepository,
  ProjectTodosPane,
  NotificationBell,
  NotificationCenter,
  type NotificationBellProps,
  type NotificationCenterProps,
  type GharagahSidebarProps,
  type SidebarProject,
  type SidebarSession,
  type SessionSidebarActions,
  type ProjectSidebarActions,
} from "./home/index.js"
export { SidebarProvider, SidebarInset, SidebarTrigger } from "./components/ui/sidebar.js"
export {
  YaadeWorkspaceSidebar,
  JetSidebarViewTabs,
  type JetSidebarView,
  type YaadeWorkspaceSidebarProps,
} from "./shell/YaadeWorkspaceSidebar.js"
export { focusExplorerPanel } from "./explorer/focus.js"
export { focusTerminalExplorerPanel } from "./terminal-explorer/focus.js"
export { CommandPalette } from "./components/CommandPalette.js"
export { PaletteShell, type PaletteShellItem, type PaletteShellProps } from "./components/palette/PaletteShell.js"
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
export { OutlineOverlay, type OutlineEntry } from "./components/OutlineOverlay.js"
export { QuickOpenOverlay, type QuickOpenWorkspace } from "./components/QuickOpenOverlay.js"
export { BufferListOverlay } from "./components/BufferListOverlay.js"
export { TerminalListOverlay, type TerminalListEntry } from "./components/TerminalListOverlay.js"
export {
  LocationList,
  SearchLocationList,
  ReferencesLocationList,
  DefinitionsLocationList,
  DiagnosticsLocationList,
  TaskErrorsLocationList,
  problemsToListItems,
  searchHitToListItem,
  taskErrorsToListItems,
  lspLocationToListItem,
  lspLocationsToListItems,
  type LocationListProps,
  type LocationListTabProps,
} from "./panels/location-list/index.js"
export { CdOverlay } from "./components/CdOverlay.js"
export { ProjectSwitcherOverlay } from "./components/ProjectSwitcherOverlay.js"
export { PaletteOverlay } from "./components/PaletteOverlay.js"
export {
  SettingsOverlay,
  type ColorSchemeMode,
  type JetAppearanceSettings,
  type PreferredEditor,
  type SessionLayout,
} from "./components/SettingsOverlay.js"
export {
  DEFAULT_UI_FONT_FAMILY,
  DEFAULT_MONO_FONT_FAMILY,
  DEFAULT_MONO_FONT_NAME,
  buildMonoFontStack,
  CURATED_MONO_FONT_NAMES,
} from "./theme/appearance-defaults.js"
export { listSystemMonoFonts, isMonospaceFontFamily } from "./theme/system-mono-fonts.js"
export { StatusBar } from "./status/StatusBar.js"
export { WhichKeyPanel, type WhichKeyEntry } from "./components/WhichKeyPanel.js"
export { setEditorCursor as setEditorCursorStore, getEditorCursor as getEditorCursorStore, subscribeEditorCursor } from "./status/editor-cursor-store.js"
export {
  getEditorView,
  getEditorCursor,
  setEditorCursor,
  destroyEditorBuffer,
  destroyEditorPanel,
  type EditorViewHandle,
} from "./tabs/editor-view-registry.js"
export {
  ExplorerTab,
  type ExplorerSelection,
} from "./tabs/ExplorerTab.js"
export {
  TerminalExplorerTab,
  type TerminalAgentShortcut,
  type TerminalExplorerGroup,
  type TerminalExplorerEntry,
} from "./tabs/TerminalExplorerTab.js"
export { OutputPanel } from "./panels/OutputPanel.js"
export { showEditorContextMenuAt } from "./components/EditorContextMenu.js"
export { createContextMenuHost, dispatchContextMenuAt } from "./components/ContextMenuHost.js"
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
export { yaadeMotion, yaadeOverlayContentClass, yaadePopoverContentClass, yaadeMenuContentClass, yaadePressClass, yaadeInteractiveRowClass, type YaadeOverlayMotion } from "./motion/tokens.js"
export { useReducedMotion } from "./motion/useReducedMotion.js"
export { YaadeTabDragGhost } from "./motion/YaadeOverlayMotion.js"
export {
  animateLayoutMorph,
  capturePanelLeafRects,
  type LayoutMorphOptions,
  type PanelRect,
} from "./motion/layoutMorph.js"
export { cn } from "./lib/utils.js"
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
export { registerListPanel, getListPanel, getListItems, focusListPanel, focusFirstListItem, getListPanelController, type ListFocusAction, type ListPanelController } from "./lib/list-registry.js"
export { ListRow, type ListRowProps } from "./components/ListRow.js"
export { PanelEmpty } from "./components/PanelEmpty.js"
export { SettingsField } from "./components/SettingsField.js"
export {
  MuxTabStrip,
  MuxPaneChrome,
  MuxEmptyState,
  MuxStatusStrip,
  processIdentity,
  deckTileStyle,
  formatMuxTitle,
  type MuxTabItem,
  type MuxTabStripProps,
  type MuxPaneChromeProps,
  type MuxEmptyActionId,
  type MuxEmptyStateProps,
  type MuxStatusStripAction,
  type MuxStatusStripProps,
  type ProcessIdentity,
  type TabOrientation,
} from "./mux/index.js"
