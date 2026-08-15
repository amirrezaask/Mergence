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
import type {
  CheckoutTarget,
  CreateToolUse,
  ProjectTarget,
  SessionId,
  ToolKind,
  ToolUse,
  ToolUseId,
  ToolUseInput,
} from "@yaade/rpc";
import { MainCheckout } from "@yaade/rpc";
import type { ProjectSearchOptions, YaadeTheme } from "@yaade/shared";
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
import { WhichKeyPanel, cn, useIsMobile } from "@yaade/ui";
import { CHORD_TIMEOUT_MS } from "@yaade/workspace";
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
  chooseToolUse,
  parseToolSessionRoute,
  toolSessionUrl,
} from "./tool-session-routing.js";
import {
  type AgentProvider,
  type ToolContextSelection,
} from "./ToolContextControls.js";
import { SessionTabStrip } from "./SessionTabStrip.js";
import { SessionSwitcher } from "./SessionSwitcher.js";
import { ToolUseTabStrip } from "./ToolUseTabStrip.js";
import { SidebarResizeHandle } from "./SidebarResizeHandle.js";
import { ToolUseSwitcher } from "./ToolUseSwitcher.js";
import { nextRuntimeToolTitle, type RuntimeToolTitle } from "./tool-title.js";
import { SessionEmptyState, SessionBootState } from "./SessionEmptyState.js";
import {
  TOOL_SESSION_PREFIX,
  TOOL_SESSION_PREFIX_GROUPS,
  isToolSessionJumpKey,
  matchToolSessionContextBinding,
  matchToolSessionDirectBinding,
  matchToolSessionPrefixBinding,
  serializeToolSessionPrefixKey,
  toolSessionHudBindings,
} from "./tool-session-keymap.js";

const SettingsOverlay = lazy(() => import("@yaade/ui/settings"));

type CloseChoice = { readonly sessionId: SessionId } | undefined;

