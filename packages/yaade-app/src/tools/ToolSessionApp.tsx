import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  lazy,
  type ComponentType,
} from "react";
import {
  AnimatePresence,
  LayoutGroup,
  LazyMotion,
  MotionConfig,
} from "motion/react";
import { aside as MotionAside, div as MotionDiv } from "motion/react-m";
import type {
  CheckoutTarget,
  CreateToolUse,
  ProjectTarget,
  SessionId,
  SessionTab,
  SessionTabId,
  ToolKind,
  ToolUse,
  ToolUseId,
  ToolUseInput,
} from "@yaade/rpc";
import { MainCheckout, SessionTabConflict } from "@yaade/rpc";
import type { PanelId, YaadeTheme } from "@yaade/shared";
import type { PanelEvent } from "@yaade/panels";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Spinner,
  TooltipProvider,
} from "@yaade/ui/primitives";
import {
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  FolderPlus,
  Settings,
} from "lucide-react";
import {
  AmbientCanvas,
  RunningAgentsSidebar,
  WhichKeyPanel,
  cn,
  useIsMobile,
  yaadeMotion,
  type RunningAgentSidebarItem,
  type TabDndHandlers,
} from "@yaade/ui/session";
import { focusRegisteredTerminal } from "@yaade/ui/terminal-registry";
import { CHORD_TIMEOUT_MS, isPathUnderRoot } from "@yaade/workspace";
import { bundledThemeList } from "@yaade/ui/appearance";
import { toolRegistry } from "./tool-registry.js";
import {
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  useAppearanceSettings,
} from "../hooks/useAppearanceSettings.js";
import {
  toRunningAgentSidebarItems,
  useRunningAgents,
} from "../hooks/useRunningAgents.js";
import { createToolClient, type ToolClient } from "./tool-client.js";
import {
  chooseSession,
  chooseTab,
  chooseToolUse,
  isLiveSessionTab,
  persistToolSessionRoute,
  parseToolSessionRoute,
  resolveToolSessionRoute,
  toolSessionUrl,
} from "./tool-session-routing.js";
import type { ToolContextSelection } from "./ToolContextControls.js";
import { SessionTabStrip } from "./SessionTabStrip.js";
import {
  SessionWindowTabStrip,
  type WindowTabMeta,
} from "./SessionWindowTabStrip.js";
import { SessionSwitcher } from "./SessionSwitcher.js";
import { ShortcutTooltip } from "./ShortcutTooltip.js";
import { ToolUseTabStrip } from "./ToolUseTabStrip.js";
import { SidebarResizeHandle } from "./SidebarResizeHandle.js";
import { nextRuntimeToolTitle, type RuntimeToolTitle } from "./tool-title.js";
import { SessionBootState } from "./SessionEmptyState.js";
import {
  MAX_TOOL_TILES,
  closeToolPanel,
  createToolWorkspace,
  dockToolView,
  focusToolPanel,
  openToolView,
  openToolViewInPanel,
  removeMissingToolViews,
  reorderToolTabs,
  resizeToolSplit,
  restoreToolWorkspace,
  serializeToolWorkspace,
  splitToolPanel,
  toggleToolPanelZoom,
  toolIdsInWorkspace,
  toolPaneCount,
  type ToolWorkspace,
} from "./tool-tiling.js";
import {
  toolSessionDirectShortcutFor,
  toolSessionShortcutFor,
} from "./tool-session-keymap.js";
import {
  TOOL_SESSION_PREFIX,
  TOOL_SESSION_PREFIX_GROUPS,
  clearToolSessionKeymapState,
  createToolSessionKeymapState,
  isToolSessionJumpKey,
  matchToolSessionPrefixBinding,
  resolveToolSessionKeydown,
  toolSessionHudBindings,
  type ToolSessionKeydownContext,
  type ToolSessionCommand,
} from "../keybindings.js";

const SettingsOverlay = lazy(() => import("@yaade/ui/settings"));
const ToolUseSwitcher = lazy(() =>
  import("./ToolUseSwitcher.js").then(({ ToolUseSwitcher: View }) => ({
    default: View,
  })),
);
const MobileToolView = lazy(() =>
  import("./MobileToolView.js").then(({ MobileToolView: View }) => ({
    default: View,
  })),
);
const ToolDndRoot = lazy(() => import("./ToolDndRoot.js"));
const ToolTilingWorkspace = lazy(() => import("./ToolTilingWorkspace.js"));
const loadMotionFeatures = () => import("motion/react").then(({ domMax }) => domMax);
const EMPTY_TOOL_USE_IDS: readonly ToolUseId[] = [];

type ToolSessionHistoryState = { readonly yaadeMobileTool?: string } | null

function writeToolSessionLocation(
  url: string,
  mode: "push" | "replace",
  state: ToolSessionHistoryState = null,
): void {
  persistToolSessionRoute(url, localStorage)
  if (mode === "push") history.pushState(state, "", url)
  else history.replaceState(state, "", url)
}
const EMPTY_TAB_IDS: readonly SessionTabId[] = [];
const AGENT_SIDEBAR_DEFAULT_WIDTH = 256;
const AGENT_SIDEBAR_MIN_WIDTH = 220;
const AGENT_SIDEBAR_MAX_WIDTH = 420;

type CloseChoice = { readonly sessionId: SessionId } | undefined;

type ProjectCandidate = {
  readonly useId: ToolUseId;
  readonly path: string;
};

type ToolOpenTarget = {
  readonly sessionId: SessionId;
  readonly tabId: SessionTabId;
  readonly panelId: PanelId;
};

function PrefixHud(props: {
  readonly showSidebarToggle: boolean;
  readonly onSelect: (key: string) => void;
}) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-2 z-20 flex justify-center px-2">
      <div className="pointer-events-auto w-full max-w-4xl">
        <WhichKeyPanel
          variant="overlay"
          prefix={TOOL_SESSION_PREFIX}
          groups={TOOL_SESSION_PREFIX_GROUPS}
          entries={toolSessionHudBindings()
            .filter(
              (binding) =>
                props.showSidebarToggle || binding.command !== "sidebar.toggle",
            )
            .map((binding) => ({
              key: binding.key,
              desc: binding.desc,
              group: binding.group,
            }))}
          onSelect={props.onSelect}
        />
      </div>
    </div>
  );
}

function isLive(use: ToolUse): boolean {
  return (
    use.status === "created" ||
    use.status === "starting" ||
    use.status === "running" ||
    use.status === "waiting"
  );
}

function processNameForWindowTab(
  use: ToolUse,
  runtimeTitle?: RuntimeToolTitle,
): string {
  if (use.kind === "git") return "git";
  const raw = runtimeTitle?.title?.trim() ?? "";
  const token = raw.split(/[\s/\\·]+/).find(part => part.length > 0);
  return token ?? "terminal";
}

function windowTabMetaForTabs(
  tabs: readonly SessionTab[],
  workspaces: ReadonlyMap<SessionTabId, ReturnType<typeof createToolWorkspace>>,
  usesById: ReadonlyMap<ToolUseId, ToolUse>,
  runtimeTitles: ReadonlyMap<ToolUseId, RuntimeToolTitle>,
  agentProvidersByToolUseId: ReadonlyMap<string, string>,
  useIdsByTab: ReadonlyMap<SessionTabId, readonly ToolUseId[]>,
): ReadonlyMap<SessionTabId, WindowTabMeta> {
  const meta = new Map<SessionTabId, WindowTabMeta>();
  for (const tab of tabs) {
    const ids = useIdsByTab.get(tab.id) ?? EMPTY_TOOL_USE_IDS;
    const workspace =
      workspaces.get(tab.id) ?? restoreToolWorkspace(tab.layoutJson, ids);
    const view = workspace.tree.getView(workspace.focusedPanelId);
    const use = view?.kind === "tool" ? usesById.get(view.toolUseId) : undefined;
    if (!use) {
      meta.set(tab.id, { kind: "terminal", agentProvider: "terminal" });
      continue;
    }
    meta.set(tab.id, {
      kind: use.kind,
      processName: processNameForWindowTab(use, runtimeTitles.get(use.id)),
      agentProvider:
        use.kind === "terminal"
          ? agentProvidersByToolUseId.get(use.id) ?? "terminal"
          : undefined,
    });
  }
  return meta;
}

function isKnownProjectPath(
  candidatePath: string,
  projects: readonly ProjectTarget[],
): boolean {
  return projects.some((project) =>
    isPathUnderRoot(candidatePath, project.projectPath),
  );
}

function firstEmptyToolPanel(workspace: ToolWorkspace): PanelId | undefined {
  let emptyPanel: PanelId | undefined;
  workspace.tree.visitLeaves(leaf => {
    if (!emptyPanel && leaf.view.kind === "empty") {
      emptyPanel = leaf.panelId;
    }
  });
  return emptyPanel;
}

function errorMessage<T>(error: T): string {
  return error instanceof Error
    ? error.message
    : "The host could not complete that action.";
}

function markPerformance(name: string): void {
  try {
    const start = `${name}:start`;
    const end = `${name}:end`;
    performance.clearMarks(start);
    performance.clearMarks(end);
    performance.clearMeasures(name);
    performance.mark(start);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        performance.mark(end);
        try {
          performance.measure(name, start, end);
        } catch {
          /* ignore */
        }
      });
    });
  } catch {
    /* ignore unsupported environments */
  }
}

