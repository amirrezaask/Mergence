import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  lazy,
} from "react";
import { LayoutGroup, LazyMotion, MotionConfig } from "motion/react";
import { aside as MotionAside } from "motion/react-m";
import type {
  CreateTerminal,
  SessionId,
  SessionTab,
  SessionTabId,
  TerminalKind,
  MuxTerminal,
  MuxTerminalId,
  TerminalInput,
} from "@yaade/rpc";
import { SessionTabConflict } from "@yaade/rpc";
import type { DropAction, PanelId } from "@yaade/shared";
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
  Terminal as TerminalIcon,
} from "lucide-react";
import {
  AmbientCanvas,
  WhichKeyPanel,
  cn,
  useIsMobile,
  yaadeMotion,
  type TabDndHandlers,
} from "@yaade/ui/session";
import { focusRegisteredTerminal } from "@yaade/ui/terminal-registry";
import { CHORD_TIMEOUT_MS } from "@yaade/workspace";
import { bundledThemeList } from "@yaade/ui/appearance";
import type { ProcessTerminalViewProps } from "./renderers/TerminalView.js";
import {
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  useAppearanceSettings,
} from "../hooks/useAppearanceSettings.js";

import { createTerminalClient, type MuxClient } from "./mux-client.js";
import { useHostPorts } from "../host-ports.js";
import { useServerConnections } from "../server-connections.js";
import {
  chooseSession,
  chooseTab,
  chooseMuxTerminal,
  isLiveSessionTab,
  persistMuxSessionRoute,
  parseMuxSessionRoute,
  resolveMuxSessionRoute,
  sameLocalResource,
  shouldHoldRequestedRoute,
  muxSessionUrl,
} from "./mux-routing.js";
import { SessionTabStrip } from "./SessionTabStrip.js";
import { SessionWindowTabStrip } from "./SessionWindowTabStrip.js";
import { SessionSwitcher } from "./SessionSwitcher.js";
import { ShortcutTooltip } from "./ShortcutTooltip.js";
import { TerminalTabStrip } from "./TerminalTabStrip.js";
import { SidebarResizeHandle } from "./SidebarResizeHandle.js";
import { nextRuntimeTerminalTitle, type RuntimeTerminalTitle } from "./terminal-title.js";
import { SessionLoadingState } from "./SessionEmptyState.js";
import {
  MAX_TERMINAL_TILES,
  closeTerminalPanel,
  createTerminalWorkspace,
  dockTerminalView,
  focusTerminalPanel,
  openTerminalView,
  openTerminalViewInPanel,
  removeMissingTerminalViews,
  reorderTerminalTabs,
  resizeTerminalSplit,
  restoreTerminalWorkspace,
  serializeTerminalWorkspace,
  splitTerminalPanel,
  toggleTerminalPanelZoom,
  terminalIdsInWorkspace,
  terminalPaneCount,
  type TerminalWorkspace,
} from "./terminal-tiling.js";
import { muxSessionDirectShortcutFor } from "./mux-keymap.js";
import {
  MUX_SESSION_PREFIX,
  MUX_SESSION_PREFIX_GROUPS,
  clearMuxSessionKeymapState,
  createMuxSessionKeymapState,
  isMuxSessionJumpKey,
  matchMuxSessionPrefixBinding,
  resolveMuxSessionKeydown,
  muxSessionHudBindings,
  type MuxSessionKeydownContext,
  type MuxSessionCommand,
} from "../keybindings.js";

const SettingsOverlay = lazy(() => import("@yaade/ui/settings"));
const TerminalSwitcher = lazy(() =>
  import("./TerminalSwitcher.js").then(({ TerminalSwitcher: View }) => ({
    default: View,
  })),
);
const MobileTerminalView = lazy(() =>
  import("./MobileTerminalView.js").then(({ MobileTerminalView: View }) => ({
    default: View,
  })),
);
const TerminalDndRoot = lazy(() => import("./TerminalDndRoot.js"));
const TerminalTilingWorkspace = lazy(() => import("./TerminalTilingWorkspace.js"));
const TerminalRenderer = lazy(() =>
  import("./renderers/TerminalView.js").then(({ ProcessTerminalView }) => ({
    default: ProcessTerminalView,
  })),
);
const loadMotionFeatures = () => import("motion/react").then(({ domMax }) => domMax);
const EMPTY_TERMINAL_IDS: readonly MuxTerminalId[] = [];

type MuxSessionHistoryState = { readonly yaadeMobileTerminal?: string } | null;

function writeMuxSessionLocation(
  url: string,
  mode: "push" | "replace",
  state: MuxSessionHistoryState = null,
): void {
  persistMuxSessionRoute(url, localStorage);
  if (mode === "push") history.pushState(state, "", url);
  else history.replaceState(state, "", url);
}
const EMPTY_TAB_IDS: readonly SessionTabId[] = [];

type CloseChoice = { readonly sessionId: SessionId } | undefined;

type TerminalOpenTarget = {
  readonly sessionId: SessionId;
  readonly tabId: SessionTabId;
  readonly panelId: PanelId;
};

