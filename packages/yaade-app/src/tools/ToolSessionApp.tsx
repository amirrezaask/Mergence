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
import { LayoutGroup, LazyMotion, MotionConfig } from "motion/react";
import { aside as MotionAside } from "motion/react-m";
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
import { MainCheckout } from "@yaade/rpc";
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
  Settings,
} from "lucide-react";
import {
  AmbientCanvas,
  GlassSurface,
  WhichKeyPanel,
  cn,
  useIsMobile,
  yaadeMotion,
  type TabDndHandlers,
} from "@yaade/ui";
import {
  CHORD_TIMEOUT_MS,
  keyEventMatchesBinding,
  keyEventMatchesChordSecond,
} from "@yaade/workspace";
import { bundledThemeList } from "@yaade/ui/appearance";
import { toolRegistry } from "./tool-registry.js";
import {
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  useAppearanceSettings,
} from "../hooks/useAppearanceSettings.js";
import { createToolClient, type ToolClient } from "./tool-client.js";
import {
  chooseSession,
  chooseTab,
  chooseToolUse,
  parseToolSessionRoute,
  toolSessionUrl,
} from "./tool-session-routing.js";
import type { ToolContextSelection } from "./ToolContextControls.js";
import { SessionTabStrip } from "./SessionTabStrip.js";
import { SessionWindowTabStrip } from "./SessionWindowTabStrip.js";
import { SessionSwitcher } from "./SessionSwitcher.js";
import { ShortcutTooltip } from "./ShortcutTooltip.js";
import { ToolUseTabStrip } from "./ToolUseTabStrip.js";
import { SidebarResizeHandle } from "./SidebarResizeHandle.js";
import { ToolUseSwitcher } from "./ToolUseSwitcher.js";
import { nextRuntimeToolTitle, type RuntimeToolTitle } from "./tool-title.js";
import { SessionEmptyState, SessionBootState } from "./SessionEmptyState.js";
import {
  MAX_TOOL_TILES,
  closeToolPanel,
  createToolWorkspace,
  dockToolView,
  focusToolPanel,
  openToolView,
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
import { toolSessionDirectShortcutFor } from "./tool-session-keymap.js";
import {
  TOOL_SESSION_PREFIX,
  TOOL_SESSION_PREFIX_GROUPS,
  isToolSessionJumpKey,
  matchToolSessionContextBinding,
  matchToolSessionDirectBinding,
  matchToolSessionPrefixBinding,
  prefixLiteralByte,
  serializeToolSessionPrefixKey,
  toolSessionHudBindings,
} from "../keybindings.js";

const SettingsOverlay = lazy(() => import("@yaade/ui/settings"));
const MobileToolView = lazy(() =>
  import("./MobileToolView.js").then(({ MobileToolView: View }) => ({
    default: View,
  })),
);
const ToolDndRoot = lazy(() => import("./ToolDndRoot.js"));
const ToolTilingWorkspace = lazy(() => import("./ToolTilingWorkspace.js"));
const loadMotionFeatures = () => import("motion/react").then(({ domMax }) => domMax);
const EMPTY_TOOL_USE_IDS: readonly ToolUseId[] = [];
const EMPTY_TAB_IDS: readonly SessionTabId[] = [];

type CloseChoice = { readonly sessionId: SessionId } | undefined;

function isLive(use: ToolUse): boolean {
  return (
    use.status === "created" ||
    use.status === "starting" ||
    use.status === "running" ||
    use.status === "waiting"
  );
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
  const [closeChoice, setCloseChoice] = useState<CloseChoice>();
  const [actionError, setActionError] = useState<string | undefined>();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [toolUseSwitcherOpen, setToolUseSwitcherOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [routeRevision, setRouteRevision] = useState(0);
  const [toolWorkspaces, setToolWorkspaces] = useState<
    ReadonlyMap<SessionTabId, ToolWorkspace>
  >(() => new Map());
  const [prefixPending, setPrefixPending] = useState(false);
  const [runtimeTitles, setRuntimeTitles] = useState<
    ReadonlyMap<ToolUseId, RuntimeToolTitle>
  >(() => new Map());
  const prefixPendingRef = useRef(false);
  const toolUsesRef = useRef(snapshot.usesById);
  const isMobile = useIsMobile();
  toolUsesRef.current = snapshot.usesById;

  useEffect(() => {
    prefixPendingRef.current = prefixPending;
  }, [prefixPending]);

  useEffect(() => {
    if (!prefixPending) return;
    const timeout = window.setTimeout(() => {
      prefixPendingRef.current = false;
      setPrefixPending(false);
    }, CHORD_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [prefixPending]);

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
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const onPopState = () => setRouteRevision(revision => revision + 1);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const route = parseToolSessionRoute(location.href);
    const session = chooseSession(route.sessionId, [
      ...snapshot.sessionsById.values(),
    ]);
    if (!session) return;
    const tabs = snapshot.visibleTabIdsBySession.get(session.id) ?? [];
    const tab = chooseTab(
      route.tabId,
      session,
      tabs.map(id => snapshot.tabsById.get(id)).filter((value): value is SessionTab => Boolean(value)),
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
    if (location.href !== new URL(url, location.origin).href)
      history.replaceState(null, "", url);
  }, [
    client,
    snapshot.activeSessionId,
    snapshot.activeTabId,
    snapshot.activeToolUseId,
    snapshot.sessionsById,
    snapshot.tabsById,
    snapshot.visibleTabIdsBySession,
    snapshot.useIdsByTab,
    routeRevision,
    isMobile,
  ]);

  const visibleSessions = snapshot.visibleSessionIds
    .map((id) => snapshot.sessionsById.get(id))
    .filter((session): session is NonNullable<typeof session> =>
      Boolean(session),
    );
  const activeSession = snapshot.activeSessionId
    ? snapshot.sessionsById.get(snapshot.activeSessionId)
    : undefined;
  const activeTab = snapshot.activeTabId
    ? snapshot.tabsById.get(snapshot.activeTabId)
    : undefined;
  const tabIds = activeSession
    ? (snapshot.visibleTabIdsBySession.get(activeSession.id) ?? EMPTY_TAB_IDS)
    : EMPTY_TAB_IDS;
  const visibleTabs = tabIds
    .map(id => snapshot.tabsById.get(id))
    .filter((tab): tab is SessionTab => Boolean(tab));
  const activeTabToolIds = activeTab
    ? (snapshot.useIdsByTab.get(activeTab.id) ?? EMPTY_TOOL_USE_IDS)
    : EMPTY_TOOL_USE_IDS;
  const useIds = activeTabToolIds;
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
  const sidebarOrientation = isMobile ? "horizontal" : "vertical";

  const toggleSidebars = useCallback(() => {
    if (!sidebarLayout) return;
    setAppearanceSettings((previous) => ({
      ...previous,
      sidebarCollapsed: !previous.sidebarCollapsed,
    }));
  }, [setAppearanceSettings, sidebarLayout]);

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

  const openToolInWorkspace = useCallback(
    (use: ToolUse) => {
      const tabId = use.tabId ?? activeTab?.id;
      if (!tabId) return;
      updateToolWorkspace(tabId, (workspace) =>
        openToolView(workspace, use.id),
      );
    },
    [activeTab?.id, updateToolWorkspace],
  );

  const selectSession = useCallback(
    (id: SessionId) => {
      markPerformance("yaade:session-switch");
      client.store.selectSession(id);
      const session = client.store.getSnapshot().sessionsById.get(id);
      const nextTab = session?.activeTabId
        ? client.store.getSnapshot().tabsById.get(session.activeTabId)
        : undefined;
      history.pushState(
        null,
        "",
        session ? toolSessionUrl(session.id, nextTab?.id, nextTab?.activeToolUseId) : "/",
      );
    },
    [client],
  );

  const selectTool = useCallback(
    (use: ToolUse) => {
      markPerformance("yaade:tool-switch");
      openToolInWorkspace(use);
      const current = client.store.getSnapshot().activeToolUseId;
      client.store.selectToolUse(use.id);
      const tabId = use.tabId ?? client.store.getSnapshot().activeTabId;
      const request = window.yaade?.tools?.selectUse?.(use.sessionId, use.id);
      if (request) void request.catch(error => setActionError(errorMessage(error)));
      const nextUrl = toolSessionUrl(use.sessionId, tabId, use.id);
      if (
        current !== use.id ||
        location.href !== new URL(nextUrl, location.origin).href
      ) {
        history.pushState({ yaadeMobileTool: use.id }, "", nextUrl);
      }
    },
    [client, openToolInWorkspace],
  );

  const lastAutoOpenedToolRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!selected) return;
    const key = `${selected.sessionId}:${selected.id}`;
    if (lastAutoOpenedToolRef.current === key) return;
    lastAutoOpenedToolRef.current = key;
    openToolInWorkspace(selected);
  }, [openToolInWorkspace, selected]);

  useEffect(() => {
    if (!activeTab) return;
    const liveIds = new Set(useIds);
    updateToolWorkspace(activeTab.id, (workspace) =>
      removeMissingToolViews(workspace, liveIds),
    );
  }, [activeTab, updateToolWorkspace, useIds]);

  const createTool = useCallback(
    async (
      nextKind: ToolKind = "terminal",
      launchContext?: ToolContextSelection,
      targetSessionId?: SessionId,
    ): Promise<ToolUse | undefined> => {
      const currentSnapshot = client.store.getSnapshot();
      const targetSession = targetSessionId
        ? currentSnapshot.sessionsById.get(targetSessionId)
        : activeSession;
      const targetTabIds = targetSession
        ? currentSnapshot.visibleTabIdsBySession.get(targetSession.id) ?? EMPTY_TAB_IDS
        : EMPTY_TAB_IDS;
      const preferredTabId = targetSession?.activeTabId ?? targetTabIds[0];
      const targetTab = preferredTabId
        ? currentSnapshot.tabsById.get(preferredTabId)
        : undefined;
      if (!targetSession || !targetTab) return undefined;
      const targetUseIds =
        currentSnapshot.useIdsByTab.get(targetTab.id) ?? EMPTY_TOOL_USE_IDS;
      setActionError(undefined);
      try {
        let nextProjects = projects;
        if (nextProjects.length === 0) {
          nextProjects = (await window.yaade?.tools?.listProjects?.()) ?? [];
          setProjects(nextProjects);
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
        const currentWorkspace =
          toolWorkspaces.get(targetTab.id) ??
          restoreToolWorkspace(targetTab.layoutJson, targetUseIds);
        let hasEmptyPane = false;
        currentWorkspace.tree.visitLeaves(leaf => {
          if (leaf.view.kind === "empty") hasEmptyPane = true;
        });
        let destinationTab = targetTab;
        let rollbackTab: SessionTab | undefined;
        if (
          toolPaneCount(currentWorkspace) >= MAX_TOOL_TILES &&
          !hasEmptyPane
        ) {
          const createdTab = await window.yaade?.tools?.createTab?.({
            _tag: "CreateSessionTab",
            sessionId: targetSession.id,
            title: `Window ${targetTabIds.length + 1}`,
          });
          if (!createdTab) throw new Error("Could not create another Window.");
          destinationTab = createdTab;
          rollbackTab = createdTab;
        }
        const command: CreateToolUse = {
          _tag: "CreateToolUse",
          sessionId: targetSession.id,
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
          await client.reconcileSession(targetSession.id);
          if (created) selectTool(created);
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
        setActionError(errorMessage(error));
        return undefined;
      }
    },
    [activeSession, client, projects, selectTool, toolWorkspaces],
  );

  const selectTab = useCallback(
    (tab: SessionTab) => {
      markPerformance("yaade:tab-switch");
      client.store.selectTab(tab.id);
      const session = client.store.getSnapshot().sessionsById.get(tab.sessionId);
      const nextUse = client.store.getSnapshot().activeToolUseId;
      if (session) history.pushState(null, "", toolSessionUrl(session.id, tab.id, nextUse));
      const request = window.yaade?.tools?.selectTab?.({
        _tag: "SelectSessionTab",
        sessionId: tab.sessionId,
        tabId: tab.id,
      });
      if (request) void request.catch(error => setActionError(errorMessage(error)));
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
    try {
      await window.yaade?.tools?.archiveTab?.({
        _tag: "ArchiveSessionTab",
        tabId: tab.id,
        mode: "stop-tools",
      });
      await client.reconcileSession(tab.sessionId);
    } catch (error) {
      setActionError(errorMessage(error));
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
    prefixPendingRef.current = false;
    setPrefixPending(false);
  }, []);

  const runPrefixCommand = useCallback(
    (command: string, jumpIndex = 0) => {
      if (command === "session.new") void createSession();
      if (command === "tab.new") void createTab();
      if (command === "tab.next" || command === "tab.previous") {
        if (!activeTab || tabIds.length === 0) return;
        const index = tabIds.indexOf(activeTab.id);
        const nextIndex = command === "tab.next"
          ? (index + 1) % tabIds.length
          : (index - 1 + tabIds.length) % tabIds.length;
        const next = snapshot.tabsById.get(tabIds[nextIndex]!);
        if (next) selectTab(next);
      }
      if (command === "tool.newTerminal") void createTool("terminal");
      if (command === "tool.newGit") void createTool("git");
      if (command === "session.switch") setSwitcherOpen(true);
      if (command === "tool.switch") setToolUseSwitcherOpen(true);
      if (command === "tool.next" || command === "tool.previous") {
        if (!selected || useIds.length === 0) return;
        const index = useIds.indexOf(selected.id);
        const nextIndex =
          command === "tool.next"
            ? (index + 1) % useIds.length
            : (index - 1 + useIds.length) % useIds.length;
        const next = snapshot.usesById.get(useIds[nextIndex]!);
        if (next) selectTool(next);
      }
      if (command === "tool.jump") {
        const id = useIds[jumpIndex];
        if (!id) return;
        const next = snapshot.usesById.get(id);
        if (next) selectTool(next);
      }
      if (command === "tool.close" && selected)
        void runToolAction("archive", selected);
      if (command === "session.close" && activeSession)
        requestCloseSession(activeSession.id);
      if (command === "pane.zoom" && activeTab)
        updateToolWorkspace(activeTab.id, workspace =>
          toggleToolPanelZoom(workspace, workspace.focusedPanelId),
        );
      if (command === "settings.show") setSettingsOpen(true);
    },
    [
      activeSession,
      activeTab,
      createSession,
      createTab,
      createTool,
      requestCloseSession,
      runToolAction,
      selectTab,
      selectTool,
      selected,
      snapshot.tabsById,
      snapshot.usesById,
      toggleSidebars,
      updateToolWorkspace,
      useIds,
    ],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (switcherOpen || toolUseSwitcherOpen || settingsOpen || closeChoice)
        return;
      if (!prefixPendingRef.current) {
        const direct = matchToolSessionDirectBinding(event);
        if (direct) {
          event.preventDefault();
          event.stopPropagation();
          runPrefixCommand(direct.command);
          return;
        }
        const context = matchToolSessionContextBinding(event, selected?.kind);
        if (context) {
          event.preventDefault();
          event.stopPropagation();
          runPrefixCommand(context.command);
          return;
        }
      }

      const target = event.target instanceof HTMLElement ? event.target : null;
      const inEditable = Boolean(
        target?.closest("input, textarea, [contenteditable=true]"),
      );
      const inTerminal = Boolean(
        target?.closest(
          "[data-ghostty-terminal-input], [data-ghostty-terminal-canvas]",
        ),
      );
      const activeWorkspaceZoomed = Boolean(
        activeSession &&
          activeTab ? toolWorkspaces.get(activeTab.id)?.zoomedPanelId : undefined,
      );
      if (
        event.key === "Escape" &&
        activeWorkspaceZoomed &&
        !inEditable &&
        !inTerminal
      ) {
        event.preventDefault();
        event.stopPropagation();
        runPrefixCommand("pane.zoom");
        return;
      }
      const inPrefixButton = Boolean(
        target?.closest("[data-yaade-which-key-item]"),
      );
      if (
        prefixPendingRef.current &&
        (event.key === "Tab" ||
          (inPrefixButton && (event.key === "Enter" || event.key === " ")))
      ) {
        return;
      }
      if (!prefixPendingRef.current && inEditable && !inTerminal) return;

      if (
        !prefixPendingRef.current &&
        keyEventMatchesBinding(event, TOOL_SESSION_PREFIX)
      ) {
        event.preventDefault();
        event.stopPropagation();
        prefixPendingRef.current = true;
        setPrefixPending(true);
        return;
      }

      if (!prefixPendingRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      clearPrefix();
      if (event.key === "Escape") return;
      if (
        keyEventMatchesChordSecond(
          event,
          `${TOOL_SESSION_PREFIX} k`,
          TOOL_SESSION_PREFIX,
        ) &&
        inTerminal
      ) {
        const byte = prefixLiteralByte(TOOL_SESSION_PREFIX);
        if (byte) {
          void window.yaade?.terminal?.write?.(
            selected?.output.kind === "process"
              ? (selected.output.ptyId ?? "")
              : "",
            byte,
          );
        }
        return;
      }
      const key = serializeToolSessionPrefixKey(event);
      if (isToolSessionJumpKey(key)) {
        runPrefixCommand("tool.jump", Number(key) - 1);
        return;
      }
      const binding = matchToolSessionPrefixBinding(key);
      if (!binding) return;
      runPrefixCommand(binding.command);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    clearPrefix,
    closeChoice,
    runPrefixCommand,
    activeSession,
    clearPrefix,
    closeChoice,
    runPrefixCommand,
    selected,
    settingsOpen,
    switcherOpen,
    toolUseSwitcherOpen,
    toolWorkspaces,
  ]);

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

  useEffect(() => {
    if (!activeTab) return;
    const workspace = toolWorkspaces.get(activeTab.id);
    if (!workspace) return;
    const layoutJson = serializeToolWorkspace(workspace);
    if (layoutJson === activeTab.layoutJson) return;
    const handle = window.setTimeout(() => {
      const request = window.yaade?.tools?.saveTabLayout?.({
        _tag: "SaveSessionTabLayout",
        tabId: activeTab.id,
        layoutJson,
      });
      if (!request) return;
      void request
        .then(tab => client.store.replaceTab(tab))
        .catch(error => setActionError(errorMessage(error)));
    }, 350);
    return () => window.clearTimeout(handle);
  }, [activeTab, client, toolWorkspaces]);

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
      history.replaceState(null, "", toolSessionUrl(use.sessionId, use.tabId, use.id));
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

  const renderTool = (
    use: ToolUse,
    focused: boolean,
    visible = true,
  ) => (
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
      onTitleChange={(title) => updateRuntimeTitle(use, title, "terminal")}
    />
  );

  const showMobileToolList = (use: ToolUse) => {
    const tabId = use.tabId ?? client.store.getSnapshot().activeTabId;
    const listUrl = toolSessionUrl(use.sessionId, tabId);
    if (history.state?.yaadeMobileTool === use.id) {
      history.back();
      return;
    }
    history.replaceState(null, "", listUrl);
    setRouteRevision(revision => revision + 1);
  };

  const renderPrefixHud = () =>
    prefixPending ? (
      <div className="pointer-events-none absolute inset-x-0 bottom-2 z-20 flex justify-center px-2">
        <div className="pointer-events-auto w-full max-w-4xl">
          <WhichKeyPanel
            variant="overlay"
            prefix={TOOL_SESSION_PREFIX}
            groups={TOOL_SESSION_PREFIX_GROUPS}
            entries={toolSessionHudBindings()
              .filter(
                (binding) =>
                  sidebarLayout || binding.command !== "sidebar.toggle",
              )
              .map((binding) => ({
                key: binding.key,
                desc: binding.desc,
                group: binding.group,
              }))}
            onSelect={(key) => {
              clearPrefix();
              if (isToolSessionJumpKey(key)) {
                runPrefixCommand("tool.jump", Number(key) - 1);
                return;
              }
              const binding = matchToolSessionPrefixBinding(key);
              if (binding) runPrefixCommand(binding.command);
            }}
          />
        </div>
      </div>
    ) : null;

  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion features={loadMotionFeatures}>
      <TooltipProvider delayDuration={400} skipDelayDuration={200}>
        <LayoutGroup id="yaade-tool-session">
      <AmbientCanvas asChild>
      <div
        className="flex h-full min-h-0 flex-col bg-transparent text-foreground"
        data-yaade-shell="tool-session"
        data-yaade-session-layout={appearanceSettings.sessionLayout}
        data-yaade-sidebars-state={sidebarsCollapsed ? "collapsed" : "expanded"}
      >
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
                renderTool={(use, visible, focused) =>
                  renderTool(use, focused, visible)
                }
              />
            ) : (
              <>
            {!sidebarLayout ? (
              <GlassSurface material="shell" asChild>
              <header
                className="flex h-10 shrink-0 items-center gap-0 border-b border-border/80 bg-transparent px-1.5"
                data-yaade-session-tabs=""
                data-yaade-top-tabbar=""
              >
                <ShortcutTooltip
                  label="Settings"
                  shortcut={toolSessionDirectShortcutFor("settings.show")}
                  side="bottom"
                >
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Open settings"
                    onClick={() => setSettingsOpen(true)}
                    data-yaade-session-settings=""
                  >
                    <Settings />
                  </Button>
                </ShortcutTooltip>
                <SessionSwitcher
                  open={switcherOpen}
                  onOpenChange={setSwitcherOpen}
                  sessions={visibleSessions}
                  activeSessionId={snapshot.activeSessionId}
                  onSelect={(session) => selectSession(session.id)}
                  onCreate={() => void createSession()}
                  onClose={requestCloseSession}
                  onRename={(id, title) => void renameSession(id, title)}
                  toolCounts={toolCounts}
                />
                <SessionWindowTabStrip
                  tabs={visibleTabs}
                  activeTabId={activeTab?.id}
                  onSelect={selectTab}
                  onCreate={() => void createTab()}
                  onClose={closeTab}
                  onRename={(id, title) => void renameTab(id, title)}
                  onReorder={ids => void reorderTabs(ids)}
                />
              </header>
              </GlassSurface>
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
                    projects={projects}
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
                    projects={projects}
                    onContextChange={updateToolContext}
                    tabDnd={toolTabDnd}
                    onPanelEvent={handleToolPanelEvent}
                    onFocusPanel={focusWorkspacePanel}
                    onAddTool={(panelId, kind) => {
                      focusWorkspacePanel(panelId);
                      void createTool(kind);
                    }}
                    onSplit={(panelId, edge) =>
                      updateToolWorkspace(activeTab.id, (workspace) =>
                        splitToolPanel(workspace, panelId, edge),
                      )
                    }
                    onZoom={(panelId) =>
                      updateToolWorkspace(activeTab.id, (workspace) =>
                        toggleToolPanelZoom(workspace, panelId),
                      )
                    }
                    onCloseView={closeWorkspacePane}
                    empty={
                      <SessionEmptyState
                        onAddKind={(kind) => void createTool(kind)}
                      />
                    }
                    renderTool={renderTool}
                  />
                  ) : (
                    <SessionEmptyState
                      onAddKind={(kind) => void createTool(kind)}
                    />
                  )}
                </div>
                {renderPrefixHud()}
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
                    projects={projects}
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
        <ToolUseSwitcher
          open={toolUseSwitcherOpen}
          onOpenChange={setToolUseSwitcherOpen}
          sessionsById={snapshot.sessionsById}
          usesById={snapshot.usesById}
          activeToolUseId={snapshot.activeToolUseId}
          runtimeTitles={runtimeTitles}
          onSelect={selectTool}
        />
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
      </div>
      </AmbientCanvas>
        </LayoutGroup>
      </TooltipProvider>
      </LazyMotion>
    </MotionConfig>
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
  const entry = toolRegistry.get(kind);
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
        toolbar={null}
        projects={props.projects}
        onContextChange={props.onContextChange}
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