export function ToolSessionApp() {
  const {
    activeTheme,
    appearanceSettings,
    fontSize,
    resetAppearanceSettings,
    setAppearanceSettings,
  } = useAppearanceSettings();
  const [client] = useState<ToolClient>(() => createToolClient());
  const snapshot = useSyncExternalStore(
    client.store.subscribe,
    client.store.getSnapshot,
    client.store.getSnapshot,
  );
  const [projects, setProjects] = useState<readonly ProjectTarget[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [projectCandidate, setProjectCandidate] =
    useState<ProjectCandidate | null>(null);
  const [addingProjectPath, setAddingProjectPath] = useState<string | null>(
    null,
  );
  const [closeChoice, setCloseChoice] = useState<CloseChoice>();
  const [actionError, setActionError] = useState<string | undefined>();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [toolUseSwitcherOpen, setToolUseSwitcherOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paneChromeOverlayOpen, setPaneChromeOverlayOpen] = useState(false);
  const [agentSidebarWidth, setAgentSidebarWidth] = useState(
    AGENT_SIDEBAR_DEFAULT_WIDTH,
  );
  const [routeRevision, setRouteRevision] = useState(0);
  const [toolWorkspaces, setToolWorkspaces] = useState<
    ReadonlyMap<SessionTabId, ToolWorkspace>
  >(() => new Map());
  const [prefixPending, setPrefixPending] = useState(false);
  const [runtimeTitles, setRuntimeTitles] = useState<
    ReadonlyMap<ToolUseId, RuntimeToolTitle>
  >(() => new Map());
  const layoutSaveTails = useRef(new Map<SessionTabId, Promise<void>>());
  const layoutServerStateRef = useRef(
    new Map<SessionTabId, { revision: number; layoutJson?: string }>(),
  );
  const dismissedProjectCandidatesRef = useRef(new Set<string>());
  const keymapStateRef = useRef(createToolSessionKeymapState());
  const prefixTimerRef = useRef<number | undefined>(undefined);
  const pendingToolPanelRequestsRef = useRef(new Set<string>());
  const closingTabIdsRef = useRef(new Set<SessionTabId>());
  const toolUsesRef = useRef(snapshot.usesById);
  const focusedToolUseRef = useRef<ToolUse | undefined>(undefined);
  const overlayWasOpenRef = useRef(false);
  const isMobile = useIsMobile();
  const desktopPlatform = window.yaadeDesktop?.platform;
  toolUsesRef.current = snapshot.usesById;

  useEffect(() => {
    client.start();
    void client.hydrate().catch(() => undefined);
    return () => client.dispose();
  }, [client]);

  useEffect(() => {
    void window.yaade?.tools
      ?.listProjects?.()
      .then((next) => {
        setProjects(next);
        setProjectsLoaded(true);
      })
      .catch(() => undefined);
  }, []);

  const addKnownProject = useCallback(async (rootPath: string) => {
    try {
      const addProject = window.yaade?.tools?.addProject;
      if (!addProject) throw new Error("Project management is unavailable.");
      const project = await addProject(rootPath);
      setProjects((previous) => [
        project,
        ...previous.filter((item) => item.projectId !== project.projectId),
      ]);
      setProjectsLoaded(true);
      setActionError(undefined);
      return project;
    } catch (error) {
      setActionError(errorMessage(error));
      return undefined;
    }
  }, []);

  const observeTerminalCwd = useCallback(
    (useId: ToolUseId, cwdPath: string) => {
      if (!projectsLoaded) return;
      const candidate = cwdPath.trim();
      if (!candidate) return;
      if (isKnownProjectPath(candidate, projects)) {
        if (projectCandidate?.useId === useId) setProjectCandidate(null);
        return;
      }
      if (dismissedProjectCandidatesRef.current.has(candidate)) return;
      if (projectCandidate && projectCandidate.useId !== useId) return;
      if (projectCandidate?.path === candidate) return;
      setProjectCandidate({ useId, path: candidate });
    },
    [projectCandidate, projects, projectsLoaded],
  );

  useEffect(() => {
    if (
      projectCandidate &&
      isKnownProjectPath(projectCandidate.path, projects)
    ) {
      setProjectCandidate(null);
    }
  }, [projectCandidate, projects]);

  const dismissProjectCandidate = useCallback(() => {
    if (!projectCandidate) return;
    dismissedProjectCandidatesRef.current.add(projectCandidate.path);
    setProjectCandidate(null);
  }, [projectCandidate]);

  const addProjectCandidate = useCallback(async () => {
    if (!projectCandidate || addingProjectPath) return;
    const candidate = projectCandidate.path;
    setAddingProjectPath(candidate);
    try {
      const project = await addKnownProject(candidate);
      if (project) {
        dismissedProjectCandidatesRef.current.add(candidate);
        setProjectCandidate(null);
      }
    } finally {
      setAddingProjectPath(null);
    }
  }, [addKnownProject, addingProjectPath, projectCandidate]);

  useEffect(() => {
    const onPopState = () => setRouteRevision(revision => revision + 1);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const route = resolveToolSessionRoute(location.href, localStorage);
    const requestedUse = route.toolUseId
      ? snapshot.usesById.get(route.toolUseId)
      : undefined;
    const session = chooseSession(route.sessionId ?? requestedUse?.sessionId, [
      ...snapshot.sessionsById.values(),
    ]);
    if (!session) return;
    const tabs = snapshot.visibleTabIdsBySession.get(session.id) ?? [];
    const tab = chooseTab(
      route.tabId,
      session,
      tabs.map(id => snapshot.tabsById.get(id)).filter((value): value is SessionTab => Boolean(value)),
      requestedUse?.sessionId === session.id ? requestedUse.tabId : undefined,
    );
    const ids = tab ? snapshot.useIdsByTab.get(tab.id) ?? [] : EMPTY_TOOL_USE_IDS;
    const mobileListRoute = isMobile && !route.toolUseId;
    const useId = mobileListRoute
      ? undefined
      : chooseToolUse(route.toolUseId, tab, ids);
    if (snapshot.activeSessionId !== session.id)
      client.store.selectSession(session.id);
    if (tab && snapshot.activeTabId !== tab.id)
      client.store.selectTab(tab.id);
    if (useId && snapshot.activeToolUseId !== useId)
      client.store.selectToolUse(useId);
    const url = toolSessionUrl(session.id, tab?.id, useId);
    persistToolSessionRoute(url, localStorage);
    if (location.href !== new URL(url, location.origin).href)
      history.replaceState(null, "", url);
  }, [
    client,
    snapshot.activeSessionId,
    snapshot.activeTabId,
    snapshot.activeToolUseId,
    snapshot.sessionsById,
    snapshot.tabsById,
    snapshot.usesById,
    snapshot.visibleTabIdsBySession,
    snapshot.useIdsByTab,
    routeRevision,
    isMobile,
  ]);

  const visibleSessions = useMemo(
    () =>
      snapshot.visibleSessionIds
        .map(id => snapshot.sessionsById.get(id))
        .filter((session): session is NonNullable<typeof session> =>
          Boolean(session),
        ),
    [snapshot.sessionsById, snapshot.visibleSessionIds],
  );
  const activeSession = snapshot.activeSessionId
    ? snapshot.sessionsById.get(snapshot.activeSessionId)
    : undefined;
  const activeTab = snapshot.activeTabId
    ? snapshot.tabsById.get(snapshot.activeTabId)
    : undefined;
  const tabIds = useMemo(
    () =>
      activeSession
        ? (snapshot.visibleTabIdsBySession.get(activeSession.id) ?? EMPTY_TAB_IDS)
        : EMPTY_TAB_IDS,
    [activeSession?.id, snapshot.visibleTabIdsBySession],
  );
  const visibleTabs = useMemo(
    () =>
      tabIds
        .map(id => snapshot.tabsById.get(id))
        .filter((tab): tab is SessionTab => Boolean(tab)),
    [snapshot.tabsById, tabIds],
  );
  const useIds = useMemo(
    () =>
      activeTab
        ? (snapshot.useIdsByTab.get(activeTab.id) ?? EMPTY_TOOL_USE_IDS)
        : EMPTY_TOOL_USE_IDS,
    [activeTab?.id, snapshot.useIdsByTab],
  );
  const sessionTitlesById = useMemo(() => {
    const titles = new Map<SessionId, string>();
    for (const session of visibleSessions) titles.set(session.id, session.title);
    return titles;
  }, [visibleSessions]);
  const toolCounts = useMemo(() => {
    const counts = new Map<SessionId, number>();
    for (const [id, ids] of snapshot.useIdsBySession) counts.set(id, ids.length);
    return counts;
  }, [snapshot.useIdsBySession]);
  const selected = snapshot.activeToolUseId
    ? snapshot.usesById.get(snapshot.activeToolUseId)
    : undefined;
  const twoSidebarLayout = appearanceSettings.sessionLayout === "two-sidebars";
  const singleSidebarLayout =
    appearanceSettings.sessionLayout === "single-sidebar";
  const sidebarLayout = twoSidebarLayout || singleSidebarLayout;
  const sidebarsCollapsed =
    sidebarLayout && appearanceSettings.sidebarCollapsed;
  const agentSidebarCollapsed = appearanceSettings.sidebarCollapsed;
  const sidebarOrientation = isMobile ? "horizontal" : "vertical";
  const runningAgents = useRunningAgents();
  const toolUseIdByPty = useMemo(() => {
    const ids = new Map<string, ToolUseId>();
    for (const use of snapshot.usesById.values()) {
      if (use.output.kind !== "process" || !use.output.ptyId) continue;
      ids.set(use.output.ptyId, use.id);
    }
    return ids;
  }, [snapshot.usesById]);
  const projectNamesById = useMemo(() => {
    const names = new Map<string, string>();
    for (const project of projects) names.set(project.projectId, project.projectName);
    return names;
  }, [projects]);
  const runningAgentItems = useMemo(
    () =>
      toRunningAgentSidebarItems(
        runningAgents.agents,
        toolUseIdByPty,
        projectNamesById,
      ),
    [projectNamesById, runningAgents.agents, toolUseIdByPty],
  );
  const agentProvidersByToolUseId = useMemo(() => {
    const providers = new Map<string, string>();
    for (const agent of runningAgentItems) {
      if (agent.toolUseId) providers.set(agent.toolUseId, agent.provider);
    }
    return providers;
  }, [runningAgentItems]);
  const hasRunningAgents = runningAgentItems.length > 0;
  const showAgentSidebar =
    !isMobile && hasRunningAgents && !agentSidebarCollapsed;

  const toggleSidebars = useCallback(() => {
    setAppearanceSettings((previous) => ({
      ...previous,
      sidebarCollapsed: !previous.sidebarCollapsed,
    }));
  }, [setAppearanceSettings]);

  const resizeSidebar = useCallback(
    (width: number) => {
      setAppearanceSettings((previous) => ({
        ...previous,
        sidebarWidth: Math.max(
          MIN_SIDEBAR_WIDTH,
          Math.min(MAX_SIDEBAR_WIDTH, width),
        ),
      }));
    },
    [setAppearanceSettings],
  );

  const updateRuntimeTitle = useCallback(
    (use: ToolUse, title: string, source: RuntimeToolTitle["source"]) => {
      setRuntimeTitles((previous) => {
        const current = previous.get(use.id);
        const next = nextRuntimeToolTitle(use, current, title, source);
        if (
          !next ||
          (current?.title === next.title && current.source === next.source)
        ) {
          return previous;
        }
        return new Map(previous).set(use.id, next);
      });
    },
    [],
  );

  useEffect(() => {
    setToolWorkspaces(previous => {
      const next = new Map(previous);
      let changed = false;
      for (const tabId of tabIds) {
        if (next.has(tabId)) continue;
        const tab = snapshot.tabsById.get(tabId);
        if (!tab) continue;
        const ids = snapshot.useIdsByTab.get(tab.id) ?? EMPTY_TOOL_USE_IDS;
        next.set(tab.id, restoreToolWorkspace(tab.layoutJson, ids));
        changed = true;
      }
      return changed ? next : previous;
    });
  }, [snapshot.tabsById, snapshot.useIdsByTab, tabIds]);

  // Herdr keeps layout authoritative on the host. Adopt a remote layout event
  // only when the local workspace still matches the last server layout; a
  // genuinely dirty local workspace remains visible and is resolved by the
  // revision-checked save path instead of being silently discarded.
  useEffect(() => {
    const replacements = new Map<
      SessionTabId,
      { expected: ToolWorkspace; next: ToolWorkspace }
    >();
    for (const tabId of tabIds) {
      const tab = snapshot.tabsById.get(tabId);
      const workspace = tab ? toolWorkspaces.get(tab.id) : undefined;
      if (!tab) continue;
      const previousServer = layoutServerStateRef.current.get(tab.id);
      const localJson = workspace ? serializeToolWorkspace(workspace) : undefined;
      const serverChanged = Boolean(
        previousServer &&
          (previousServer.revision !== (tab.revision ?? 0) ||
            previousServer.layoutJson !== tab.layoutJson),
      );
      if (
        workspace &&
        previousServer &&
        serverChanged &&
        localJson === previousServer.layoutJson &&
        localJson !== tab.layoutJson
      ) {
        const ids = snapshot.useIdsByTab.get(tab.id) ?? EMPTY_TOOL_USE_IDS;
        replacements.set(tab.id, {
          expected: workspace,
          next: restoreToolWorkspace(tab.layoutJson, ids),
        });
      }
      layoutServerStateRef.current.set(tab.id, {
        revision: tab.revision ?? 0,
        ...(tab.layoutJson === undefined ? {} : { layoutJson: tab.layoutJson }),
      });
    }
    if (replacements.size === 0) return;
    setToolWorkspaces(previous => {
      const next = new Map(previous);
      let changed = false;
      for (const [tabId, replacement] of replacements) {
        if (previous.get(tabId) !== replacement.expected) continue;
        next.set(tabId, replacement.next);
        changed = true;
      }
      return changed ? next : previous;
    });
  }, [snapshot.tabsById, snapshot.useIdsByTab, tabIds, toolWorkspaces]);

  const updateToolWorkspace = useCallback(
    (
      tabId: SessionTabId,
      update: (workspace: ToolWorkspace) => ToolWorkspace,
    ) => {
      setToolWorkspaces((previous) => {
        const current = previous.get(tabId) ?? createToolWorkspace();
        const next = update(current);
        if (next === current && previous.has(tabId)) return previous;
        return new Map(previous).set(tabId, next);
      });
    },
    [],
  );

  const splitFocusedToolPanel = useCallback(
    (edge: "right" | "bottom") => {
      if (!activeTab) return;
      updateToolWorkspace(activeTab.id, workspace =>
        splitToolPanel(workspace, workspace.focusedPanelId, edge),
      );
    },
    [activeTab?.id, updateToolWorkspace],
  );

  const openToolInWorkspace = useCallback(
    (use: ToolUse, target?: ToolOpenTarget) => {
      const current = client.store.getSnapshot();
      const tabId =
        target?.tabId ??
        use.tabId ??
        current.sessionsById.get(use.sessionId)?.activeTabId ??
        current.visibleTabIdsBySession.get(use.sessionId)?.[0] ??
        activeTab?.id;
      if (!tabId) return;
      updateToolWorkspace(tabId, (workspace) =>
        target?.panelId === undefined
          ? openToolView(workspace, use.id)
          : openToolViewInPanel(workspace, target.panelId, use.id),
      );
    },
    [activeTab?.id, client, updateToolWorkspace],
  );

  const selectSession = useCallback(
    (id: SessionId) => {
      markPerformance("yaade:session-switch");
      client.store.selectSession(id);
      const session = client.store.getSnapshot().sessionsById.get(id);
      const nextTab = session?.activeTabId
        ? client.store.getSnapshot().tabsById.get(session.activeTabId)
        : undefined;
      writeToolSessionLocation(
        session ? toolSessionUrl(session.id, nextTab?.id, nextTab?.activeToolUseId) : "/",
        "push",
      );
    },
    [client],
  );

  const selectTool = useCallback(
    (use: ToolUse, target?: ToolOpenTarget) => {
      markPerformance("yaade:tool-switch");
      openToolInWorkspace(use, target);
      const current = client.store.getSnapshot().activeToolUseId;
      client.store.selectToolUse(use.id);
      const tabId = use.tabId ?? client.store.getSnapshot().activeTabId;
      const request = window.yaade?.tools?.selectUse?.(use.sessionId, use.id);
      if (request) {
        void request.catch(async error => {
          setActionError(errorMessage(error));
          await client.reconcileSession(use.sessionId).catch(() => undefined);
        });
      }
      const nextUrl = toolSessionUrl(use.sessionId, tabId, use.id);
      if (
        current !== use.id ||
        location.href !== new URL(nextUrl, location.origin).href
      ) {
        writeToolSessionLocation(nextUrl, "push", { yaadeMobileTool: use.id });
      }
    },
    [client, openToolInWorkspace],
  );

  const focusRunningAgent = useCallback(
    (agent: RunningAgentSidebarItem) => {
      if (!agent.toolUseId) return;
      for (const candidate of snapshot.usesById.values()) {
        if (candidate.id === agent.toolUseId) {
          selectTool(candidate);
          return;
        }
      }
    },
    [selectTool, snapshot.usesById],
  );

  const lastAutoOpenedToolRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!selected) return;
    const key = `${selected.sessionId}:${selected.id}`;
    if (lastAutoOpenedToolRef.current === key) return;
    lastAutoOpenedToolRef.current = key;
    openToolInWorkspace(selected);
  }, [openToolInWorkspace, selected?.id, selected?.sessionId]);

  useEffect(() => {
    if (!activeTab) return;
    const liveIds = new Set(useIds);
    updateToolWorkspace(activeTab.id, (workspace) =>
      removeMissingToolViews(workspace, liveIds),
    );
  }, [activeTab?.id, updateToolWorkspace, useIds]);

  const createTool = useCallback(
    async (
      nextKind: ToolKind = "terminal",
      launchContext?: ToolContextSelection,
      targetSessionId?: SessionId,
      target?: ToolOpenTarget,
    ): Promise<ToolUse | undefined> => {
      const currentSnapshot = client.store.getSnapshot();
      const targetSession = target
        ? currentSnapshot.sessionsById.get(target.sessionId)
        : targetSessionId
          ? currentSnapshot.sessionsById.get(targetSessionId)
          : activeSession;
      const targetTabIds = targetSession
        ? currentSnapshot.visibleTabIdsBySession.get(targetSession.id) ?? EMPTY_TAB_IDS
        : EMPTY_TAB_IDS;
      const preferredTabId = target?.tabId ?? targetSession?.activeTabId ?? targetTabIds[0];
      const targetTab = preferredTabId
        ? currentSnapshot.tabsById.get(preferredTabId)
        : undefined;
      if (
        !targetSession ||
        !targetTab ||
        !isLiveSessionTab(targetSession, targetTab) ||
        closingTabIdsRef.current.has(targetTab.id)
      ) {
        return undefined;
      }
      let destinationTabId = targetTab.id;
      setActionError(undefined);
      try {
        let nextProjects = projects;
        if (nextProjects.length === 0) {
          nextProjects = (await window.yaade?.tools?.listProjects?.()) ?? [];
          setProjects(nextProjects);
          setProjectsLoaded(true);
        }

        // A new Window starts an async terminal creation. If that Window was
        // closed while project discovery was in flight, do not send its stale
        // tab id back to the host.
        const liveSnapshot = client.store.getSnapshot();
        const liveSession = liveSnapshot.sessionsById.get(targetSession.id);
        const liveTab = liveSnapshot.tabsById.get(targetTab.id);
        if (
          !liveSession ||
          !liveTab ||
          !isLiveSessionTab(liveSession, liveTab) ||
          closingTabIdsRef.current.has(targetTab.id)
        ) {
          return undefined;
        }

        const nextProject = launchContext?.project ?? nextProjects[0];
        if (!nextProject) {
          setActionError("No project available.");
          return undefined;
        }
        const input: ToolUseInput =
          nextKind === "git"
            ? { _tag: "GitToolInput", kind: "git" }
            : { _tag: "TerminalToolInput", kind: "terminal" };
        const targetUseIds =
          liveSnapshot.useIdsByTab.get(liveTab.id) ?? EMPTY_TOOL_USE_IDS;
        const currentWorkspace =
          toolWorkspaces.get(liveTab.id) ??
          restoreToolWorkspace(liveTab.layoutJson, targetUseIds);
        let hasEmptyPane = false;
        currentWorkspace.tree.visitLeaves(leaf => {
          if (leaf.view.kind === "empty") hasEmptyPane = true;
        });
        let destinationTab = liveTab;
        let rollbackTab: SessionTab | undefined;
        if (
          toolPaneCount(currentWorkspace) >= MAX_TOOL_TILES &&
          !hasEmptyPane
        ) {
          const liveTabIds =
            liveSnapshot.visibleTabIdsBySession.get(liveSession.id) ?? EMPTY_TAB_IDS;
          const createdTab = await window.yaade?.tools?.createTab?.({
            _tag: "CreateSessionTab",
            sessionId: liveSession.id,
            title: `Window ${liveTabIds.length + 1}`,
          });
          if (!createdTab) throw new Error("Could not create another Window.");
          destinationTab = createdTab;
          destinationTabId = createdTab.id;
          rollbackTab = createdTab;
        }

        const requestSnapshot = client.store.getSnapshot();
        const requestSession = requestSnapshot.sessionsById.get(liveSession.id);
        const requestTargetTab = requestSnapshot.tabsById.get(targetTab.id);
        if (
          !requestSession ||
          !requestTargetTab ||
          !isLiveSessionTab(requestSession, requestTargetTab) ||
          closingTabIdsRef.current.has(targetTab.id)
        ) {
          if (rollbackTab) {
            const rollback = window.yaade?.tools?.archiveTab?.({
              _tag: "ArchiveSessionTab",
              tabId: rollbackTab.id,
              mode: "stop-tools",
            });
            if (rollback) await rollback.catch(() => undefined);
          }
          return undefined;
        }

        const command: CreateToolUse = {
          _tag: "CreateToolUse",
          sessionId: liveSession.id,
          tabId: destinationTab.id,
          kind: nextKind,
          project: nextProject,
          checkout:
            launchContext?.checkout ?? MainCheckout.make({ kind: "main" }),
          input,
        };
        try {
          const created = await window.yaade?.tools?.createUse?.(command);
          if (created) client.store.replaceToolUse(created);
          await client.reconcileSession(liveSession.id);
          if (created) {
            const openTarget =
              target && destinationTab.id === target.tabId ? target : undefined;
            selectTool(created, openTarget);
          }
          return created;
        } catch (error) {
          if (rollbackTab) {
            const rollback = window.yaade?.tools?.archiveTab?.({
              _tag: "ArchiveSessionTab",
              tabId: rollbackTab.id,
              mode: "stop-tools",
            });
            if (rollback) await rollback.catch(() => undefined);
          }
          throw error;
        }
      } catch (error) {
        const failedSnapshot = client.store.getSnapshot();
        const failedSession = failedSnapshot.sessionsById.get(targetSession.id);
        const failedTab = failedSnapshot.tabsById.get(destinationTabId);
        // Closing a Window can race the automatic terminal creation above.
        // The failed request is expected in that case, not an app error.
        if (
          closingTabIdsRef.current.has(targetTab.id) ||
          closingTabIdsRef.current.has(destinationTabId) ||
          !isLiveSessionTab(failedSession, failedTab)
        ) {
          return undefined;
        }
        setActionError(errorMessage(error));
        return undefined;
      }
    },
    [activeSession, client, projects, selectTool, toolWorkspaces],
  );

  const selectTab = useCallback(
    (tab: SessionTab) => {
      const currentSnapshot = client.store.getSnapshot();
      const session = currentSnapshot.sessionsById.get(tab.sessionId);
      const currentTab = currentSnapshot.tabsById.get(tab.id);
      if (
        !session ||
        !currentTab ||
        !isLiveSessionTab(session, currentTab) ||
        closingTabIdsRef.current.has(tab.id)
      ) {
        return;
      }
      markPerformance("yaade:tab-switch");
      client.store.selectTab(tab.id);
      const nextUse = client.store.getSnapshot().activeToolUseId;
      writeToolSessionLocation(toolSessionUrl(session.id, tab.id, nextUse), "push");
      const request = window.yaade?.tools?.selectTab?.({
        _tag: "SelectSessionTab",
        sessionId: tab.sessionId,
        tabId: tab.id,
      });
      if (request) {
        void request.catch(async error => {
          const failedSnapshot = client.store.getSnapshot();
          const failedSession = failedSnapshot.sessionsById.get(tab.sessionId);
          const failedTab = failedSnapshot.tabsById.get(tab.id);
          if (
            closingTabIdsRef.current.has(tab.id) ||
            !isLiveSessionTab(failedSession, failedTab)
          ) {
            return;
          }
          setActionError(errorMessage(error));
          await client.reconcileSession(tab.sessionId).catch(() => undefined);
        });
      }
    },
    [client],
  );

  const createTab = useCallback(async () => {
    if (!activeSession) return;
    try {
      const tab = await window.yaade?.tools?.createTab?.({
        _tag: "CreateSessionTab",
        sessionId: activeSession.id,
        title: "New tab",
      });
      if (!tab) return;
      await client.reconcileSession(activeSession.id);
      selectTab(tab);
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }, [activeSession, client, selectTab]);

  const renameTab = useCallback(async (id: SessionTabId, title: string) => {
    try {
      const tab = await window.yaade?.tools?.renameTab?.({ _tag: "RenameSessionTab", tabId: id, title });
      if (tab) client.store.replaceTab(tab);
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }, [client]);

  const reorderTabs = useCallback(async (ids: readonly SessionTabId[]) => {
    if (!activeSession) return;
    try {
      await window.yaade?.tools?.reorderTabs?.({
        _tag: "ReorderSessionTabs",
        sessionId: activeSession.id,
        tabIds: ids,
      });
      await client.reconcileSession(activeSession.id);
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }, [activeSession, client]);

  const closeTab = useCallback(async (tab: SessionTab) => {
    closingTabIdsRef.current.add(tab.id);
    try {
      await window.yaade?.tools?.archiveTab?.({
        _tag: "ArchiveSessionTab",
        tabId: tab.id,
        mode: "stop-tools",
      });
      await client.reconcileSession(tab.sessionId);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      closingTabIdsRef.current.delete(tab.id);
    }
  }, [client]);

  const createSession = useCallback(async () => {
    try {
      const created = await window.yaade?.tools?.createSession?.("New session");
      if (!created) return;
      await client.reconcile();
      selectSession(created.id);
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }, [client, selectSession]);

  const runToolAction = useCallback(
    async (action: "cancel" | "restart" | "archive", use: ToolUse) => {
      setActionError(undefined);
      try {
        const api = window.yaade?.tools;
        const result =
          action === "cancel"
            ? await api?.cancelUse?.(use.id, use.revision)
            : action === "restart"
              ? await api?.restartUse?.(use.id, use.revision)
              : await api?.archiveUse?.({
                  _tag: "ArchiveToolUse",
                  toolUseId: use.id,
                });
        if (result) client.store.replaceToolUse(result);
        await client.reconcileSession(use.sessionId);
      } catch (error) {
        setActionError(errorMessage(error));
        await client.reconcileSession(use.sessionId).catch(() => undefined);
      }
    },
    [client],
  );

  const closeSession = useCallback(
    async (sessionId: SessionId, mode: "keep-running" | "stop-tools") => {
      try {
        const archived = await window.yaade?.tools?.archiveSession?.({
          _tag: "ArchiveSession",
          sessionId,
          mode,
        });
        if (archived) {
          client.store.apply({
            _tag: "SessionArchived",
            eventId: `local:${archived.id}`,
            revision: archived.revision ?? 1,
            occurredAt: archived.updatedAt,
            session: archived,
          });
        }
        await client.reconcile();
        setCloseChoice(undefined);
      } catch (error) {
        setActionError(errorMessage(error));
      }
    },
    [client],
  );

  const requestCloseSession = useCallback(
    (sessionId: SessionId) => {
      const sessionUses =
        client.store.getSnapshot().useIdsBySession.get(sessionId) ?? [];
      const live = sessionUses.some((id) => {
        const use = client.store.getSnapshot().usesById.get(id);
        return use ? isLive(use) : false;
      });
      if (live) setCloseChoice({ sessionId });
      else void closeSession(sessionId, "keep-running");
    },
    [client, closeSession],
  );

  const renameSession = useCallback(
    async (id: SessionId, title: string) => {
      const renamed = await window.yaade?.tools?.renameSession?.(id, title);
      if (renamed) await client.reconcile();
    },
    [client],
  );

  const reorderSessions = useCallback(
    async (ids: readonly SessionId[]) => {
      await window.yaade?.tools?.reorderSessions?.({
        _tag: "ReorderSessions",
        sessionIds: ids,
      });
      await client.reconcile();
    },
    [client],
  );

  const renameToolUse = useCallback(
    async (use: ToolUse, title: string) => {
      const renamed = await window.yaade?.tools?.renameUse?.(use.id, title);
      if (renamed) client.store.replaceToolUse(renamed);
    },
    [client],
  );

  const reorderToolUses = useCallback(
    async (ids: readonly ToolUseId[]) => {
      if (!activeSession || !activeTab) return;
      await window.yaade?.tools?.reorderUses?.({
        _tag: "ReorderToolUses",
        sessionId: activeSession.id,
        tabId: activeTab.id,
        toolUseIds: ids,
      });
      await client.reconcileSession(activeSession.id);
    },
    [activeSession, activeTab, client],
  );

  useEffect(() => {
    const bridge = window.__yaadeAgent;
    if (!bridge) return;
    const previous = {
      getState: bridge.getState,
      createSession: bridge.createSession,
      selectSession: bridge.selectSession,
      createTab: bridge.createTab,
      selectTab: bridge.selectTab,
      closeTab: bridge.closeTab,
      createToolUse: bridge.createToolUse,
      selectToolUse: bridge.selectToolUse,
      closeToolUse: bridge.closeToolUse,
      closeSession: bridge.closeSession,
      getPerfMeasures: bridge.getPerfMeasures,
    };
    const sessionFor = (id: string) =>
      [...snapshot.sessionsById.values()].find((session) => session.id === id);
    const useFor = (id: string) =>
      [...snapshot.usesById.values()].find((use) => use.id === id);
    const tabFor = (id: string) =>
      [...snapshot.tabsById.values()].find(tab => tab.id === id);
    bridge.getState = () => ({
      ...previous.getState(),
      route: "session",
      activeSessionId: snapshot.activeSessionId ?? null,
      activeTabId: snapshot.activeTabId ?? null,
      activeToolUseId: snapshot.activeToolUseId ?? null,
      sessions: visibleSessions,
      tabs: activeSession
        ? (snapshot.visibleTabIdsBySession.get(activeSession.id) ?? [])
            .map(id => snapshot.tabsById.get(id))
            .filter((tab): tab is SessionTab => Boolean(tab))
        : [],
      toolUses: [...snapshot.usesById.values()].filter(
        (use) => !use.archivedAt,
      ),
      connection: snapshot.connection,
    });
    bridge.createSession = async () => {
      await createSession();
    };
    bridge.selectSession = async (id) => {
      const session = sessionFor(id);
      if (session) selectSession(session.id);
    };
    bridge.createTab = async () => {
      await createTab();
    };
    bridge.selectTab = async (id) => {
      const tab = tabFor(id);
      if (tab) selectTab(tab);
    };
    bridge.closeTab = async (id) => {
      const tab = tabFor(id);
      if (tab) await closeTab(tab);
    };
    bridge.createToolUse = async (nextKind) => {
      await createTool(nextKind);
    };
    bridge.selectToolUse = async (id) => {
      const use = useFor(id);
      if (use) selectTool(use);
    };
    bridge.closeToolUse = async (id) => {
      const use = useFor(id);
      if (use) await runToolAction("archive", use);
    };
    bridge.closeSession = async (id, mode = "keep-running") => {
      const session = sessionFor(id);
      if (session) await closeSession(session.id, mode);
    };
    bridge.getPerfMeasures = (names?: string[]) => {
      try {
        const measures = performance
          .getEntriesByType("measure")
          .filter((entry) => entry.name.startsWith("yaade:"))
          .filter((entry) => !names || names.includes(entry.name))
          .map((entry) => ({ name: entry.name, durationMs: entry.duration }));
        return measures;
      } catch {
        return previous.getPerfMeasures?.(names) ?? [];
      }
    };
    return () => {
      bridge.getState = previous.getState;
      bridge.createSession = previous.createSession;
      bridge.selectSession = previous.selectSession;
      bridge.createTab = previous.createTab;
      bridge.selectTab = previous.selectTab;
      bridge.closeTab = previous.closeTab;
      bridge.createToolUse = previous.createToolUse;
      bridge.selectToolUse = previous.selectToolUse;
      bridge.closeToolUse = previous.closeToolUse;
      bridge.closeSession = previous.closeSession;
      bridge.getPerfMeasures = previous.getPerfMeasures;
    };
  }, [
    closeSession,
    closeTab,
    createSession,
    createTab,
    createTool,
    runToolAction,
    selectSession,
    selectTab,
    selectTool,
    snapshot,
    visibleSessions,
  ]);

  const clearPrefix = useCallback(() => {
    clearToolSessionKeymapState(keymapStateRef.current);
    if (prefixTimerRef.current !== undefined) {
      window.clearTimeout(prefixTimerRef.current);
      prefixTimerRef.current = undefined;
    }
    setPrefixPending(false);
  }, []);

  const showPrefix = useCallback(() => {
    if (prefixTimerRef.current !== undefined) {
      window.clearTimeout(prefixTimerRef.current);
    }
    setPrefixPending(true);
    prefixTimerRef.current = window.setTimeout(() => {
      clearToolSessionKeymapState(keymapStateRef.current);
      prefixTimerRef.current = undefined;
      setPrefixPending(false);
    }, CHORD_TIMEOUT_MS);
  }, []);

  const runToolSessionCommand = useCallback(
    (command: ToolSessionCommand, jumpIndex = 0) => {
      switch (command) {
        case "session.new":
          void createSession();
          return;
        case "tab.new":
          void createTab();
          return;
        case "tab.close":
          if (activeTab) void closeTab(activeTab);
          return;
        case "tab.next":
        case "tab.previous": {
          if (!activeTab || tabIds.length === 0) return;
          const index = tabIds.indexOf(activeTab.id);
          const nextIndex =
            command === "tab.next"
              ? (index + 1) % tabIds.length
              : (index - 1 + tabIds.length) % tabIds.length;
          const next = snapshot.tabsById.get(tabIds[nextIndex]!);
          if (next) selectTab(next);
          return;
        }
        case "tool.newTerminal":
          void createTool("terminal");
          return;
        case "tool.newGit":
          void createTool("git");
          return;
        case "session.switch":
          setSwitcherOpen(true);
          return;
        case "tool.switch":
          setToolUseSwitcherOpen(true);
          return;
        case "tool.next":
        case "tool.previous": {
          if (!selected || useIds.length === 0) return;
          const index = useIds.indexOf(selected.id);
          const nextIndex =
            command === "tool.next"
              ? (index + 1) % useIds.length
              : (index - 1 + useIds.length) % useIds.length;
          const next = snapshot.usesById.get(useIds[nextIndex]!);
          if (next) selectTool(next);
          return;
        }
        case "tool.jump": {
          const id = useIds[jumpIndex];
          if (!id) return;
          const next = snapshot.usesById.get(id);
          if (next) selectTool(next);
          return;
        }
        case "tool.close": {
          const target = focusedToolUseRef.current ?? selected;
          if (target) void runToolAction("archive", target);
          return;
        }
        case "session.close":
          if (activeSession) requestCloseSession(activeSession.id);
          return;
        case "pane.zoom":
          if (activeTab) {
            updateToolWorkspace(activeTab.id, workspace =>
              toggleToolPanelZoom(workspace, workspace.focusedPanelId),
            );
          }
          return;
        case "pane.splitRight":
          splitFocusedToolPanel("right");
          return;
        case "pane.splitDown":
          splitFocusedToolPanel("bottom");
          return;
        case "sidebar.toggle":
          toggleSidebars();
          return;
        case "settings.show":
          setSettingsOpen(true);
          return;
      }
    },
    [
      activeSession,
      activeTab,
      createSession,
      createTab,
      closeTab,
      createTool,
      requestCloseSession,
      runToolAction,
      selectTab,
      selectTool,
      selected,
      snapshot.tabsById,
      snapshot.usesById,
      splitFocusedToolPanel,
      toggleSidebars,
      updateToolWorkspace,
      useIds,
    ],
  );

  const runToolSessionCommandRef = useRef(runToolSessionCommand);
  runToolSessionCommandRef.current = runToolSessionCommand;
  const selectedToolRef = useRef(selected);
  selectedToolRef.current = selected;
  const keybindingContextRef = useRef<
    Pick<ToolSessionKeydownContext, "overlayOpen" | "zoomed" | "contextKind">
  >({ overlayOpen: false, zoomed: false });
  keybindingContextRef.current = {
    overlayOpen: Boolean(
      switcherOpen ||
        toolUseSwitcherOpen ||
        settingsOpen ||
        closeChoice ||
        paneChromeOverlayOpen,
    ),
    zoomed: Boolean(
      activeSession &&
        activeTab &&
        toolWorkspaces.get(activeTab.id)?.zoomedPanelId,
    ),
    contextKind: selected?.kind,
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const inEditable = Boolean(
        target?.closest("input, textarea, [contenteditable=true]"),
      );
      const inTerminal = Boolean(
        target?.closest(
          "[data-ghostty-terminal-input], [data-ghostty-terminal-canvas]",
        ),
      );
      const result = resolveToolSessionKeydown(
        event,
        keymapStateRef.current,
        {
          ...keybindingContextRef.current,
          inEditable,
          inTerminal,
          inPrefixButton: Boolean(
            target?.closest("[data-yaade-which-key-item]"),
          ),
        },
      );
      if (!result) return;

      event.preventDefault();
      event.stopPropagation();
      if (result.type === "prefix-started") {
        showPrefix();
        return;
      }
      if (result.type === "prefix-literal") {
        clearPrefix();
        const target = focusedToolUseRef.current ?? selectedToolRef.current;
        const ptyId =
          target?.output.kind === "process" ? target.output.ptyId : undefined;
        if (ptyId) void window.yaade?.terminal?.write?.(ptyId, result.byte);
        return;
      }
      if (result.type === "command") {
        clearPrefix();
        runToolSessionCommandRef.current(result.command, result.jumpIndex);
        return;
      }
      clearPrefix();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      if (prefixTimerRef.current !== undefined) {
        window.clearTimeout(prefixTimerRef.current);
        prefixTimerRef.current = undefined;
      }
      clearToolSessionKeymapState(keymapStateRef.current);
    };
  }, [clearPrefix, showPrefix]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!prefixPending) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-yaade-which-key]")) return;
      clearPrefix();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [clearPrefix, prefixPending]);

  const muxOverlayOpen = Boolean(
    switcherOpen ||
      toolUseSwitcherOpen ||
      settingsOpen ||
      closeChoice ||
      paneChromeOverlayOpen,
  );
  useEffect(() => {
    if (muxOverlayOpen) {
      overlayWasOpenRef.current = true;
      clearPrefix();
      return;
    }
    if (!overlayWasOpenRef.current) return;
    overlayWasOpenRef.current = false;
    const target = focusedToolUseRef.current ?? selectedToolRef.current;
    const tabId = target?.kind === "terminal" ? target.id : undefined;
    const raf = requestAnimationFrame(() => {
      focusRegisteredTerminal(tabId);
    });
    return () => cancelAnimationFrame(raf);
  }, [clearPrefix, muxOverlayOpen]);

  const updateToolContext = useCallback(
    async (
      use: ToolUse,
      nextProject: ProjectTarget,
      checkout: CheckoutTarget,
    ) => {
      const latest = client.store.getSnapshot().usesById.get(use.id) ?? use;
      try {
        const updated = await window.yaade?.tools?.updateUseContext?.({
          _tag: "UpdateToolUseContext",
          toolUseId: latest.id,
          revision: latest.revision,
          project: nextProject,
          checkout,
        });
        if (updated) client.store.replaceToolUse(updated);
        setActionError(undefined);
        await client.reconcileSession(latest.sessionId);
      } catch (error) {
        setActionError(errorMessage(error));
        await client.reconcileSession(latest.sessionId).catch(() => undefined);
      }
    },
    [client],
  );

  const activeToolWorkspace = useMemo(() => {
    if (!activeTab) return createToolWorkspace();
    return toolWorkspaces.get(activeTab.id) ??
      restoreToolWorkspace(activeTab.layoutJson, useIds);
  }, [activeTab, toolWorkspaces, useIds]);
  const focusedView = activeToolWorkspace.tree.getView(
    activeToolWorkspace.focusedPanelId,
  );
  focusedToolUseRef.current =
    focusedView?.kind === "tool"
      ? snapshot.usesById.get(focusedView.toolUseId)
      : undefined;

  useEffect(() => {
    if (!activeSession || !activeTab || snapshot.connection !== "connected") {
      return;
    }
    const emptyPanel = firstEmptyToolPanel(activeToolWorkspace);
    if (!emptyPanel) return;

    // A tool may exist remotely while its restored view is still being placed.
    // Let the restore effect finish before treating the pane as unconfigured.
    if (useIds.length > 0 && toolIdsInWorkspace(activeToolWorkspace).length === 0) {
      return;
    }

    const requestKey = `${activeTab.id}:${emptyPanel.id}`;
    if (pendingToolPanelRequestsRef.current.has(requestKey)) return;
    pendingToolPanelRequestsRef.current.add(requestKey);
    void createTool("terminal", undefined, activeSession.id, {
      sessionId: activeSession.id,
      tabId: activeTab.id,
      panelId: emptyPanel,
    }).finally(() => {
      pendingToolPanelRequestsRef.current.delete(requestKey);
    });
  }, [
    activeSession,
    activeTab,
    activeToolWorkspace,
    createTool,
    snapshot.connection,
    useIds,
  ]);

  const windowTabMeta = useMemo(
    () =>
      windowTabMetaForTabs(
        visibleTabs,
        toolWorkspaces,
        snapshot.usesById,
        runtimeTitles,
        agentProvidersByToolUseId,
        snapshot.useIdsByTab,
      ),
    [
      agentProvidersByToolUseId,
      runtimeTitles,
      snapshot.useIdsByTab,
      snapshot.usesById,
      toolWorkspaces,
      visibleTabs,
    ],
  );

  const activeTabForLayoutRef = useRef(activeTab);
  activeTabForLayoutRef.current = activeTab;

  useEffect(() => {
    const currentTab = activeTabForLayoutRef.current;
    if (!currentTab) return;
    const workspace = toolWorkspaces.get(currentTab.id);
    if (!workspace) return;
    const layoutJson = serializeToolWorkspace(workspace);
    if (layoutJson === currentTab.layoutJson) return;
    const tabId = currentTab.id;
    const sessionId = currentTab.sessionId;
    const handle = window.setTimeout(() => {
      const save = window.yaade?.tools?.saveTabLayout;
      if (!save) return;
      const previous = layoutSaveTails.current.get(tabId) ?? Promise.resolve();
      const operation = previous
        .catch(() => undefined)
        .then(async () => {
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const currentTab = client.store.getSnapshot().tabsById.get(tabId);
            if (!currentTab || currentTab.archivedAt) return;
            try {
              const tab = await save({
                _tag: "SaveSessionTabLayout",
                tabId,
                layoutJson,
                revision: currentTab.revision ?? 1,
              });
              client.store.replaceTab(tab);
              return;
            } catch (error) {
              if (!(error instanceof SessionTabConflict)) throw error;
              // The captured layout is stale after a concurrent writer won.
              // Reconcile first; the effect will serialize the current local
              // workspace against the new revision instead of replaying stale
              // bytes immediately.
              await client.reconcileSession(sessionId);
              return;
            }
          }
        })
        .catch(error => setActionError(errorMessage(error)))
        .then(() => undefined);
      layoutSaveTails.current.set(tabId, operation);
      void operation.then(() => {
        if (layoutSaveTails.current.get(tabId) === operation) {
          layoutSaveTails.current.delete(tabId);
        }
      });
    }, 350);
    return () => window.clearTimeout(handle);
  }, [activeTab?.id, client, toolWorkspaces]);

  const openToolUseIds = useMemo(
    () => new Set(toolIdsInWorkspace(activeToolWorkspace)),
    [activeToolWorkspace],
  );
  const activeSessionUseIds = useMemo(() => new Set(useIds), [useIds]);

  const toolUseIdForDrag = useCallback(
    (tabId: string): ToolUseId | undefined => useIds.find((id) => id === tabId),
    [useIds],
  );

  const activateDockedTool = useCallback(
    (use: ToolUse) => {
      if (client.store.getSnapshot().activeToolUseId === use.id) return;
      client.store.selectToolUse(use.id);
      const tabId = use.tabId ?? client.store.getSnapshot().activeTabId;
      const request = window.yaade?.tools?.selectUse?.(use.sessionId, use.id);
      if (request) {
        void request.catch(async error => {
          setActionError(errorMessage(error));
          await client.reconcileSession(use.sessionId).catch(() => undefined);
        });
      }
      writeToolSessionLocation(
        toolSessionUrl(use.sessionId, tabId, use.id),
        "replace",
      );
    },
    [client],
  );

  const toolTabDnd = useMemo((): TabDndHandlers => {
    return {
      onTabReorder: (panelId, tabId, toIndex) => {
        if (!activeTab) return;
        const toolUseId = toolUseIdForDrag(tabId);
        if (!toolUseId) return;
        updateToolWorkspace(activeTab.id, workspace =>
          reorderToolTabs(workspace, panelId, toolUseId, toIndex),
        );
      },
      tabIdsForPanel: panelId => {
        const view = activeToolWorkspace.tree.getView(panelId);
        return view?.kind === "tool" ? [view.toolUseId] : [];
      },
      onTabDrop: (_source, sourceTabId, target, action) => {
        if (!activeTab) return;
        const toolUseId = toolUseIdForDrag(sourceTabId);
        if (!toolUseId) return;
        const use = snapshot.usesById.get(toolUseId);
        updateToolWorkspace(activeTab.id, workspace =>
          dockToolView(workspace, toolUseId, target, action),
        );
        if (use) activateDockedTool(use);
      },
      onSessionDrop: (sourceTabId, target, action) => {
        if (!activeTab) return;
        const toolUseId = toolUseIdForDrag(sourceTabId);
        if (!toolUseId) return;
        const use = snapshot.usesById.get(toolUseId);
        updateToolWorkspace(activeTab.id, workspace =>
          dockToolView(workspace, toolUseId, target, action),
        );
        if (use) activateDockedTool(use);
      },
    };
  }, [
    activeTab,
    activeToolWorkspace,
    activateDockedTool,
    snapshot.usesById,
    toolUseIdForDrag,
    updateToolWorkspace,
  ]);

  const closeWorkspacePane = useCallback(
    (panelId: PanelId) => {
      if (!activeTab) return;
      const view = activeToolWorkspace.tree.getView(panelId);
      if (view?.kind === "tool") {
        const use = snapshot.usesById.get(view.toolUseId);
        if (use) void runToolAction("archive", use);
        return;
      }
      updateToolWorkspace(activeTab.id, workspace => closeToolPanel(workspace, panelId));
    },
    [activeTab, activeToolWorkspace, runToolAction, snapshot.usesById, updateToolWorkspace],
  );

  const handleToolPanelEvent = useCallback(
    (event: PanelEvent) => {
      if (!activeTab) return;
      if (event.type === "splitRatiosChanged") {
        updateToolWorkspace(activeTab.id, workspace =>
          resizeToolSplit(workspace, event.path, event.ratios),
        );
        return;
      }
      if (event.type === "panelClose") closeWorkspacePane(event.panelId);
    },
    [activeTab, closeWorkspacePane, updateToolWorkspace],
  );

  const focusWorkspacePanel = useCallback(
    (panelId: PanelId, use?: ToolUse) => {
      if (!activeTab) return;
      updateToolWorkspace(activeTab.id, workspace => focusToolPanel(workspace, panelId));
      if (use) activateDockedTool(use);
    },
    [activeTab, activateDockedTool, updateToolWorkspace],
  );

  const addToolToSplitPanel = useCallback(
    (panelId: PanelId, edge: "right" | "bottom", kind: ToolKind) => {
      if (!activeSession || !activeTab) return;
      const tabId = activeTab.id;
      const currentWorkspace =
        toolWorkspaces.get(tabId) ?? activeToolWorkspace;
      const nextWorkspace = splitToolPanel(currentWorkspace, panelId, edge);
      if (nextWorkspace === currentWorkspace) return;
      const target: ToolOpenTarget = {
        sessionId: activeSession.id,
        tabId,
        panelId: nextWorkspace.focusedPanelId,
      };
      updateToolWorkspace(tabId, workspace =>
        splitToolPanel(workspace, panelId, edge),
      );
      const requestKey = `${tabId}:${target.panelId.id}`;
      pendingToolPanelRequestsRef.current.add(requestKey);
      void createTool(kind, undefined, activeSession.id, target).finally(() => {
        pendingToolPanelRequestsRef.current.delete(requestKey);
      });
    },
    [
      activeSession,
      activeTab,
      activeToolWorkspace,
      createTool,
      toolWorkspaces,
      updateToolWorkspace,
    ],
  );

  const splitToolPanelAt = useCallback(
    (panelId: PanelId, edge: "right" | "bottom") => {
      if (!activeTab) return;
      updateToolWorkspace(activeTab.id, workspace =>
        splitToolPanel(workspace, panelId, edge),
      );
    },
    [activeTab?.id, updateToolWorkspace],
  );

  const zoomToolPanel = useCallback(
    (panelId: PanelId) => {
      if (!activeTab) return;
      updateToolWorkspace(activeTab.id, workspace =>
        toggleToolPanelZoom(workspace, panelId),
      );
    },
    [activeTab?.id, updateToolWorkspace],
  );

  const renderTool = useCallback(
    (use: ToolUse, focused: boolean, visible = true) => (
      <SelectedToolUse
        key={use.id}
        use={use}
        theme={activeTheme}
        fontSize={fontSize}
        projects={projects}
        onContextChange={(project, checkout) =>
          updateToolContext(use, project, checkout)
        }
        visible={visible}
        focused={focused}
        onAction={(action) => void runToolAction(action, use)}
        onCwdChange={(cwdPath) => observeTerminalCwd(use.id, cwdPath)}
        onTitleChange={(title) => updateRuntimeTitle(use, title, "terminal")}
      />
    ),
    [
      activeTheme,
      fontSize,
      observeTerminalCwd,
      projects,
      runToolAction,
      updateRuntimeTitle,
      updateToolContext,
    ],
  );

  const showMobileToolList = (use: ToolUse) => {
    const tabId = use.tabId ?? client.store.getSnapshot().activeTabId;
    const listUrl = toolSessionUrl(use.sessionId, tabId);
    if (history.state?.yaadeMobileTool === use.id) {
      history.back();
      return;
    }
    persistToolSessionRoute(listUrl, localStorage);
    history.replaceState(null, "", listUrl);
    setRouteRevision(revision => revision + 1);
  };

  const onPrefixHudSelect = (key: string) => {
    clearPrefix();
    if (isToolSessionJumpKey(key)) {
      runToolSessionCommand("tool.jump", Number(key) - 1);
      return;
    }
    const binding = matchToolSessionPrefixBinding(key);
    if (binding) runToolSessionCommand(binding.command);
  };

  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion features={loadMotionFeatures}>
      <TooltipProvider delayDuration={400} skipDelayDuration={200}>
        <LayoutGroup id="yaade-tool-session">
      <AmbientCanvas asChild>
      <div
        className="flex h-full min-h-0 flex-row overflow-hidden bg-transparent text-foreground"
        data-yaade-shell="tool-session"
        data-yaade-session-layout={appearanceSettings.sessionLayout}
        data-yaade-sidebars-state={sidebarsCollapsed ? "collapsed" : "expanded"}
        data-yaade-agent-sidebar-state={
          showAgentSidebar ? "expanded" : "collapsed"
        }
      >
        {!isMobile && hasRunningAgents ? (
          <MotionDiv
            initial={false}
            animate={{
              width: showAgentSidebar ? agentSidebarWidth : 0,
              opacity: showAgentSidebar ? 1 : 0,
            }}
            transition={yaadeMotion.sidebarTransition}
            className={cn(
              "relative h-full shrink-0 overflow-hidden",
              !showAgentSidebar && "pointer-events-none",
            )}
            aria-hidden={!showAgentSidebar || undefined}
            inert={!showAgentSidebar || undefined}
            data-yaade-running-agent-sidebar-state={
              showAgentSidebar ? "expanded" : "collapsed"
            }
          >
            <RunningAgentsSidebar
              agents={runningAgentItems}
              loading={runningAgents.loading}
              error={runningAgents.error}
              onSelectAgent={focusRunningAgent}
              className="w-full"
            />
            {showAgentSidebar ? (
              <SidebarResizeHandle
                value={agentSidebarWidth}
                min={AGENT_SIDEBAR_MIN_WIDTH}
                max={AGENT_SIDEBAR_MAX_WIDTH}
                side="left"
                label="Resize agent sidebar"
                onChange={setAgentSidebarWidth}
              />
            ) : null}
          </MotionDiv>
        ) : null}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Suspense fallback={<SessionBootState />}>
          <ToolDndRoot handlers={toolTabDnd}>
            {isMobile ? (
              <MobileToolView
                sessions={visibleSessions}
                usesById={snapshot.usesById}
                useIdsBySession={snapshot.useIdsBySession}
                routeToolUseId={parseToolSessionRoute(location.href).toolUseId}
                runtimeTitles={runtimeTitles}
                projects={projects}
                onAddProject={addKnownProject}
                onSelect={selectTool}
                onShowToolList={showMobileToolList}
                onCreateTool={(sessionId, kind) =>
                  createTool(kind, undefined, sessionId)
                }
                onCreateSession={createSession}
                onCloseSession={requestCloseSession}
                actionError={actionError}
                onCloseTool={use => runToolAction("archive", use)}
                onContextChange={updateToolContext}
                renderTool={renderTool}
              />
            ) : (
              <>
            {!sidebarLayout ? (
              <header
                className="flex h-[var(--yaade-tab-bar-height)] shrink-0 items-center gap-2 px-3"
                data-yaade-session-tabs=""
                data-yaade-top-tabbar=""
                data-yaade-electron-titlebar={desktopPlatform ? "" : undefined}
                data-yaade-electron-platform={desktopPlatform}
              >
                {hasRunningAgents ? (
                  <ShortcutTooltip
                    label={
                      agentSidebarCollapsed ? "Show sidebar" : "Hide sidebar"
                    }
                    shortcut={toolSessionShortcutFor("sidebar.toggle")}
                    side="bottom"
                  >
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label={
                        agentSidebarCollapsed ? "Show sidebar" : "Hide sidebar"
                      }
                      aria-pressed={!agentSidebarCollapsed}
                      onClick={toggleSidebars}
                      data-yaade-sidebar-toggle=""
                      data-yaade-agent-sidebar-toggle=""
                    >
                      {agentSidebarCollapsed ? (
                        <PanelLeftOpen />
                      ) : (
                        <PanelLeftClose />
                      )}
                    </Button>
                  </ShortcutTooltip>
                ) : null}
                <SessionSwitcher
                  open={switcherOpen}
                  onOpenChange={setSwitcherOpen}
                  sessions={visibleSessions}
                  activeSessionId={snapshot.activeSessionId}
                  onSelect={session => selectSession(session.id)}
                  onCreate={() => void createSession()}
                  onClose={requestCloseSession}
                  onRename={(id, title) => void renameSession(id, title)}
                  toolCounts={toolCounts}
                  className="max-w-52"
                />
                <SessionWindowTabStrip
                  tabs={visibleTabs}
                  activeTabId={activeTab?.id}
                  tabMeta={windowTabMeta}
                  onSelect={selectTab}
                  onCreate={() => void createTab()}
                  onClose={closeTab}
                  onRename={(id, title) => void renameTab(id, title)}
                  onReorder={ids => void reorderTabs(ids)}
                />
                <ShortcutTooltip
                  label="Settings"
                  shortcut={toolSessionDirectShortcutFor("settings.show")}
                  side="bottom"
                >
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label="Settings"
                    onClick={() => setSettingsOpen(true)}
                    data-yaade-session-settings=""
                    className="h-[var(--yaade-tab-pill-height)] shrink-0 gap-1.5 px-2 text-xs"
                  >
                    Settings
                    <Settings />
                  </Button>
                </ShortcutTooltip>
              </header>
            ) : null}
            <div
              className={cn(
                "relative min-h-0 flex-1",
                (twoSidebarLayout || singleSidebarLayout) &&
                  "grid max-md:flex max-md:flex-col yaade-tool-session-grid",
                !sidebarLayout && "flex flex-col",
              )}
              style={
                twoSidebarLayout
                  ? {
                      gridTemplateColumns: sidebarsCollapsed
                        ? "0rem minmax(0, 1fr) 0rem"
                        : `${appearanceSettings.sidebarWidth}px minmax(0, 1fr) ${appearanceSettings.sidebarWidth}px`,
                    }
                  : singleSidebarLayout
                    ? {
                        gridTemplateColumns: sidebarsCollapsed
                          ? "0rem minmax(0, 1fr)"
                          : `${appearanceSettings.sidebarWidth}px minmax(0, 1fr)`,
                      }
                    : undefined
              }
            >
              {twoSidebarLayout ? (
                <SessionTabStrip
                  sessions={visibleSessions}
                  activeSessionId={snapshot.activeSessionId}
                  layout="two-sidebars"
                  collapsed={sidebarsCollapsed}
                  sidebarOrientation={sidebarOrientation}
                  onSelect={selectSession}
                  onClose={requestCloseSession}
                  onOpenSettings={() => setSettingsOpen(true)}
                  onCreate={() => void createSession()}
                  onRename={(id, title) => void renameSession(id, title)}
                  onReorder={(ids) => void reorderSessions(ids)}
                />
              ) : singleSidebarLayout ? (
                <MotionAside
                  initial={false}
                  animate={{
                    opacity: sidebarsCollapsed ? 0 : 1,
                    x: sidebarsCollapsed ? -12 : 0,
                  }}
                  transition={yaadeMotion.sidebarTransition}
                  className={cn(
                    "flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground",
                    sidebarsCollapsed &&
                      "pointer-events-none max-md:hidden",
                    "max-md:h-auto max-md:w-full max-md:border-r-0 max-md:border-b",
                  )}
                  aria-label="Navigation"
                  aria-hidden={sidebarsCollapsed || undefined}
                  inert={sidebarsCollapsed || undefined}
                  data-yaade-single-sidebar=""
                  data-yaade-sidebar-state={
                    sidebarsCollapsed ? "collapsed" : "expanded"
                  }
                >
                  <SessionTabStrip
                    sessions={visibleSessions}
                    activeSessionId={snapshot.activeSessionId}
                    layout="single-sidebar"
                    collapsed={sidebarsCollapsed}
                    sidebarOrientation={sidebarOrientation}
                    onSelect={selectSession}
                    onClose={requestCloseSession}
                    onOpenSettings={() => setSettingsOpen(true)}
                    onCreate={() => void createSession()}
                    onRename={(id, title) => void renameSession(id, title)}
                    onReorder={(ids) => void reorderSessions(ids)}
                  />
                  <ToolUseTabStrip
                    useIds={useIds}
                    usesById={snapshot.usesById}
                    activeToolUseId={snapshot.activeToolUseId}
                    openToolUseIds={openToolUseIds}
                    runtimeTitles={runtimeTitles}
                    agentProvidersByToolUseId={agentProvidersByToolUseId}
                    projects={projects}
                    onAddProject={addKnownProject}
                    sessionTitlesById={sessionTitlesById}
                    sectionLabel="Tools"
                    emptyLabel="No tools yet"
                    layout="single-sidebar"
                    collapsed={sidebarsCollapsed}
                    sidebarOrientation={sidebarOrientation}
                    dockable
                    dockableUseIds={activeSessionUseIds}
                    onSelect={selectTool}
                    onContextChange={updateToolContext}
                    onAddKind={(kind) => void createTool(kind)}
                    onAddWithContext={(kind, project, checkout) =>
                      void createTool(kind, { project, checkout })
                    }
                    onClose={(use) => void runToolAction("archive", use)}
                    onRename={(use, title) => void renameToolUse(use, title)}
                    onReorder={(ids) => void reorderToolUses(ids)}
                    onToggleSidebar={toggleSidebars}
                  />
                </MotionAside>
              ) : null}
              {twoSidebarLayout && !sidebarsCollapsed ? (
                <SidebarResizeHandle
                  value={appearanceSettings.sidebarWidth}
                  min={MIN_SIDEBAR_WIDTH}
                  max={MAX_SIDEBAR_WIDTH}
                  side="left"
                  label="Resize session sidebar"
                  onChange={resizeSidebar}
                />
              ) : null}
              {singleSidebarLayout && !sidebarsCollapsed ? (
                <SidebarResizeHandle
                  value={appearanceSettings.sidebarWidth}
                  min={MIN_SIDEBAR_WIDTH}
                  max={MAX_SIDEBAR_WIDTH}
                  side="left"
                  label="Resize sidebar"
                  onChange={resizeSidebar}
                />
              ) : null}
              <main
                className={cn(
                  "relative flex min-w-0 min-h-0 flex-1 flex-col",
                  sidebarLayout && "col-start-2",
                )}
              >
                {sidebarLayout ? (
                  <SessionWindowTabStrip
                    tabs={visibleTabs}
                    activeTabId={activeTab?.id}
                    tabMeta={windowTabMeta}
                    onSelect={selectTab}
                    onCreate={() => void createTab()}
                    onClose={closeTab}
                    onRename={(id, title) => void renameTab(id, title)}
                    onReorder={ids => void reorderTabs(ids)}
                  />
                ) : null}
                {snapshot.connection === "reconciling" ||
                snapshot.connection === "offline" ? (
                  <Alert className="m-4">
                    <AlertTitle>
                      {snapshot.connection === "offline"
                        ? "Host offline"
                        : "Reconnecting"}
                    </AlertTitle>
                    <AlertDescription>
                      {snapshot.connection === "offline"
                        ? "Tool state will refresh when the host returns."
                        : "Reconciling session state without clearing current results."}
                    </AlertDescription>
                  </Alert>
                ) : null}
                {actionError ? (
                  <Alert variant="destructive" className="m-4">
                    <AlertTitle>Action failed</AlertTitle>
                    <AlertDescription>{actionError}</AlertDescription>
                  </Alert>
                ) : null}
                {sidebarLayout && sidebarsCollapsed ? (
                  <SidebarHoverToggle
                    side="left"
                    collapsed
                    onToggle={toggleSidebars}
                  />
                ) : null}
                {twoSidebarLayout && sidebarsCollapsed ? (
                  <SidebarHoverToggle
                    side="right"
                    collapsed
                    onToggle={toggleSidebars}
                  />
                ) : null}
                <div className="min-h-0 flex-1">
                  {snapshot.connection === "connecting" &&
                  visibleSessions.length === 0 ? (
                    <SessionBootState />
                  ) : activeSession && activeTab ? (
                    <ToolTilingWorkspace
                      workspace={activeToolWorkspace}
                    usesById={snapshot.usesById}
                    runtimeTitles={runtimeTitles}
                    agentProvidersByToolUseId={agentProvidersByToolUseId}
                    projects={projects}
                    onAddProject={addKnownProject}
                    onContextChange={updateToolContext}
                    onPanelEvent={handleToolPanelEvent}
                    onFocusPanel={focusWorkspacePanel}
                    onAddSplitTool={addToolToSplitPanel}
                    onSplit={splitToolPanelAt}
                    onZoom={zoomToolPanel}
                    onCloseView={closeWorkspacePane}
                    onChromeOverlayChange={setPaneChromeOverlayOpen}
                    renderTool={renderTool}
                  />
                  ) : null}
                </div>
                {prefixPending ? (
                  <PrefixHud
                    showSidebarToggle={!isMobile && hasRunningAgents}
                    onSelect={onPrefixHudSelect}
                  />
                ) : null}
              </main>
              {twoSidebarLayout ? (
                <div
                  className={
                    twoSidebarLayout
                      ? "relative col-start-3 min-h-0 min-w-0"
                      : "relative shrink-0"
                  }
                >
                  <ToolUseTabStrip
                    useIds={useIds}
                    usesById={snapshot.usesById}
                    activeToolUseId={snapshot.activeToolUseId}
                    openToolUseIds={openToolUseIds}
                    runtimeTitles={runtimeTitles}
                    agentProvidersByToolUseId={agentProvidersByToolUseId}
                    projects={projects}
                    onAddProject={addKnownProject}
                    sessionTitlesById={sessionTitlesById}
                    sectionLabel="Tools"
                    emptyLabel="No tools yet"
                    layout={twoSidebarLayout ? "two-sidebars" : "tabs"}
                    collapsed={twoSidebarLayout ? sidebarsCollapsed : false}
                    sidebarOrientation={sidebarOrientation}
                    dockable
                    dockableUseIds={activeSessionUseIds}
                    onSelect={selectTool}
                    onContextChange={updateToolContext}
                    onAddKind={(kind) => void createTool(kind)}
                    onAddWithContext={(kind, project, checkout) =>
                      void createTool(kind, { project, checkout })
                    }
                    onClose={(use) => void runToolAction("archive", use)}
                    onRename={(use, title) => void renameToolUse(use, title)}
                    onReorder={(ids) => void reorderToolUses(ids)}
                    onToggleSidebar={twoSidebarLayout ? toggleSidebars : undefined}
                  />
                </div>
              ) : null}
              {twoSidebarLayout && !sidebarsCollapsed ? (
                <SidebarResizeHandle
                  value={appearanceSettings.sidebarWidth}
                  min={MIN_SIDEBAR_WIDTH}
                  max={MAX_SIDEBAR_WIDTH}
                  side="right"
                  label="Resize tool sidebar"
                  onChange={resizeSidebar}
                />
              ) : null}
            </div>
              </>
            )}
          </ToolDndRoot>
        </Suspense>
        {toolUseSwitcherOpen ? (
          <Suspense fallback={null}>
            <ToolUseSwitcher
              open
              onOpenChange={setToolUseSwitcherOpen}
              sessionsById={snapshot.sessionsById}
              usesById={snapshot.usesById}
              activeToolUseId={snapshot.activeToolUseId}
              runtimeTitles={runtimeTitles}
              onSelect={selectTool}
            />
          </Suspense>
        ) : null}
        {settingsOpen ? (
          <Suspense fallback={null}>
            <SettingsOverlay
              open
              onOpenChange={setSettingsOpen}
              settings={appearanceSettings}
              onSettingsChange={setAppearanceSettings}
              themes={bundledThemeList}
              onReset={resetAppearanceSettings}
            />
          </Suspense>
        ) : null}
        <CloseSessionDialog
          sessionId={closeChoice?.sessionId}
          onCancel={() => setCloseChoice(undefined)}
          onClose={(mode) =>
            closeChoice
              ? void closeSession(closeChoice.sessionId, mode)
              : undefined
          }
        />
        <ProjectDiscoveryPrompt
          path={projectCandidate?.path ?? null}
          pending={addingProjectPath === projectCandidate?.path}
          onAdd={() => void addProjectCandidate()}
          onDismiss={dismissProjectCandidate}
        />
        </div>
      </div>
      </AmbientCanvas>
        </LayoutGroup>
      </TooltipProvider>
      </LazyMotion>
    </MotionConfig>
  );
}