function PrefixHud(props: { readonly onSelect: (key: string) => void }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-2 z-20 flex justify-center px-2">
      <div className="pointer-events-auto w-full max-w-4xl">
        <WhichKeyPanel
          variant="overlay"
          prefix={MUX_SESSION_PREFIX}
          groups={MUX_SESSION_PREFIX_GROUPS}
          entries={muxSessionHudBindings().map((binding) => ({
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

function isLive(terminal: MuxTerminal): boolean {
  return (
    terminal.status === "created" ||
    terminal.status === "starting" ||
    terminal.status === "running" ||
    terminal.status === "waiting"
  );
}

function firstEmptyTerminalPanel(workspace: TerminalWorkspace): PanelId | undefined {
  let emptyPanel: PanelId | undefined;
  workspace.tree.visitLeaves((leaf) => {
    if (!emptyPanel && leaf.view.kind === "empty") {
      emptyPanel = leaf.panelId;
    }
  });
  return emptyPanel;
}

function errorMessage<T>(error: T): string {
  return error instanceof Error ? error.message : "The host could not complete that action.";
}

function nextWindowTitle(tabs: readonly SessionTab[]): string {
  const usedTitles = new Set(tabs.map((tab) => tab.title));
  let index = 1;
  while (usedTitles.has(`Window ${index}`)) index += 1;
  return `Window ${index}`;
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

export function TerminalMultiplexer() {
  const hostPorts = useHostPorts();
  const serverConnections = useServerConnections();
  const { activeTheme, appearanceSettings, resetAppearanceSettings, setAppearanceSettings } =
    useAppearanceSettings();
  const [client] = useState<MuxClient>(() => createTerminalClient({ api: hostPorts.mux }));
  const snapshot = useSyncExternalStore(
    client.store.subscribe,
    client.store.getSnapshot,
    client.store.getSnapshot,
  );
  const [closeChoice, setCloseChoice] = useState<CloseChoice>();
  const [actionError, setActionError] = useState<string | undefined>();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [muxTerminalSwitcherOpen, setTerminalSwitcherOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paneChromeOverlayOpen, setPaneChromeOverlayOpen] = useState(false);
  const [routeRevision, setRouteRevision] = useState(0);
  const [terminalWorkspaces, setTerminalWorkspaces] = useState<
    ReadonlyMap<SessionTabId, TerminalWorkspace>
  >(() => new Map());
  const [prefixPending, setPrefixPending] = useState(false);
  const [runtimeTitles, setRuntimeTitles] = useState<
    ReadonlyMap<MuxTerminalId, RuntimeTerminalTitle>
  >(() => new Map());
  const layoutSaveTails = useRef(new Map<SessionTabId, Promise<void>>());
  const layoutServerStateRef = useRef(
    new Map<SessionTabId, { revision: number; layoutJson?: string }>(),
  );
  const keymapStateRef = useRef(createMuxSessionKeymapState());
  const prefixTimerRef = useRef<number | undefined>(undefined);
  const pendingTerminalPanelRequestsRef = useRef(new Set<string>());
  const closingTabIdsRef = useRef(new Set<SessionTabId>());
  const navigationIntentRef = useRef(0);
  const muxTerminalsRef = useRef(snapshot.terminalsById);
  const focusedMuxTerminalRef = useRef<MuxTerminal | undefined>(undefined);
  const overlayWasOpenRef = useRef(false);
  const isMobile = useIsMobile();
  muxTerminalsRef.current = snapshot.terminalsById;

  useEffect(() => {
    client.start();
    void client.hydrate().catch(() => undefined);
    return () => client.dispose();
  }, [client]);

  useEffect(() => {
    const bridge = window.__yaadeTest;
    if (!bridge) return;
    const previous = bridge.waitForReady.bind(bridge);
    bridge.waitForReady = async () => {
      await previous();
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          unsubscribe();
          reject(new Error("timed out waiting for host hydrate"));
        }, 30_000);
        const ready = (): boolean => {
          const snap = client.store.getSnapshot();
          if (snap.connection !== "connected") return false;
          const route = parseMuxSessionRoute(location.href);
          if (route.sessionId) {
            const present = [...snap.sessionsById.keys()].some((id) =>
              sameLocalResource(id, route.sessionId),
            );
            if (present) return sameLocalResource(snap.activeSessionId, route.sessionId);
          }
          if (route.muxTerminalId) {
            const present = [...snap.terminalsById.keys()].some((id) =>
              sameLocalResource(id, route.muxTerminalId),
            );
            if (present) return sameLocalResource(snap.activeMuxTerminalId, route.muxTerminalId);
          }
          return true;
        };
        const unsubscribe = client.store.subscribe(() => {
          if (!ready()) return;
          window.clearTimeout(timeout);
          unsubscribe();
          resolve();
        });
        if (ready()) {
          window.clearTimeout(timeout);
          unsubscribe();
          resolve();
        }
      });
    };
    return () => {
      bridge.waitForReady = previous;
    };
  }, [client]);

  useEffect(() => {
    if (serverConnections.snapshot.generation === 0) return;
    const activeId = serverConnections.snapshot.activeServerId;
    const current =
      serverConnections.snapshot.connections.find((connection) => connection.id === activeId) ??
      serverConnections.snapshot.connections[0];
    if (
      current?.status === "offline" ||
      current?.status === "incompatible" ||
      current?.status === "revoked"
    ) {
      return;
    }
    void client.reconcile().catch(() => undefined);
  }, [
    client,
    serverConnections.snapshot.generation,
    serverConnections.snapshot.connections,
    serverConnections.snapshot.activeServerId,
  ]);

  useEffect(() => {
    const activeId = serverConnections.snapshot.activeServerId;
    const current =
      serverConnections.snapshot.connections.find((connection) => connection.id === activeId) ??
      serverConnections.snapshot.connections[0];
    if (!current) return;
    if (
      current.status === "offline" ||
      current.status === "incompatible" ||
      current.status === "revoked"
    ) {
      client.store.setConnection("offline");
      return;
    }
    if (
      current.status === "synchronizing" ||
      current.status === "connecting" ||
      current.status === "authenticating"
    ) {
      client.store.setConnection("reconciling");
      return;
    }
    if (current.status === "connected") {
      void client.reconcile().catch(() => undefined);
    }
  }, [client, serverConnections.snapshot]);

  useEffect(() => {
    const onPopState = () => setRouteRevision((revision) => revision + 1);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const route = resolveMuxSessionRoute(location.href, localStorage);
    if (shouldHoldRequestedRoute(route, snapshot, snapshot.connection)) {
      return;
    }
    const requestedTerminal = route.muxTerminalId
      ? (snapshot.terminalsById.get(route.muxTerminalId) ??
        [...snapshot.terminalsById.values()].find((terminal) =>
          sameLocalResource(terminal.id, route.muxTerminalId),
        ))
      : undefined;
    const requestedSessionId = route.sessionId ?? requestedTerminal?.sessionId;
    const sessions = [...snapshot.sessionsById.values()];
    const session = requestedSessionId
      ? chooseSession(requestedSessionId, sessions)
      : chooseSession(undefined, sessions);
    if (!session) return;
    if (requestedSessionId && !sameLocalResource(session.id, requestedSessionId)) return;
    const tabs = snapshot.visibleTabIdsBySession.get(session.id) ?? [];
    const tab = chooseTab(
      route.tabId,
      session,
      tabs
        .map((id) => snapshot.tabsById.get(id))
        .filter((value): value is SessionTab => Boolean(value)),
      requestedTerminal?.sessionId === session.id ? requestedTerminal.tabId : undefined,
    );
    const ids = tab ? (snapshot.terminalIdsByTab.get(tab.id) ?? []) : EMPTY_TERMINAL_IDS;
    const mobileListRoute = isMobile && !route.muxTerminalId;
    const terminalId = mobileListRoute
      ? undefined
      : chooseMuxTerminal(route.muxTerminalId, tab, ids);
    if (snapshot.activeSessionId !== session.id) {
      serverConnections.manager.selectSession(session.id);
      client.store.selectSession(session.id);
    }
    if (tab && snapshot.activeTabId !== tab.id) {
      serverConnections.manager.selectTab(tab.id);
      client.store.selectTab(tab.id);
    }
    if (terminalId && snapshot.activeMuxTerminalId !== terminalId) {
      serverConnections.manager.selectMuxTerminal(terminalId);
      client.store.selectMuxTerminal(terminalId);
    }
    const url = muxSessionUrl(session.id, tab?.id, terminalId);
    persistMuxSessionRoute(url, localStorage);
    if (location.href !== new URL(url, location.origin).href) history.replaceState(null, "", url);
  }, [
    client,
    snapshot.activeSessionId,
    snapshot.activeTabId,
    snapshot.activeMuxTerminalId,
    snapshot.sessionsById,
    snapshot.tabsById,
    snapshot.terminalsById,
    snapshot.visibleTabIdsBySession,
    snapshot.terminalIdsByTab,
    snapshot.connection,
    routeRevision,
    isMobile,
    serverConnections.manager,
  ]);

  const visibleSessions = useMemo(
    () =>
      snapshot.visibleSessionIds
        .map((id) => snapshot.sessionsById.get(id))
        .filter((session): session is NonNullable<typeof session> => Boolean(session)),
    [snapshot.sessionsById, snapshot.visibleSessionIds],
  );
  const serverNamesBySessionId = useMemo(() => {
    const names = new Map<SessionId, string>();
    for (const session of visibleSessions) {
      const server = serverConnections.manager.serverForSession(session.id);
      if (server) names.set(session.id, server.name);
    }
    return names;
  }, [serverConnections.manager, visibleSessions]);
  const activeSession = snapshot.activeSessionId
    ? snapshot.sessionsById.get(snapshot.activeSessionId)
    : undefined;
  const activeTab = snapshot.activeTabId ? snapshot.tabsById.get(snapshot.activeTabId) : undefined;
  const activeSessionId = activeSession?.id;
  const activeTabId = activeTab?.id;
  const tabIds = useMemo(
    () =>
      activeSessionId
        ? (snapshot.visibleTabIdsBySession.get(activeSessionId) ?? EMPTY_TAB_IDS)
        : EMPTY_TAB_IDS,
    [activeSessionId, snapshot.visibleTabIdsBySession],
  );
  const visibleTabs = useMemo(
    () =>
      tabIds
        .map((id) => snapshot.tabsById.get(id))
        .filter((tab): tab is SessionTab => Boolean(tab)),
    [snapshot.tabsById, tabIds],
  );
  const terminalIds = useMemo(
    () =>
      activeTabId
        ? (snapshot.terminalIdsByTab.get(activeTabId) ?? EMPTY_TERMINAL_IDS)
        : EMPTY_TERMINAL_IDS,
    [activeTabId, snapshot.terminalIdsByTab],
  );
  const dockTerminalIdsByTab = useMemo(() => {
    const result = new Map<SessionTabId, MuxTerminalId>();
    for (const tab of visibleTabs) {
      const ids = snapshot.terminalIdsByTab.get(tab.id) ?? EMPTY_TERMINAL_IDS;
      const terminalId =
        tab.activeMuxTerminalId && ids.includes(tab.activeMuxTerminalId)
          ? tab.activeMuxTerminalId
          : ids[0];
      if (terminalId) result.set(tab.id, terminalId);
    }
    return result;
  }, [snapshot.terminalIdsByTab, visibleTabs]);
  const sessionTitlesById = useMemo(() => {
    const titles = new Map<SessionId, string>();
    for (const session of visibleSessions) titles.set(session.id, session.title);
    return titles;
  }, [visibleSessions]);
  const terminalCounts = useMemo(() => {
    const counts = new Map<SessionId, number>();
    for (const [id, ids] of snapshot.terminalIdsBySession) counts.set(id, ids.length);
    return counts;
  }, [snapshot.terminalIdsBySession]);
  const selected = snapshot.activeMuxTerminalId
    ? snapshot.terminalsById.get(snapshot.activeMuxTerminalId)
    : undefined;
  const twoSidebarLayout = appearanceSettings.sessionLayout === "two-sidebars";
  const singleSidebarLayout = appearanceSettings.sessionLayout === "single-sidebar";
  const sidebarLayout = twoSidebarLayout || singleSidebarLayout;
  const sidebarsCollapsed = sidebarLayout && appearanceSettings.sidebarCollapsed;
  const sidebarOrientation = isMobile ? "horizontal" : "vertical";
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
        sidebarWidth: Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, width)),
      }));
    },
    [setAppearanceSettings],
  );

  const updateRuntimeTitle = useCallback(
    (terminal: MuxTerminal, title: string, source: RuntimeTerminalTitle["source"]) => {
      setRuntimeTitles((previous) => {
        const current = previous.get(terminal.id);
        const next = nextRuntimeTerminalTitle(terminal, current, title, source);
        if (!next || (current?.title === next.title && current.source === next.source)) {
          return previous;
        }
        return new Map(previous).set(terminal.id, next);
      });
    },
    [],
  );

  useEffect(() => {
    setTerminalWorkspaces((previous) => {
      const next = new Map(previous);
      let changed = false;
      for (const tabId of tabIds) {
        if (next.has(tabId)) continue;
        const tab = snapshot.tabsById.get(tabId);
        if (!tab) continue;
        const ids = snapshot.terminalIdsByTab.get(tab.id) ?? EMPTY_TERMINAL_IDS;
        next.set(tab.id, restoreTerminalWorkspace(tab.layoutJson, ids));
        changed = true;
      }
      return changed ? next : previous;
    });
  }, [snapshot.tabsById, snapshot.terminalIdsByTab, tabIds]);

  // YAADE terminal client keeps layout authoritative on the host. Adopt a remote layout event
  // only when the local workspace still matches the last server layout; a
  // genuinely dirty local workspace remains visible and is resolved by the
  // revision-checked save path instead of being silently discarded.
  useEffect(() => {
    const replacements = new Map<
      SessionTabId,
      { expected: TerminalWorkspace; next: TerminalWorkspace }
    >();
    for (const tabId of tabIds) {
      const tab = snapshot.tabsById.get(tabId);
      const workspace = tab ? terminalWorkspaces.get(tab.id) : undefined;
      if (!tab) continue;
      const previousServer = layoutServerStateRef.current.get(tab.id);
      const localJson = workspace ? serializeTerminalWorkspace(workspace) : undefined;
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
        const ids = snapshot.terminalIdsByTab.get(tab.id) ?? EMPTY_TERMINAL_IDS;
        replacements.set(tab.id, {
          expected: workspace,
          next: restoreTerminalWorkspace(tab.layoutJson, ids),
        });
      }
      layoutServerStateRef.current.set(tab.id, {
        revision: tab.revision ?? 0,
        ...(tab.layoutJson === undefined ? {} : { layoutJson: tab.layoutJson }),
      });
    }
    if (replacements.size === 0) return;
    setTerminalWorkspaces((previous) => {
      const next = new Map(previous);
      let changed = false;
      for (const [tabId, replacement] of replacements) {
        if (previous.get(tabId) !== replacement.expected) continue;
        next.set(tabId, replacement.next);
        changed = true;
      }
      return changed ? next : previous;
    });
  }, [snapshot.tabsById, snapshot.terminalIdsByTab, tabIds, terminalWorkspaces]);

  const updateTerminalWorkspace = useCallback(
    (tabId: SessionTabId, update: (workspace: TerminalWorkspace) => TerminalWorkspace) => {
      setTerminalWorkspaces((previous) => {
        const current = previous.get(tabId) ?? createTerminalWorkspace();
        const next = update(current);
        if (next === current && previous.has(tabId)) return previous;
        return new Map(previous).set(tabId, next);
      });
    },
    [],
  );

  const splitFocusedTerminalPanel = useCallback(
    (edge: "right" | "bottom") => {
      if (!activeTabId) return;
      updateTerminalWorkspace(activeTabId, (workspace) =>
        splitTerminalPanel(workspace, workspace.focusedPanelId, edge),
      );
    },
    [activeTabId, updateTerminalWorkspace],
  );

  const openTerminalInWorkspace = useCallback(
    (terminal: MuxTerminal, target?: TerminalOpenTarget) => {
      const current = client.store.getSnapshot();
      const tabId =
        target?.tabId ??
        terminal.tabId ??
        current.sessionsById.get(terminal.sessionId)?.activeTabId ??
        current.visibleTabIdsBySession.get(terminal.sessionId)?.[0] ??
        activeTabId;
      if (!tabId) return;
      updateTerminalWorkspace(tabId, (workspace) =>
        target?.panelId === undefined
          ? openTerminalView(workspace, terminal.id)
          : openTerminalViewInPanel(workspace, target.panelId, terminal.id),
      );
    },
    [activeTabId, client, updateTerminalWorkspace],
  );

  const selectSession = useCallback(
    (id: SessionId) => {
      navigationIntentRef.current += 1;
      markPerformance("yaade:session-switch");
      serverConnections.manager.selectSession(id);
      client.store.selectSession(id);
      const session = client.store.getSnapshot().sessionsById.get(id);
      const nextTab = session?.activeTabId
        ? client.store.getSnapshot().tabsById.get(session.activeTabId)
        : undefined;
      writeMuxSessionLocation(
        session ? muxSessionUrl(session.id, nextTab?.id, nextTab?.activeMuxTerminalId) : "/",
        "push",
      );
    },
    [client, serverConnections.manager],
  );

  const selectTerminal = useCallback(
    (terminal: MuxTerminal, target?: TerminalOpenTarget) => {
      navigationIntentRef.current += 1;
      markPerformance("yaade:terminal-switch");
      openTerminalInWorkspace(terminal, target);
      const current = client.store.getSnapshot().activeMuxTerminalId;
      serverConnections.manager.selectMuxTerminal(terminal.id);
      client.store.selectMuxTerminal(terminal.id);
      const tabId = terminal.tabId ?? client.store.getSnapshot().activeTabId;
      const nextUrl = muxSessionUrl(terminal.sessionId, tabId, terminal.id);
      if (current !== terminal.id || location.href !== new URL(nextUrl, location.origin).href) {
        writeMuxSessionLocation(nextUrl, "push", { yaadeMobileTerminal: terminal.id });
      }
    },
    [client, openTerminalInWorkspace, serverConnections.manager],
  );

  const lastAutoOpenedTerminalRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!selected) return;
    const key = `${selected.sessionId}:${selected.id}`;
    if (lastAutoOpenedTerminalRef.current === key) return;
    lastAutoOpenedTerminalRef.current = key;
    openTerminalInWorkspace(selected);
  }, [openTerminalInWorkspace, selected]);

  useEffect(() => {
    if (!activeTabId) return;
    const liveIds = new Set(terminalIds);
    updateTerminalWorkspace(activeTabId, (workspace) =>
      removeMissingTerminalViews(workspace, liveIds),
    );
  }, [activeTabId, updateTerminalWorkspace, terminalIds]);

  const createTerminal = useCallback(
    async (
      nextKind: TerminalKind = "terminal",
      targetSessionId?: SessionId,
      target?: TerminalOpenTarget,
    ): Promise<MuxTerminal | undefined> => {
      const currentSnapshot = client.store.getSnapshot();
      const targetSession = target
        ? currentSnapshot.sessionsById.get(target.sessionId)
        : targetSessionId
          ? currentSnapshot.sessionsById.get(targetSessionId)
          : activeSession;
      const targetTabIds = targetSession
        ? (currentSnapshot.visibleTabIdsBySession.get(targetSession.id) ?? EMPTY_TAB_IDS)
        : EMPTY_TAB_IDS;
      const preferredTabId = target?.tabId ?? targetSession?.activeTabId ?? targetTabIds[0];
      const targetTab = preferredTabId ? currentSnapshot.tabsById.get(preferredTabId) : undefined;
      if (
        !targetSession ||
        !targetTab ||
        !isLiveSessionTab(targetSession, targetTab) ||
        closingTabIdsRef.current.has(targetTab.id)
      ) {
        return undefined;
      }
      let destinationTabId = targetTab.id;
      const navigationIntent = ++navigationIntentRef.current;
      setActionError(undefined);
      try {
        // A new Window starts an async terminal creation. If that Window was
        // closed while terminal creation was in flight, do not send its stale
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

        const input: TerminalInput = { _tag: "TerminalInput", kind: "terminal" };
        const targetTerminalIds =
          liveSnapshot.terminalIdsByTab.get(liveTab.id) ?? EMPTY_TERMINAL_IDS;
        const currentWorkspace =
          terminalWorkspaces.get(liveTab.id) ??
          restoreTerminalWorkspace(liveTab.layoutJson, targetTerminalIds);
        let hasEmptyPane = false;
        currentWorkspace.tree.visitLeaves((leaf) => {
          if (leaf.view.kind === "empty") hasEmptyPane = true;
        });
        let destinationTab = liveTab;
        let rollbackTab: SessionTab | undefined;
        if (terminalPaneCount(currentWorkspace) >= MAX_TERMINAL_TILES && !hasEmptyPane) {
          const liveTabIds =
            liveSnapshot.visibleTabIdsBySession.get(liveSession.id) ?? EMPTY_TAB_IDS;
          const createdTab = await hostPorts.mux.createTab?.({
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
            const rollback = hostPorts.mux.archiveTab?.({
              _tag: "ArchiveSessionTab",
              tabId: rollbackTab.id,
              mode: "stop-terminals",
            });
            if (rollback) await rollback.catch(() => undefined);
          }
          return undefined;
        }

        const command: CreateTerminal = {
          _tag: "CreateTerminal",
          sessionId: liveSession.id,
          tabId: destinationTab.id,
          kind: nextKind,
          input,
        };
        try {
          const created = await hostPorts.mux.createTerminal?.(command);
          if (created) client.store.replaceMuxTerminal(created);
          await client.reconcileSession(liveSession.id);
          if (
            created &&
            navigationIntentRef.current === navigationIntent
          ) {
            const openTarget = target && destinationTab.id === target.tabId ? target : undefined;
            selectTerminal(created, openTarget);
          }
          return created;
        } catch (error) {
          if (rollbackTab) {
            const rollback = hostPorts.mux.archiveTab?.({
              _tag: "ArchiveSessionTab",
              tabId: rollbackTab.id,
              mode: "stop-terminals",
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
    [activeSession, client, hostPorts.mux, selectTerminal, terminalWorkspaces],
  );

  const selectTab = useCallback(
    (tab: SessionTab) => {
      navigationIntentRef.current += 1;
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
      serverConnections.manager.selectTab(tab.id);
      client.store.selectTab(tab.id);
      const nextTerminal = client.store.getSnapshot().activeMuxTerminalId;
      writeMuxSessionLocation(muxSessionUrl(session.id, tab.id, nextTerminal), "push");
    },
    [client, serverConnections.manager],
  );

  const createTab = useCallback(async () => {
    if (!activeSession) return;
    const navigationIntent = ++navigationIntentRef.current;
    try {
      const tab = await hostPorts.mux.createTab?.({
        _tag: "CreateSessionTab",
        sessionId: activeSession.id,
        title: nextWindowTitle(visibleTabs),
      });
      if (!tab) return;
      await client.reconcileSession(activeSession.id);
      if (navigationIntentRef.current === navigationIntent) selectTab(tab);
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }, [activeSession, client, selectTab, visibleTabs]);

  const renameTab = useCallback(
    async (id: SessionTabId, title: string) => {
      try {
        const tab = await hostPorts.mux.renameTab?.({ _tag: "RenameSessionTab", tabId: id, title });
        if (tab) client.store.replaceTab(tab);
      } catch (error) {
        setActionError(errorMessage(error));
      }
    },
    [client],
  );

  const reorderTabs = useCallback(
    async (ids: readonly SessionTabId[]) => {
      if (!activeSession) return;
      try {
        await hostPorts.mux.reorderTabs?.({
          _tag: "ReorderSessionTabs",
          sessionId: activeSession.id,
          tabIds: ids,
        });
        await client.reconcileSession(activeSession.id);
      } catch (error) {
        setActionError(errorMessage(error));
      }
    },
    [activeSession, client],
  );

  const closeTab = useCallback(
    async (tab: SessionTab) => {
      closingTabIdsRef.current.add(tab.id);
      try {
        await hostPorts.mux.archiveTab?.({
          _tag: "ArchiveSessionTab",
          tabId: tab.id,
          mode: "stop-terminals",
        });
        await client.reconcileSession(tab.sessionId);
      } catch (error) {
        setActionError(errorMessage(error));
      } finally {
        closingTabIdsRef.current.delete(tab.id);
      }
    },
    [client],
  );

  const createSession = useCallback(async () => {
    const navigationIntent = ++navigationIntentRef.current;
    try {
      const created = await hostPorts.mux.createSession?.("New session");
      if (!created) return;
      await client.reconcile();
      if (navigationIntentRef.current === navigationIntent) {
        selectSession(created.id);
      }
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }, [client, selectSession]);

  const runTerminalAction = useCallback(
    async (action: "cancel" | "restart" | "archive", terminal: MuxTerminal) => {
      setActionError(undefined);
      try {
        const api = hostPorts.mux;
        const result =
          action === "cancel"
            ? await api?.stopTerminal?.(terminal.id, terminal.revision)
            : action === "restart"
              ? await api?.restartTerminal?.(terminal.id, terminal.revision)
              : await api?.closeTerminal?.({
                  _tag: "CloseTerminal",
                  muxTerminalId: terminal.id,
                });
        if (result) client.store.replaceMuxTerminal(result);
        await client.reconcileSession(terminal.sessionId);
      } catch (error) {
        setActionError(errorMessage(error));
        await client.reconcileSession(terminal.sessionId).catch(() => undefined);
      }
    },
    [client],
  );

  const closeSession = useCallback(
    async (sessionId: SessionId, mode: "keep-running" | "stop-terminals") => {
      try {
        const archived = await hostPorts.mux.archiveSession?.({
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
      const sessionTerminals = client.store.getSnapshot().terminalIdsBySession.get(sessionId) ?? [];
      const live = sessionTerminals.some((id) => {
        const terminal = client.store.getSnapshot().terminalsById.get(id);
        return terminal ? isLive(terminal) : false;
      });
      if (live) setCloseChoice({ sessionId });
      else void closeSession(sessionId, "keep-running");
    },
    [client, closeSession],
  );

  const renameSession = useCallback(
    async (id: SessionId, title: string) => {
      const renamed = await hostPorts.mux.renameSession?.(id, title);
      if (renamed) await client.reconcile();
    },
    [client],
  );

  const reorderSessions = useCallback(
    async (ids: readonly SessionId[]) => {
      await hostPorts.mux.reorderSessions?.({
        _tag: "ReorderSessions",
        sessionIds: ids,
      });
      await client.reconcile();
    },
    [client],
  );

  const renameMuxTerminal = useCallback(
    async (terminal: MuxTerminal, title: string) => {
      const renamed = await hostPorts.mux.renameTerminal?.(terminal.id, title);
      if (renamed) client.store.replaceMuxTerminal(renamed);
    },
    [client],
  );

  const reorderMuxTerminals = useCallback(
    async (ids: readonly MuxTerminalId[]) => {
      if (!activeSession || !activeTab) return;
      await hostPorts.mux.reorderTerminals?.({
        _tag: "ReorderTerminals",
        sessionId: activeSession.id,
        tabId: activeTab.id,
        muxTerminalIds: ids,
      });
      await client.reconcileSession(activeSession.id);
    },
    [activeSession, activeTab, client],
  );

  useEffect(() => {
    const bridge = window.__yaadeTest;
    if (!bridge) return;
    const previous = {
      getState: bridge.getState,
      createSession: bridge.createSession,
      selectSession: bridge.selectSession,
      createTab: bridge.createTab,
      selectTab: bridge.selectTab,
      closeTab: bridge.closeTab,
      createMuxTerminal: bridge.createMuxTerminal,
      selectMuxTerminal: bridge.selectMuxTerminal,
      closeMuxTerminal: bridge.closeMuxTerminal,
      closeSession: bridge.closeSession,
      getPerfMeasures: bridge.getPerfMeasures,
    };
    const sessionFor = (id: string) =>
      [...snapshot.sessionsById.values()].find((session) => session.id === id);
    const terminalFor = (id: string) =>
      [...snapshot.terminalsById.values()].find((terminal) => terminal.id === id);
    const tabFor = (id: string) => [...snapshot.tabsById.values()].find((tab) => tab.id === id);
    bridge.getState = () => ({
      ...previous.getState(),
      route: "session",
      activeSessionId: snapshot.activeSessionId ?? null,
      activeTabId: snapshot.activeTabId ?? null,
      activeMuxTerminalId: snapshot.activeMuxTerminalId ?? null,
      sessions: visibleSessions,
      tabs: activeSession
        ? (snapshot.visibleTabIdsBySession.get(activeSession.id) ?? [])
            .map((id) => snapshot.tabsById.get(id))
            .filter((tab): tab is SessionTab => Boolean(tab))
        : [],
      muxTerminals: [...snapshot.terminalsById.values()].filter((terminal) => !terminal.archivedAt),
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
    bridge.createMuxTerminal = async (nextKind) => {
      await createTerminal(nextKind);
    };
    bridge.selectMuxTerminal = async (id) => {
      const terminal = terminalFor(id);
      if (terminal) selectTerminal(terminal);
    };
    bridge.closeMuxTerminal = async (id) => {
      const terminal = terminalFor(id);
      if (terminal) await runTerminalAction("archive", terminal);
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
      bridge.createMuxTerminal = previous.createMuxTerminal;
      bridge.selectMuxTerminal = previous.selectMuxTerminal;
      bridge.closeMuxTerminal = previous.closeMuxTerminal;
      bridge.closeSession = previous.closeSession;
      bridge.getPerfMeasures = previous.getPerfMeasures;
    };
  }, [
    activeSession,
    closeSession,
    closeTab,
    createSession,
    createTab,
    createTerminal,
    runTerminalAction,
    selectSession,
    selectTab,
    selectTerminal,
    snapshot,
    visibleSessions,
  ]);

  const clearPrefix = useCallback(() => {
    clearMuxSessionKeymapState(keymapStateRef.current);
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
      clearMuxSessionKeymapState(keymapStateRef.current);
      prefixTimerRef.current = undefined;
      setPrefixPending(false);
    }, CHORD_TIMEOUT_MS);
  }, []);

  const runMuxSessionCommand = useCallback(
    (command: MuxSessionCommand, jumpIndex = 0) => {
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
        case "terminal.newTerminal":
          void createTerminal("terminal");
          return;
        case "session.switch":
          setSwitcherOpen(true);
          return;
        case "terminal.switch":
          setTerminalSwitcherOpen(true);
          return;
        case "terminal.next":
        case "terminal.previous": {
          if (!selected || terminalIds.length === 0) return;
          const index = terminalIds.indexOf(selected.id);
          const nextIndex =
            command === "terminal.next"
              ? (index + 1) % terminalIds.length
              : (index - 1 + terminalIds.length) % terminalIds.length;
          const next = snapshot.terminalsById.get(terminalIds[nextIndex]!);
          if (next) selectTerminal(next);
          return;
        }
        case "terminal.jump": {
          const id = terminalIds[jumpIndex];
          if (!id) return;
          const next = snapshot.terminalsById.get(id);
          if (next) selectTerminal(next);
          return;
        }
        case "terminal.close": {
          const target = focusedMuxTerminalRef.current ?? selected;
          if (target) void runTerminalAction("archive", target);
          return;
        }
        case "session.close":
          if (activeSession) requestCloseSession(activeSession.id);
          return;
        case "pane.zoom":
          if (activeTab) {
            updateTerminalWorkspace(activeTab.id, (workspace) =>
              toggleTerminalPanelZoom(workspace, workspace.focusedPanelId),
            );
          }
          return;
        case "pane.splitRight":
          splitFocusedTerminalPanel("right");
          return;
        case "pane.splitDown":
          splitFocusedTerminalPanel("bottom");
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
      createTerminal,
      requestCloseSession,
      runTerminalAction,
      selectTab,
      selectTerminal,
      selected,
      snapshot.tabsById,
      snapshot.terminalsById,
      splitFocusedTerminalPanel,
      toggleSidebars,
      tabIds,
      updateTerminalWorkspace,
      terminalIds,
    ],
  );

  const runMuxSessionCommandRef = useRef(runMuxSessionCommand);
  runMuxSessionCommandRef.current = runMuxSessionCommand;
  const selectedTerminalRef = useRef(selected);
  selectedTerminalRef.current = selected;
  const keybindingContextRef = useRef<
    Pick<MuxSessionKeydownContext, "overlayOpen" | "zoomed" | "contextKind">
  >({ overlayOpen: false, zoomed: false });
  keybindingContextRef.current = {
    overlayOpen: Boolean(
      switcherOpen ||
      muxTerminalSwitcherOpen ||
      settingsOpen ||
      closeChoice ||
      paneChromeOverlayOpen,
    ),
    zoomed: Boolean(
      activeSession && activeTab && terminalWorkspaces.get(activeTab.id)?.zoomedPanelId,
    ),
    contextKind: selected?.kind,
  };

  useEffect(() => {
    const keymapState = keymapStateRef.current;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const inTerminal = Boolean(
        target?.closest("[data-ghostty-terminal-input], [data-ghostty-terminal-canvas]"),
      );
      const inEditable =
        !inTerminal && Boolean(target?.closest("input, textarea, [contenteditable=true]"));
      const result = resolveMuxSessionKeydown(event, keymapStateRef.current, {
        ...keybindingContextRef.current,
        inEditable,
        inTerminal,
        inPrefixButton: Boolean(target?.closest("[data-yaade-which-key-item]")),
      });
      if (!result) return;

      event.preventDefault();
      event.stopPropagation();
      if (result.type === "prefix-started") {
        showPrefix();
        return;
      }
      if (result.type === "prefix-literal") {
        clearPrefix();
        const target = focusedMuxTerminalRef.current ?? selectedTerminalRef.current;
        const ptyId = target?.output.kind === "process" ? target.output.ptyId : undefined;
        if (ptyId) void window.yaade?.terminal.write?.(ptyId, result.byte);
        return;
      }
      if (result.type === "command") {
        clearPrefix();
        runMuxSessionCommandRef.current(result.command, result.jumpIndex);
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
      clearMuxSessionKeymapState(keymapState);
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
    switcherOpen || muxTerminalSwitcherOpen || settingsOpen || closeChoice || paneChromeOverlayOpen,
  );
  useEffect(() => {
    if (muxOverlayOpen) {
      overlayWasOpenRef.current = true;
      clearPrefix();
      return;
    }
    if (!overlayWasOpenRef.current) return;
    overlayWasOpenRef.current = false;
    const target = focusedMuxTerminalRef.current ?? selectedTerminalRef.current;
    const tabId = target?.kind === "terminal" ? target.id : undefined;
    const raf = requestAnimationFrame(() => {
      focusRegisteredTerminal(tabId);
    });
    return () => cancelAnimationFrame(raf);
  }, [clearPrefix, muxOverlayOpen]);

  const activeTerminalWorkspace = useMemo(() => {
    if (!activeTab) return createTerminalWorkspace();
    return (
      terminalWorkspaces.get(activeTab.id) ??
      restoreTerminalWorkspace(activeTab.layoutJson, terminalIds)
    );
  }, [activeTab, terminalWorkspaces, terminalIds]);
  const focusedView = activeTerminalWorkspace.tree.getView(activeTerminalWorkspace.focusedPanelId);
  focusedMuxTerminalRef.current =
    focusedView?.kind === "terminal"
      ? snapshot.terminalsById.get(focusedView.muxTerminalId)
      : undefined;

  useEffect(() => {
    if (!activeSession || !activeTab || snapshot.connection !== "connected") {
      return;
    }
    const route = parseMuxSessionRoute(location.href);
    if (
      shouldHoldRequestedRoute(route, snapshot, snapshot.connection) ||
      (route.sessionId && !sameLocalResource(activeSession.id, route.sessionId)) ||
      (route.muxTerminalId &&
        !sameLocalResource(snapshot.activeMuxTerminalId, route.muxTerminalId) &&
        [...snapshot.terminalsById.keys()].some((id) => sameLocalResource(id, route.muxTerminalId)))
    ) {
      return;
    }
    const emptyPanel = firstEmptyTerminalPanel(activeTerminalWorkspace);
    if (!emptyPanel) return;

    // A terminal may exist remotely while its restored view is still being placed.
    // Let the restore effect finish before treating the pane as unconfigured.
    if (terminalIds.length > 0 && terminalIdsInWorkspace(activeTerminalWorkspace).length === 0) {
      return;
    }

    const requestKey = `${activeTab.id}:${emptyPanel.id}`;
    if (pendingTerminalPanelRequestsRef.current.has(requestKey)) return;
    pendingTerminalPanelRequestsRef.current.add(requestKey);
    void createTerminal("terminal", activeSession.id, {
      sessionId: activeSession.id,
      tabId: activeTab.id,
      panelId: emptyPanel,
    }).finally(() => {
      pendingTerminalPanelRequestsRef.current.delete(requestKey);
    });
  }, [
    activeSession,
    activeTab,
    activeTerminalWorkspace,
    createTerminal,
    snapshot.connection,
    snapshot.activeMuxTerminalId,
    snapshot.terminalsById,
    terminalIds,
  ]);

  const activeTabForLayoutRef = useRef(activeTab);
  activeTabForLayoutRef.current = activeTab;

  useEffect(() => {
    const currentTab = activeTabForLayoutRef.current;
    if (!currentTab) return;
    const workspace = terminalWorkspaces.get(currentTab.id);
    if (!workspace) return;
    const layoutJson = serializeTerminalWorkspace(workspace);
    if (layoutJson === currentTab.layoutJson) return;
    const tabId = currentTab.id;
    const sessionId = currentTab.sessionId;
    const handle = window.setTimeout(() => {
      const save = hostPorts.mux.saveTabLayout;
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
        .catch((error) => setActionError(errorMessage(error)))
        .then(() => undefined);
      layoutSaveTails.current.set(tabId, operation);
      void operation.then(() => {
        if (layoutSaveTails.current.get(tabId) === operation) {
          layoutSaveTails.current.delete(tabId);
        }
      });
    }, 350);
    return () => window.clearTimeout(handle);
  }, [activeTab?.id, client, terminalWorkspaces]);

  const openMuxTerminalIds = useMemo(
    () => new Set(terminalIdsInWorkspace(activeTerminalWorkspace)),
    [activeTerminalWorkspace],
  );
  const activeSessionTerminalIds = useMemo(() => new Set(terminalIds), [terminalIds]);

  const muxTerminalIdForDrag = useCallback(
    (tabId: string): MuxTerminalId | undefined => {
      for (const terminalId of snapshot.terminalsById.keys()) {
        if (terminalId === tabId) return terminalId;
      }
      return undefined;
    },
    [snapshot.terminalsById],
  );

  const activateDockedTerminal = useCallback(
    (terminal: MuxTerminal) => {
      const alreadyActive = client.store.getSnapshot().activeMuxTerminalId === terminal.id;
      serverConnections.manager.selectMuxTerminal(terminal.id);
      if (!alreadyActive) {
        client.store.selectMuxTerminal(terminal.id);
        const request = hostPorts.mux.selectTerminal?.(terminal.sessionId, terminal.id);
        if (request) {
          void request.catch(async (error) => {
            setActionError(errorMessage(error));
            await client.reconcileSession(terminal.sessionId).catch(() => undefined);
          });
        }
      }
      const tabId = terminal.tabId ?? client.store.getSnapshot().activeTabId;
      writeMuxSessionLocation(muxSessionUrl(terminal.sessionId, tabId, terminal.id), "replace");
    },
    [client, hostPorts.mux, serverConnections.manager],
  );

  const dockWindowTerminal = useCallback(
    async (muxTerminalId: MuxTerminalId, target: PanelId, action: DropAction) => {
      if (!activeTab) return;
      const terminal = client.store.getSnapshot().terminalsById.get(muxTerminalId);
      if (!terminal) return;

      const preview = dockTerminalView(activeTerminalWorkspace, muxTerminalId, target, action);
      if (preview === activeTerminalWorkspace) return;
      if (!terminal.tabId || terminal.tabId === activeTab.id) {
        updateTerminalWorkspace(activeTab.id, (workspace) =>
          dockTerminalView(workspace, muxTerminalId, target, action),
        );
        activateDockedTerminal(terminal);
        return;
      }

      const sourceTabId = terminal.tabId;
      const sourceTerminalIds =
        client.store.getSnapshot().terminalIdsByTab.get(sourceTabId) ?? EMPTY_TERMINAL_IDS;
      const moveTerminal = hostPorts.mux.moveTerminal;
      if (!moveTerminal) return;

      setActionError(undefined);
      try {
        const moved = await moveTerminal({
          _tag: "MoveTerminalToTab",
          muxTerminalId,
          targetTabId: activeTab.id,
        });
        client.store.replaceMuxTerminal(moved);

        const remainingSourceIds = new Set(
          sourceTerminalIds.filter((terminalId) => terminalId !== muxTerminalId),
        );
        updateTerminalWorkspace(sourceTabId, (workspace) =>
          removeMissingTerminalViews(workspace, remainingSourceIds),
        );
        updateTerminalWorkspace(activeTab.id, (workspace) =>
          dockTerminalView(workspace, muxTerminalId, target, action),
        );
        activateDockedTerminal(moved);

        if (remainingSourceIds.size === 0) {
          closingTabIdsRef.current.add(sourceTabId);
          try {
            await hostPorts.mux.archiveTab?.({
              _tag: "ArchiveSessionTab",
              tabId: sourceTabId,
              mode: "keep-running",
            });
            setTerminalWorkspaces((previous) => {
              if (!previous.has(sourceTabId)) return previous;
              const next = new Map(previous);
              next.delete(sourceTabId);
              return next;
            });
          } finally {
            closingTabIdsRef.current.delete(sourceTabId);
          }
        }
        await client.reconcileSession(terminal.sessionId);
      } catch (error) {
        setActionError(errorMessage(error));
        await client.reconcileSession(terminal.sessionId).catch(() => undefined);
      }
    },
    [
      activeTab,
      activeTerminalWorkspace,
      activateDockedTerminal,
      client,
      hostPorts.mux,
      updateTerminalWorkspace,
    ],
  );

  const reorderWindowTabs = useCallback(
    (sourceId: string, targetId: string) => {
      if (sourceId === targetId) return;
      const ids = visibleTabs.map((tab) => tab.id);
      const sourceIndex = ids.findIndex((id) => id === sourceId);
      const targetIndex = ids.findIndex((id) => id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) return;
      const [source] = ids.splice(sourceIndex, 1);
      if (!source) return;
      ids.splice(targetIndex, 0, source);
      void reorderTabs(ids);
    },
    [reorderTabs, visibleTabs],
  );

  const terminalTabDnd = useMemo((): TabDndHandlers => {
    return {
      onTabReorder: (panelId, tabId, toIndex) => {
        if (!activeTab) return;
        const muxTerminalId = muxTerminalIdForDrag(tabId);
        if (!muxTerminalId) return;
        updateTerminalWorkspace(activeTab.id, (workspace) =>
          reorderTerminalTabs(workspace, panelId, muxTerminalId, toIndex),
        );
      },
      tabIdsForPanel: (panelId) => {
        const view = activeTerminalWorkspace.tree.getView(panelId);
        return view?.kind === "terminal" ? [view.muxTerminalId] : [];
      },
      onTabDrop: (_source, sourceTabId, target, action) => {
        if (!activeTab) return;
        const muxTerminalId = muxTerminalIdForDrag(sourceTabId);
        if (!muxTerminalId) return;
        const terminal = snapshot.terminalsById.get(muxTerminalId);
        updateTerminalWorkspace(activeTab.id, (workspace) =>
          dockTerminalView(workspace, muxTerminalId, target, action),
        );
        if (terminal) activateDockedTerminal(terminal);
      },
      onSessionDrop: (sourceTabId, target, action) => {
        const muxTerminalId = muxTerminalIdForDrag(sourceTabId);
        if (!muxTerminalId) return;
        void dockWindowTerminal(muxTerminalId, target, action);
      },
      onSessionReorder: reorderWindowTabs,
    };
  }, [
    activeTab,
    activeTerminalWorkspace,
    activateDockedTerminal,
    dockWindowTerminal,
    snapshot.terminalsById,
    muxTerminalIdForDrag,
    reorderWindowTabs,
    updateTerminalWorkspace,
  ]);

  const closeWorkspacePane = useCallback(
    (panelId: PanelId) => {
      if (!activeTab) return;
      const view = activeTerminalWorkspace.tree.getView(panelId);
      if (view?.kind === "terminal") {
        const terminal = snapshot.terminalsById.get(view.muxTerminalId);
        if (terminal) void runTerminalAction("archive", terminal);
        return;
      }
      updateTerminalWorkspace(activeTab.id, (workspace) => closeTerminalPanel(workspace, panelId));
    },
    [
      activeTab,
      activeTerminalWorkspace,
      runTerminalAction,
      snapshot.terminalsById,
      updateTerminalWorkspace,
    ],
  );

  const handleTerminalPanelEvent = useCallback(
    (event: PanelEvent) => {
      if (!activeTab) return;
      if (event.type === "splitRatiosChanged") {
        updateTerminalWorkspace(activeTab.id, (workspace) =>
          resizeTerminalSplit(workspace, event.path, event.ratios),
        );
        return;
      }
      if (event.type === "panelClose") closeWorkspacePane(event.panelId);
    },
    [activeTab, closeWorkspacePane, updateTerminalWorkspace],
  );

  const focusWorkspacePanel = useCallback(
    (panelId: PanelId, terminal?: MuxTerminal) => {
      if (!activeTab) return;
      updateTerminalWorkspace(activeTab.id, (workspace) => focusTerminalPanel(workspace, panelId));
      if (terminal) activateDockedTerminal(terminal);
    },
    [activeTab, activateDockedTerminal, updateTerminalWorkspace],
  );

  const addTerminalToSplitPanel = useCallback(
    (panelId: PanelId, edge: "right" | "bottom", kind: TerminalKind) => {
      if (!activeSession || !activeTab) return;
      const tabId = activeTab.id;
      const currentWorkspace = terminalWorkspaces.get(tabId) ?? activeTerminalWorkspace;
      const nextWorkspace = splitTerminalPanel(currentWorkspace, panelId, edge);
      if (nextWorkspace === currentWorkspace) return;
      const target: TerminalOpenTarget = {
        sessionId: activeSession.id,
        tabId,
        panelId: nextWorkspace.focusedPanelId,
      };
      updateTerminalWorkspace(tabId, (workspace) => splitTerminalPanel(workspace, panelId, edge));
      const requestKey = `${tabId}:${target.panelId.id}`;
      pendingTerminalPanelRequestsRef.current.add(requestKey);
      void createTerminal(kind, activeSession.id, target).finally(() => {
        pendingTerminalPanelRequestsRef.current.delete(requestKey);
      });
    },
    [
      activeSession,
      activeTab,
      activeTerminalWorkspace,
      createTerminal,
      terminalWorkspaces,
      updateTerminalWorkspace,
    ],
  );

  const splitTerminalPanelAt = useCallback(
    (panelId: PanelId, edge: "right" | "bottom") => {
      if (!activeTabId) return;
      updateTerminalWorkspace(activeTabId, (workspace) =>
        splitTerminalPanel(workspace, panelId, edge),
      );
    },
    [activeTabId, updateTerminalWorkspace],
  );

  const zoomTerminalPanel = useCallback(
    (panelId: PanelId) => {
      if (!activeTabId) return;
      updateTerminalWorkspace(activeTabId, (workspace) =>
        toggleTerminalPanelZoom(workspace, panelId),
      );
    },
    [activeTabId, updateTerminalWorkspace],
  );

  const renderTerminal = useCallback(
    (terminal: MuxTerminal, focused: boolean, visible = true) => (
      <SelectedMuxTerminal
        key={terminal.id}
        terminal={terminal}
        theme={activeTheme}
        visible={visible}
        focused={focused}
        onTitleChange={(title) => updateRuntimeTitle(terminal, title, "terminal")}
      />
    ),
    [activeTheme, updateRuntimeTitle],
  );

  const showMobileTerminalList = (terminal: MuxTerminal) => {
    const tabId = terminal.tabId ?? client.store.getSnapshot().activeTabId;
    const listUrl = muxSessionUrl(terminal.sessionId, tabId);
    if (history.state?.yaadeMobileTerminal === terminal.id) {
      history.back();
      return;
    }
    persistMuxSessionRoute(listUrl, localStorage);
    history.replaceState(null, "", listUrl);
    setRouteRevision((revision) => revision + 1);
  };

  const onPrefixHudSelect = (key: string) => {
    clearPrefix();
    if (isMuxSessionJumpKey(key)) {
      runMuxSessionCommand("terminal.jump", Number(key) - 1);
      return;
    }
    const binding = matchMuxSessionPrefixBinding(key);
    if (binding) runMuxSessionCommand(binding.command);
  };

  const activeServerConnection =
    serverConnections.snapshot.connections.find(
      (connection) => connection.id === serverConnections.snapshot.activeServerId,
    ) ?? serverConnections.snapshot.connections[0];
  const hostAccessRevoked = activeServerConnection?.status === "revoked";

  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion features={loadMotionFeatures}>
        <TooltipProvider delayDuration={400} skipDelayDuration={200}>
          <LayoutGroup id="yaade-terminal-multiplexer">
            <AmbientCanvas asChild>
              <div
                className="flex h-full min-h-0 flex-row overflow-hidden bg-transparent text-foreground"
                data-yaade-shell="terminal-multiplexer"
                data-yaade-session-layout={appearanceSettings.sessionLayout}
                data-yaade-sidebars-state={sidebarsCollapsed ? "collapsed" : "expanded"}
              >
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                  <Suspense fallback={<SessionLoadingState />}>
                    <TerminalDndRoot handlers={terminalTabDnd}>
                      {isMobile ? (
                        <MobileTerminalView
                          sessions={visibleSessions}
                          terminalsById={snapshot.terminalsById}
                          terminalIdsBySession={snapshot.terminalIdsBySession}
                          routeMuxTerminalId={parseMuxSessionRoute(location.href).muxTerminalId}
                          runtimeTitles={runtimeTitles}
                          onSelect={selectTerminal}
                          onShowTerminalList={showMobileTerminalList}
                          onCreateTerminal={(sessionId, kind) => createTerminal(kind, sessionId)}
                          onCreateSession={createSession}
                          onCloseSession={requestCloseSession}
                          actionError={actionError}
                          onCloseTerminal={(terminal) => runTerminalAction("archive", terminal)}
                          renderTerminal={renderTerminal}
                        />
                      ) : (
                        <>
                          {!sidebarLayout ? (
                            <header
                              className="flex shrink-0 items-center"
                              data-yaade-session-tabs=""
                              data-yaade-top-tabbar=""
                            >
                              <div
                                className="hidden shrink-0 items-center gap-1.5 lg:flex"
                                data-yaade-brand=""
                                aria-label="YAADE terminal workspace"
                              >
                                <span className="grid size-6 place-items-center rounded-[var(--yaade-control-radius)] bg-primary/10 text-primary">
                                  <TerminalIcon className="size-3.5" aria-hidden />
                                </span>
                                <span className="text-2xs font-semibold tracking-[0.1em] text-foreground/80">
                                  YAADE
                                </span>
                              </div>
                              <div
                                className="hidden h-4 w-px shrink-0 bg-border/60 lg:block"
                                aria-hidden
                              />
                              <SessionSwitcher
                                open={switcherOpen}
                                onOpenChange={setSwitcherOpen}
                                sessions={visibleSessions}
                                activeSessionId={snapshot.activeSessionId}
                                onSelect={(session) => selectSession(session.id)}
                                onCreate={() => void createSession()}
                                onClose={requestCloseSession}
                                onRename={(id, title) => void renameSession(id, title)}
                                terminalCounts={terminalCounts}
                                serverNamesBySessionId={serverNamesBySessionId}
                              />
                              <SessionWindowTabStrip
                                tabs={visibleTabs}
                                activeTabId={activeTab?.id}
                                onSelect={selectTab}
                                onCreate={() => void createTab()}
                                onClose={closeTab}
                                onRename={(id, title) => void renameTab(id, title)}
                                dockTerminalIdsByTab={dockTerminalIdsByTab}
                              />
                              <ShortcutTooltip
                                label="Settings"
                                shortcut={muxSessionDirectShortcutFor("settings.show")}
                                side="bottom"
                              >
                                <Button
                                  type="button"
                                  size="icon-sm"
                                  variant="ghost"
                                  aria-label="Settings"
                                  onClick={() => setSettingsOpen(true)}
                                  data-yaade-session-settings=""
                                  className="size-[var(--yaade-tab-pill-height)] shrink-0"
                                >
                                  <Settings />
                                </Button>
                              </ShortcutTooltip>
                            </header>
                          ) : null}
                          <div
                            className={cn(
                              "relative min-h-0 flex-1",
                              (twoSidebarLayout || singleSidebarLayout) &&
                                "grid max-md:flex max-md:flex-col yaade-terminal-multiplexer-grid",
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
                                serverNamesBySessionId={serverNamesBySessionId}
                                terminalCounts={terminalCounts}
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
                                  sidebarsCollapsed && "pointer-events-none max-md:hidden",
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
                                  serverNamesBySessionId={serverNamesBySessionId}
                                  terminalCounts={terminalCounts}
                                />
                                <TerminalTabStrip
                                  terminalIds={terminalIds}
                                  terminalsById={snapshot.terminalsById}
                                  activeMuxTerminalId={snapshot.activeMuxTerminalId}
                                  openMuxTerminalIds={openMuxTerminalIds}
                                  runtimeTitles={runtimeTitles}
                                  sessionTitlesById={sessionTitlesById}
                                  sectionLabel="Terminals"
                                  emptyLabel="No terminals yet"
                                  layout="single-sidebar"
                                  collapsed={sidebarsCollapsed}
                                  sidebarOrientation={sidebarOrientation}
                                  dockable
                                  dockableTerminalIds={activeSessionTerminalIds}
                                  onSelect={selectTerminal}
                                  onAddKind={(kind) => void createTerminal(kind)}
                                  onClose={(terminal) =>
                                    void runTerminalAction("archive", terminal)
                                  }
                                  onRename={(terminal, title) =>
                                    void renameMuxTerminal(terminal, title)
                                  }
                                  onReorder={(ids) => void reorderMuxTerminals(ids)}
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
                                  dockTerminalIdsByTab={dockTerminalIdsByTab}
                                />
                              ) : null}
                              {snapshot.connection === "reconciling" ||
                              snapshot.connection === "offline" ? (
                                <Alert className="m-4" data-yaade-connection={snapshot.connection}>
                                  <AlertTitle>
                                    {hostAccessRevoked
                                      ? "Access revoked"
                                      : snapshot.connection === "offline"
                                        ? "Host offline"
                                        : "Reconnecting"}
                                  </AlertTitle>
                                  <AlertDescription>
                                    {snapshot.connection === "offline"
                                      ? "Terminal state will refresh when the host returns."
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
                                  <SessionLoadingState />
                                ) : activeSession && activeTab ? (
                                  <TerminalTilingWorkspace
                                    workspace={activeTerminalWorkspace}
                                    terminalsById={snapshot.terminalsById}
                                    runtimeTitles={runtimeTitles}
                                    onPanelEvent={handleTerminalPanelEvent}
                                    onFocusPanel={focusWorkspacePanel}
                                    onAddSplitTerminal={addTerminalToSplitPanel}
                                    onSplit={splitTerminalPanelAt}
                                    onZoom={zoomTerminalPanel}
                                    onCloseView={closeWorkspacePane}
                                    onChromeOverlayChange={setPaneChromeOverlayOpen}
                                    renderTerminal={renderTerminal}
                                  />
                                ) : null}
                              </div>
                              {prefixPending ? <PrefixHud onSelect={onPrefixHudSelect} /> : null}
                            </main>
                            {twoSidebarLayout ? (
                              <div
                                className={
                                  twoSidebarLayout
                                    ? "relative col-start-3 min-h-0 min-w-0"
                                    : "relative shrink-0"
                                }
                              >
                                <TerminalTabStrip
                                  terminalIds={terminalIds}
                                  terminalsById={snapshot.terminalsById}
                                  activeMuxTerminalId={snapshot.activeMuxTerminalId}
                                  openMuxTerminalIds={openMuxTerminalIds}
                                  runtimeTitles={runtimeTitles}
                                  sessionTitlesById={sessionTitlesById}
                                  sectionLabel="Terminals"
                                  emptyLabel="No terminals yet"
                                  layout={twoSidebarLayout ? "two-sidebars" : "tabs"}
                                  collapsed={twoSidebarLayout ? sidebarsCollapsed : false}
                                  sidebarOrientation={sidebarOrientation}
                                  dockable
                                  dockableTerminalIds={activeSessionTerminalIds}
                                  onSelect={selectTerminal}
                                  onAddKind={(kind) => void createTerminal(kind)}
                                  onClose={(terminal) =>
                                    void runTerminalAction("archive", terminal)
                                  }
                                  onRename={(terminal, title) =>
                                    void renameMuxTerminal(terminal, title)
                                  }
                                  onReorder={(ids) => void reorderMuxTerminals(ids)}
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
                                label="Resize terminal sidebar"
                                onChange={resizeSidebar}
                              />
                            ) : null}
                          </div>
                        </>
                      )}
                    </TerminalDndRoot>
                  </Suspense>
                  {muxTerminalSwitcherOpen ? (
                    <Suspense fallback={null}>
                      <TerminalSwitcher
                        open
                        onOpenChange={setTerminalSwitcherOpen}
                        sessionsById={snapshot.sessionsById}
                        terminalsById={snapshot.terminalsById}
                        activeMuxTerminalId={snapshot.activeMuxTerminalId}
                        runtimeTitles={runtimeTitles}
                        onSelect={selectTerminal}
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
                        servers={serverConnections.servers}
                        serverConnections={serverConnections.snapshot.connections}
                        currentServerId="current-host"
                        onServersChange={serverConnections.updateServers}
                        onTestServer={serverConnections.testServer}
                      />
                    </Suspense>
                  ) : null}
                  <CloseSessionDialog
                    sessionId={closeChoice?.sessionId}
                    onCancel={() => setCloseChoice(undefined)}
                    onClose={(mode) =>
                      closeChoice ? void closeSession(closeChoice.sessionId, mode) : undefined
                    }
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

function SelectedMuxTerminal(props: ProcessTerminalViewProps) {
  return (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          Opening terminal…
        </div>
      }
    >
      <TerminalRenderer {...props} />
    </Suspense>
  );
}

function CloseSessionDialog(props: {
  sessionId?: SessionId;
  onCancel: () => void;
  onClose: (mode: "keep-running" | "stop-terminals") => void;
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
            Live terminals can keep running after this session is archived.
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
            onClick={() => props.onClose("stop-terminals")}
          >
            Stop terminals and archive
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