function isAgentProvider(value: string): value is AgentProvider {
  return (
    value === "claude" ||
    value === "codex" ||
    value === "cursor" ||
    value === "opencode" ||
    value === "grok" ||
    value === "pi"
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

function errorMessage(error: unknown): string {
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
    queueMicrotask(() => {
      performance.mark(end);
      try {
        performance.measure(name, start, end);
      } catch {
        /* ignore */
      }
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
  const [archivedSessions, setArchivedSessions] = useState<
    readonly import("@yaade/rpc").AppSession[]
  >([]);
  const [viewportIds, setViewportIds] = useState<readonly ToolUseId[]>([]);
  const [prefixPending, setPrefixPending] = useState(false);
  const [runtimeTitles, setRuntimeTitles] = useState<
    ReadonlyMap<ToolUseId, RuntimeToolTitle>
  >(() => new Map());
  const prefixPendingRef = useRef(false);
  const toolUsesRef = useRef(snapshot.usesById);
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
    const route = parseToolSessionRoute(location.href);
    const session = chooseSession(route.sessionId, [
      ...snapshot.sessionsById.values(),
    ]);
    if (!session) return;
    const ids = snapshot.useIdsBySession.get(session.id) ?? [];
    const useId = chooseToolUse(route.toolUseId, session, ids);
    if (snapshot.activeSessionId !== session.id)
      client.store.selectSession(session.id);
    if (useId && snapshot.activeToolUseId !== useId)
      client.store.selectToolUse(useId);
    const url = toolSessionUrl(session.id, useId);
    if (location.href !== new URL(url, location.origin).href)
      history.replaceState(null, "", url);
  }, [
    client,
    snapshot.activeSessionId,
    snapshot.activeToolUseId,
    snapshot.sessionsById,
    snapshot.useIdsBySession,
  ]);

  const visibleSessions = snapshot.visibleSessionIds
    .map((id) => snapshot.sessionsById.get(id))
    .filter((session): session is NonNullable<typeof session> =>
      Boolean(session),
    );
  const activeSession = snapshot.activeSessionId
    ? snapshot.sessionsById.get(snapshot.activeSessionId)
    : undefined;
  const useIds = activeSession
    ? (snapshot.useIdsBySession.get(activeSession.id) ?? [])
    : [];
  const toolCounts = useMemo(() => {
    const counts = new Map<SessionId, number>();
    for (const [id, ids] of snapshot.useIdsBySession) {
      counts.set(id, ids.length);
    }
    return counts;
  }, [snapshot.useIdsBySession]);
  const selected = snapshot.activeToolUseId
    ? snapshot.usesById.get(snapshot.activeToolUseId)
    : undefined;
  const processUses = useMemo(
    () =>
      [...snapshot.usesById.values()].filter(
        (use) => !use.archivedAt && use.output.kind === "process",
      ),
    [snapshot.usesById],
  );
  const twoSidebarLayout = appearanceSettings.sessionLayout === "two-sidebars";
  const singleSidebarLayout =
    appearanceSettings.sessionLayout === "single-sidebar";
  const sidebarLayout = twoSidebarLayout || singleSidebarLayout;
  const sidebarsCollapsed =
    sidebarLayout && appearanceSettings.sidebarCollapsed;
  const sidebarOrientation = useIsMobile() ? "horizontal" : "vertical";

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
    const agents = window.yaade?.agents;
    if (!agents?.onEvent) return;
    return agents.onEvent((payload) => {
      const event = payload.event;
      const prompt = event?.metadata?.prompt;
      if (event?.kind !== "prompt.submitted" || typeof prompt !== "string")
        return;
      const use = [...toolUsesRef.current.values()].find(
        (candidate) =>
          candidate.kind === "agent" &&
          candidate.output.kind === "process" &&
          candidate.output.terminalInstanceId === payload.sessionId,
      );
      if (use) updateRuntimeTitle(use, prompt, "prompt");
    });
  }, [updateRuntimeTitle]);

  useEffect(() => {
    if (!selected || selected.output.kind !== "process") return;
    setViewportIds((previous) => {
      const next = [
        ...previous.filter((id) => id !== selected.id),
        selected.id,
      ];
      const liveIds = new Set(processUses.map((use) => use.id));
      return next.filter((id) => liveIds.has(id)).slice(-6);
    });
  }, [processUses, selected]);

  const selectSession = useCallback(
    (id: SessionId) => {
      markPerformance("yaade:session-switch");
      client.store.selectSession(id);
      const session = client.store.getSnapshot().sessionsById.get(id);
      history.pushState(
        null,
        "",
        session ? toolSessionUrl(session.id, session.activeToolUseId) : "/",
      );
    },
    [client],
  );

  const selectTool = useCallback(
    (use: ToolUse) => {
      markPerformance("yaade:tool-switch");
      client.store.selectToolUse(use.id);
      history.pushState(null, "", toolSessionUrl(use.sessionId, use.id));
    },
    [client],
  );

  const createTool = useCallback(
    async (
      nextKind: ToolKind = "terminal",
      requestedProvider?: AgentProvider,
      launchContext?: ToolContextSelection,
    ) => {
      if (!activeSession) return;
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
          return;
        }
        let provider: AgentProvider = "codex";
        if (nextKind === "agent") {
          const list = await window.yaade?.agents?.listProviders?.();
          const preferred = requestedProvider
            ? list?.find(
                (item) => item.provider === requestedProvider && item.available,
              )
            : list?.find((item) => item.available);
          if (!preferred || !isAgentProvider(preferred.provider)) {
            setActionError(
              requestedProvider
                ? `${requestedProvider} is not available on this host.`
                : "No agent CLI is available on this host.",
            );
            return;
          }
          provider = preferred.provider;
        }
        const input: ToolUseInput =
          nextKind === "agent"
            ? { _tag: "AgentToolInput", kind: "agent", provider }
            : nextKind === "search"
              ? {
                  _tag: "SearchToolInput",
                  kind: "search",
                  query: "",
                  options: {},
                }
              : nextKind === "git"
                ? { _tag: "GitToolInput", kind: "git" }
                : nextKind === "editor"
                  ? { _tag: "EditorToolInput", kind: "editor" }
                  : { _tag: "TerminalToolInput", kind: "terminal" };
        const command: CreateToolUse = {
          _tag: "CreateToolUse",
          sessionId: activeSession.id,
          kind: nextKind,
          project: nextProject,
          checkout:
            launchContext?.checkout ?? MainCheckout.make({ kind: "main" }),
          input,
        };
        const created = await window.yaade?.tools?.createUse?.(command);
        if (created) client.store.replaceToolUse(created);
        await client.reconcile();
        if (created) selectTool(created);
      } catch (error) {
        setActionError(errorMessage(error));
      }
    },
    [activeSession, client, projects, selectTool],
  );

  const refreshArchived = useCallback(async () => {
    const all = await window.yaade?.tools?.listSessions?.(true);
    if (!all) return;
    setArchivedSessions(
      all
        .map((item) => item.session)
        .filter((session) => Boolean(session.archivedAt)),
    );
  }, []);

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
        await client.reconcile();
      } catch (error) {
        setActionError(errorMessage(error));
        await client.reconcile().catch(() => undefined);
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
            revision: 1,
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
      if (!activeSession) return;
      await window.yaade?.tools?.reorderUses?.({
        _tag: "ReorderToolUses",
        sessionId: activeSession.id,
        toolUseIds: ids,
      });
      await client.reconcile();
    },
    [activeSession, client],
  );

  const restoreSession = useCallback(
    async (session: import("@yaade/rpc").AppSession) => {
      const restored = await window.yaade?.tools?.restoreSession?.({
        _tag: "RestoreSession",
        sessionId: session.id,
      });
      await client.reconcile();
      if (restored) selectSession(restored.id);
    },
    [client, selectSession],
  );

  useEffect(() => {
    const bridge = window.__yaadeAgent;
    if (!bridge) return;
    const previous = {
      getState: bridge.getState,
      createSession: bridge.createSession,
      selectSession: bridge.selectSession,
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
    bridge.getState = () => ({
      ...previous.getState(),
      route: "session",
      activeSessionId: snapshot.activeSessionId ?? null,
      activeToolUseId: snapshot.activeToolUseId ?? null,
      sessions: visibleSessions,
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
      bridge.createToolUse = previous.createToolUse;
      bridge.selectToolUse = previous.selectToolUse;
      bridge.closeToolUse = previous.closeToolUse;
      bridge.closeSession = previous.closeSession;
      bridge.getPerfMeasures = previous.getPerfMeasures;
    };
  }, [
    closeSession,
    createSession,
    createTool,
    runToolAction,
    selectSession,
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
      if (command === "tool.newTerminal") void createTool("terminal");
      if (command === "editor.quickOpen") {
        window.dispatchEvent(new Event("yaade:quick-open"));
        return;
      }
      if (command === "tool.newAgent") void createTool("agent");
      if (command === "tool.newSearch") void createTool("search");
      if (command === "tool.newEditor") void createTool("editor");
      if (command === "tool.newGit") void createTool("git");
      if (command === "session.switch")
        void refreshArchived().then(() => setSwitcherOpen(true));
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
      if (command === "settings.show") setSettingsOpen(true);
      if (command === "sidebar.toggle") toggleSidebars();
    },
    [
      activeSession,
      createSession,
      createTool,
      refreshArchived,
      requestCloseSession,
      runToolAction,
      selectTool,
      selected,
      snapshot.usesById,
      toggleSidebars,
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

      const target = event.target as HTMLElement | null;
      const inEditable = Boolean(
        target?.closest("input, textarea, [contenteditable=true]"),
      );
      const inTerminal = Boolean(
        target?.closest("[data-yaade-terminal-input], [data-yaade-terminal-canvas]"),
      );
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
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        (event.key === "a" || event.code === "KeyA")
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
        event.ctrlKey &&
        (event.key === "a" || event.code === "KeyA") &&
        inTerminal
      ) {
        void window.yaade?.terminal?.write?.(
          selected?.output.kind === "process"
            ? (selected.output.ptyId ?? "")
            : "",
          "\u0001",
        );
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
    selected,
    settingsOpen,
    switcherOpen,
    toolUseSwitcherOpen,
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
        await client.reconcile();
      } catch (error) {
        setActionError(errorMessage(error));
        await client.reconcile().catch(() => undefined);
      }
    },
    [client],
  );

  const updateToolProvider = useCallback(
    async (use: ToolUse, provider: string) => {
      if (!isAgentProvider(provider)) return;
      const latest = client.store.getSnapshot().usesById.get(use.id) ?? use;
      if (latest.input.kind !== "agent") return;
      try {
        const updated = await window.yaade?.tools?.updateUseInput?.({
          _tag: "UpdateToolUseInput",
          toolUseId: latest.id,
          inputRevision: latest.inputRevision,
          input: {
            _tag: "AgentToolInput",
            kind: "agent",
            provider,
            ...(latest.input.args ? { args: latest.input.args } : {}),
          },
        });
        if (updated) client.store.replaceToolUse(updated);
        setActionError(undefined);
        await client.reconcile();
      } catch (error) {
        setActionError(errorMessage(error));
        await client.reconcile().catch(() => undefined);
      }
    },
    [client],
  );

  const renderPrefixHud = (placement: "main" | "dock") =>
    prefixPending ? (
      <div
        className={
          placement === "main"
            ? "pointer-events-none absolute inset-x-0 bottom-2 z-20 flex justify-center px-2"
            : "pointer-events-none absolute inset-x-0 bottom-full z-20 flex justify-center px-2 pb-2"
        }
      >
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
    <TooltipProvider delayDuration={400} skipDelayDuration={200}>
      <div
        className="flex h-full min-h-0 flex-col bg-background text-foreground"
        data-yaade-shell="tool-session"
        data-yaade-session-layout={appearanceSettings.sessionLayout}
        data-yaade-sidebars-state={sidebarsCollapsed ? "collapsed" : "expanded"}
      >
        {!sidebarLayout ? (
          <SessionTabStrip
            sessions={visibleSessions}
            activeSessionId={snapshot.activeSessionId}
            toolCounts={toolCounts}
            layout="tabs"
            onSelect={selectSession}
            onClose={requestCloseSession}
            onOpenSettings={() => setSettingsOpen(true)}
            onCreate={() => void createSession()}
            onRename={(id, title) => void renameSession(id, title)}
            onReorder={(ids) => void reorderSessions(ids)}
          />
        ) : null}
        <div
          className={cn(
            "relative min-h-0 flex-1",
            (twoSidebarLayout || singleSidebarLayout) &&
              "grid max-md:flex max-md:flex-col",
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
              toolCounts={toolCounts}
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
            <aside
              className={cn(
                "flex h-full min-h-0 w-full min-w-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground",
                sidebarsCollapsed && "hidden",
                "max-md:h-auto max-md:w-full max-md:border-r-0 max-md:border-b",
              )}
              aria-label="Navigation"
              data-yaade-single-sidebar=""
              data-yaade-sidebar-state={
                sidebarsCollapsed ? "collapsed" : "expanded"
              }
            >
              <ToolUseTabStrip
                useIds={useIds}
                usesById={snapshot.usesById}
                activeToolUseId={snapshot.activeToolUseId}
                runtimeTitles={runtimeTitles}
                projects={projects}
                layout="single-sidebar"
                collapsed={sidebarsCollapsed}
                sidebarOrientation={sidebarOrientation}
                onSelect={selectTool}
                onContextChange={updateToolContext}
                onProviderChange={updateToolProvider}
                onAddAgent={(provider) => void createTool("agent", provider)}
                onAddKind={(kind) => void createTool(kind)}
                onAddWithContext={(kind, project, checkout) =>
                  void createTool(kind, undefined, { project, checkout })
                }
                onClose={(use) => void runToolAction("archive", use)}
                onRename={(use, title) => void renameToolUse(use, title)}
                onReorder={(ids) => void reorderToolUses(ids)}
              />
              <SessionTabStrip
                sessions={visibleSessions}
                activeSessionId={snapshot.activeSessionId}
                toolCounts={toolCounts}
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
            </aside>
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
            {snapshot.connection === "connecting" &&
            visibleSessions.length === 0 ? (
              <SessionBootState />
            ) : selected ? (
              <ToolUseViewport
                selected={selected}
                processUses={processUses.filter((use) =>
                  viewportIds.includes(use.id),
                )}
                theme={activeTheme}
                fontSize={fontSize}
                projects={projects}
                results={snapshot.searchResultsByUseId.get(selected.id) ?? []}
                onContextChange={updateToolContext}
                onProviderChange={updateToolProvider}
                onAction={(action, use) => void runToolAction(action, use)}
                onTitleChange={(use, title) =>
                  updateRuntimeTitle(use, title, "terminal")
                }
                onSearchChange={async (use, next, options) => {
                  const latest =
                    client.store.getSnapshot().usesById.get(use.id) ?? use;
                  if (latest.input.kind !== "search") return;
                  try {
                    const updated = await window.yaade?.tools?.updateUseInput?.(
                      {
                        _tag: "UpdateToolUseInput",
                        toolUseId: latest.id,
                        inputRevision: latest.inputRevision,
                        input: {
                          _tag: "SearchToolInput",
                          kind: "search",
                          query: next,
                          options,
                        },
                      },
                    );
                    if (updated) {
                      client.store.replaceToolUse(updated);
                      await client.reconcile();
                    }
                  } catch (error) {
                    setActionError(errorMessage(error));
                  }
                }}
                onLoadMore={async (use) => {
                  if (use.output.kind !== "search" || !use.output.nextCursor)
                    return;
                  try {
                    await window.yaade?.tools?.loadMore?.(
                      use.id,
                      use.output.resultRevision,
                      Number(use.output.nextCursor),
                      100,
                    );
                    await client.reconcile();
                  } catch (error) {
                    setActionError(errorMessage(error));
                  }
                }}
              />
            ) : (
              <SessionEmptyState
                onAddKind={(kind) => void createTool(kind)}
              />
            )}
            {sidebarLayout ? renderPrefixHud("main") : null}
          </main>
          {twoSidebarLayout || !sidebarLayout ? (
            <div
              className={
                twoSidebarLayout
                  ? "relative col-start-3 min-h-0 min-w-0"
                  : "relative shrink-0"
              }
            >
              {!sidebarLayout ? renderPrefixHud("dock") : null}
              <ToolUseTabStrip
                useIds={useIds}
                usesById={snapshot.usesById}
                activeToolUseId={snapshot.activeToolUseId}
                runtimeTitles={runtimeTitles}
                projects={projects}
                layout={twoSidebarLayout ? "two-sidebars" : "tabs"}
                collapsed={twoSidebarLayout ? sidebarsCollapsed : false}
                sidebarOrientation={sidebarOrientation}
                onSelect={selectTool}
                onContextChange={updateToolContext}
                onProviderChange={updateToolProvider}
                onAddAgent={(provider) => void createTool("agent", provider)}
                onAddKind={(kind) => void createTool(kind)}
                onAddWithContext={(kind, project, checkout) =>
                  void createTool(kind, undefined, { project, checkout })
                }
                onClose={(use) => void runToolAction("archive", use)}
                onRename={(use, title) => void renameToolUse(use, title)}
                onReorder={(ids) => void reorderToolUses(ids)}
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
        <ToolUseSwitcher
          open={toolUseSwitcherOpen}
          onOpenChange={setToolUseSwitcherOpen}
          sessionsById={snapshot.sessionsById}
          usesById={snapshot.usesById}
          activeToolUseId={snapshot.activeToolUseId}
          runtimeTitles={runtimeTitles}
          onSelect={selectTool}
        />
        <SessionSwitcher
          open={switcherOpen}
          onOpenChange={setSwitcherOpen}
          sessions={visibleSessions}
          archived={archivedSessions}
          activeSessionId={snapshot.activeSessionId}
          onSelect={(session) => selectSession(session.id)}
          onRestore={(session) => void restoreSession(session)}
          toolCounts={toolCounts}
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
    </TooltipProvider>
  );
}

function ToolUseViewport(props: {
  readonly selected: ToolUse;
  readonly processUses: readonly ToolUse[];
  readonly theme: YaadeTheme;
  readonly fontSize: number;
  readonly projects: readonly ProjectTarget[];
  readonly results: readonly import("@yaade/rpc").ProjectSearchResult[];
  readonly onAction: (
    action: "cancel" | "restart" | "archive",
    use: ToolUse,
  ) => void;
  readonly onContextChange: (
    use: ToolUse,
    project: ProjectTarget,
    checkout: CheckoutTarget,
  ) => Promise<void>;
  readonly onProviderChange: (use: ToolUse, provider: string) => Promise<void>;
  readonly onSearchChange: (
    use: ToolUse,
    query: string,
    options: ProjectSearchOptions,
  ) => Promise<void>;
  readonly onLoadMore: (use: ToolUse) => Promise<void>;
  readonly onTitleChange: (use: ToolUse, title: string) => void;
}) {
  const processIds = new Set(props.processUses.map((use) => use.id));
  const render = (use: ToolUse, visible: boolean) => (
    <SelectedToolUse
      key={use.id}
      use={use}
      theme={props.theme}
      fontSize={props.fontSize}
      projects={props.projects}
      results={use.id === props.selected.id ? props.results : []}
      onContextChange={(project, checkout) =>
        props.onContextChange(use, project, checkout)
      }
      onProviderChange={(provider) => props.onProviderChange(use, provider)}
      visible={visible}
      onAction={(action) => props.onAction(action, use)}
      onSearchChange={(query, options) =>
        props.onSearchChange(use, query, options)
      }
      onLoadMore={() => props.onLoadMore(use)}
      onTitleChange={(title) => props.onTitleChange(use, title)}
    />
  );
  if (
    props.selected.output.kind === "process" &&
    processIds.has(props.selected.id)
  ) {
    return (
      <div
        className="relative flex min-h-0 flex-1"
        data-yaade-viewport-cache="process"
        data-yaade-viewport-count={props.processUses.length}
      >
        {props.processUses.map((use) => (
          <div
            key={use.id}
            data-yaade-tool-viewport={use.id}
            className={
              use.id === props.selected.id
                ? "absolute inset-0 flex"
                : "absolute inset-0 hidden"
            }
          >
            {render(use, use.id === props.selected.id)}
          </div>
        ))}
      </div>
    );
  }
  return render(props.selected, true);
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
  results: readonly import("@yaade/rpc").ProjectSearchResult[];
  visible?: boolean;
  onAction: (action: "cancel" | "restart" | "archive") => void;
  onContextChange: (
    project: ProjectTarget,
    checkout: CheckoutTarget,
  ) => Promise<void>;
  onProviderChange: (provider: string) => Promise<void>;
  onSearchChange: (
    query: string,
    options: ProjectSearchOptions,
  ) => Promise<void>;
  onLoadMore: () => Promise<void>;
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
        onProviderChange={props.onProviderChange}
        results={props.results}
        onSearchChange={props.onSearchChange}
        onLoadMore={props.onLoadMore}
        onTitleChange={props.onTitleChange}
        visible={props.visible}
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