function ProjectDiscoveryPrompt(props: {
  readonly path: string | null;
  readonly pending: boolean;
  readonly onAdd: () => void;
  readonly onDismiss: () => void;
}) {
  return (
    <AnimatePresence initial={false}>
      {props.path ? (
        <MotionDiv
          key={props.path}
          initial={{ opacity: 0, y: 8, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 6, scale: 0.98 }}
          transition={yaadeMotion.overlayTransition}
          className="pointer-events-none fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-50 flex justify-center"
          aria-live="polite"
          data-yaade-project-discovery-prompt=""
        >
          <div className="pointer-events-auto flex w-full max-w-xl items-center gap-3 rounded-[var(--yaade-island-radius)] border border-border bg-popover/95 px-3 py-2 text-popover-foreground shadow-xl backdrop-blur-xl">
            <FolderPlus className="size-4 shrink-0 text-primary" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium">Remember this folder?</p>
              <p className="truncate font-mono text-2xs text-muted-foreground">
                {props.path}
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={props.onDismiss}
              disabled={props.pending}
            >
              Not now
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={props.onAdd}
              disabled={props.pending}
              data-yaade-add-discovered-project=""
            >
              {props.pending ? (
                <Spinner />
              ) : (
                <FolderPlus data-icon="inline-start" />
              )}
              {props.pending ? "Adding…" : "Add project"}
            </Button>
          </div>
        </MotionDiv>
      ) : null}
    </AnimatePresence>
  );
}

function SidebarHoverToggle(props: {
  readonly side: "left" | "right";
  readonly collapsed: boolean;
  readonly onToggle: () => void;
}) {
  const left = props.side === "left";
  const Icon = left
    ? props.collapsed
      ? PanelLeftOpen
      : PanelLeftClose
    : props.collapsed
      ? PanelRightOpen
      : PanelRightClose;
  const label = `${props.collapsed ? "Show" : "Hide"} sidebars`;
  return (
    <div
      className={cn(
        "group/sidebar-toggle absolute top-2 z-30 flex h-10 w-9 items-start",
        left ? "left-0 justify-start pl-1" : "right-0 justify-end pr-1",
      )}
      data-yaade-sidebar-hover-zone={props.side}
    >
      <Button
        type="button"
        size="icon-sm"
        variant="secondary"
        aria-label={label}
        title={label}
        data-yaade-sidebar-hover-toggle={props.side}
        className="opacity-0 shadow-sm transition-opacity duration-[var(--yaade-motion-fast)] group-hover/sidebar-toggle:opacity-100 focus-visible:opacity-100"
        onClick={props.onToggle}
      >
        <Icon />
      </Button>
    </div>
  );
}

const lazyRenderers = new Map<
  ToolKind,
  ComponentType<import("./tool-registry.js").ToolRendererProps>
>();

function rendererFor(
  kind: ToolKind,
): ComponentType<import("./tool-registry.js").ToolRendererProps> | null {
  const existing = lazyRenderers.get(kind);
  if (existing) return existing;
  // Unknown tool kinds should keep a usable pane instead of rendering blank.
  const entry = toolRegistry.get(kind) ?? toolRegistry.get("terminal");
  if (!entry) return null;
  const Lazy = lazy(entry.loadRenderer);
  lazyRenderers.set(kind, Lazy);
  return Lazy;
}

function SelectedToolUse(props: {
  use: ToolUse;
  theme: YaadeTheme;
  fontSize: number;
  projects: readonly ProjectTarget[];
  visible?: boolean;
  focused?: boolean;
  onAction: (action: "cancel" | "restart" | "archive") => void;
  onCwdChange: (cwdPath: string) => void;
  onContextChange: (
    project: ProjectTarget,
    checkout: CheckoutTarget,
  ) => Promise<void>;
  onTitleChange: (title: string) => void;
}) {
  const { use } = props;
  const Renderer = rendererFor(use.kind);
  if (!Renderer) return null;
  return (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          Opening tool…
        </div>
      }
    >
      <Renderer
        use={use}
        theme={props.theme}
        fontSize={props.fontSize}
        projects={props.projects}
        onContextChange={props.onContextChange}
        onCwdChange={props.onCwdChange}
        onTitleChange={props.onTitleChange}
        onAction={props.onAction}
        visible={props.visible}
        focused={props.focused}
      />
    </Suspense>
  );
}

function CloseSessionDialog(props: {
  sessionId?: SessionId;
  onCancel: () => void;
  onClose: (mode: "keep-running" | "stop-tools") => void;
}) {
  return (
    <Dialog
      open={Boolean(props.sessionId)}
      onOpenChange={(open) => {
        if (!open) props.onCancel();
      }}
    >
      <DialogContent size="picker">
        <DialogHeader>
          <DialogTitle>Close session?</DialogTitle>
          <DialogDescription>
            Live tools can keep running after this session is archived.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-wrap">
          <Button variant="outline" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button
            variant="outline"
            className="h-auto min-h-8 min-w-0 max-w-full whitespace-normal text-center leading-normal"
            onClick={() => props.onClose("keep-running")}
          >
            Keep running and archive
          </Button>
          <Button
            variant="destructive"
            className="h-auto min-h-8 min-w-0 max-w-full whitespace-normal text-center leading-normal"
            onClick={() => props.onClose("stop-tools")}
          >
            Stop tools and archive
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
