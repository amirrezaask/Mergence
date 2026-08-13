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
import { Activity, LoaderCircle } from "lucide-react";
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
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@yaade/ui/primitives";
import { WhichKeyPanel } from "@yaade/ui";
import { toolRegistry } from "./tool-registry.js";
import { useAppearanceSettings } from "../hooks/useAppearanceSettings.js";
import { createToolClient, type ToolClient } from "./tool-client.js";
import {
  chooseSession,
  chooseToolUse,
  parseToolSessionRoute,
  toolSessionUrl,
} from "./tool-session-routing.js";
import { type AgentProvider } from "./ToolContextControls.js";
import { SessionTabStrip } from "./SessionTabStrip.js";
import { SessionSwitcher } from "./SessionSwitcher.js";
import { SidebarOpenButton, ToolUseSidebar } from "./ToolUseSidebar.js";
import {
  TOOL_SESSION_DIRECT_BINDINGS,
  TOOL_SESSION_PREFIX,
  TOOL_SESSION_PREFIX_BINDINGS,
} from "./tool-session-keymap.js";

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
  const { activeTheme } = useAppearanceSettings();
  const [client] = useState<ToolClient>(() => createToolClient());
  const snapshot = useSyncExternalStore(
    client.store.subscribe,
    client.store.getSnapshot,
    client.store.getSnapshot,
  );
  const [projects, setProjects] = useState<readonly ProjectTarget[]>([]);
  const [closeChoice, setCloseChoice] = useState<CloseChoice>();
  const [actionError, setActionError] = useState<string | undefined>();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [archivedSessions, setArchivedSessions] = useState<
    readonly import("@yaade/rpc").AppSession[]
  >([]);
  const [viewportIds, setViewportIds] = useState<readonly ToolUseId[]>([]);
  const [prefixPending, setPrefixPending] = useState(false);
  const prefixPendingRef = useRef(false);

  useEffect(() => {
    prefixPendingRef.current = prefixPending;
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
    async (nextKind: ToolKind = "terminal") => {
      if (!activeSession) return;
      setActionError(undefined);
      try {
        let nextProjects = projects;
        if (nextProjects.length === 0) {
          nextProjects = (await window.yaade?.tools?.listProjects?.()) ?? [];
          setProjects(nextProjects);
        }
        const nextProject = nextProjects[0];
        if (!nextProject) {
          setActionError("No project available.");
          return;
        }
        let provider: AgentProvider = "codex";
        if (nextKind === "agent") {
          const list = await window.yaade?.agents?.listProviders?.();
          const preferred = list?.find((item) => item.available);
          if (!preferred || !isAgentProvider(preferred.provider)) {
            setActionError("No agent CLI is available on this host.");
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
              : { _tag: "TerminalToolInput", kind: "terminal" };
        const command: CreateToolUse = {
          _tag: "CreateToolUse",
          sessionId: activeSession.id,
          kind: nextKind,
          project: nextProject,
          checkout: MainCheckout.make({ kind: "main" }),
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (switcherOpen || closeChoice) return;
      const target = event.target as HTMLElement | null;
      const inEditable = Boolean(
        target?.closest("input, textarea, [contenteditable=true]"),
      );
      const inXterm = Boolean(target?.closest(".xterm"));
      if (inEditable && !inXterm) return;

      const chord = [
        event.metaKey || event.ctrlKey ? "Mod" : null,
        event.shiftKey ? "Shift" : null,
        event.altKey ? "Alt" : null,
        event.key.length === 1 ? event.key : event.code.replace(/^Key/, ""),
      ]
        .filter(Boolean)
        .join("-");

      const matchDirect = TOOL_SESSION_DIRECT_BINDINGS.find(
        (binding) =>
          binding.key === chord || binding.key === `Mod-Shift-${event.key}`,
      );
      void matchDirect;
      if (
        !prefixPendingRef.current &&
        (event.key === "p" || event.code === "KeyP") &&
        event.shiftKey &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault();
        event.stopPropagation();
        void refreshArchived().then(() => setSwitcherOpen(true));
        return;
      }
      if (
        !prefixPendingRef.current &&
        event.key === "," &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

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
      prefixPendingRef.current = false;
      setPrefixPending(false);
      if (
        event.ctrlKey &&
        (event.key === "a" || event.code === "KeyA") &&
        inXterm
      ) {
        void window.yaade?.terminal?.write?.(
          selected?.output.kind === "process"
            ? (selected.output.ptyId ?? "")
            : "",
          "\u0001",
        );
        return;
      }
      const key =
        event.shiftKey && event.key.length === 1
          ? `Shift-${event.key.toUpperCase()}`
          : event.key.length === 1
            ? event.key.toLowerCase()
            : event.key;
      const binding = TOOL_SESSION_PREFIX_BINDINGS.find(
        (item) => item.key === key || item.key === event.key,
      );
      if (!binding) return;
      if (binding.command === "session.new") void createSession();
      if (binding.command === "tool.new") void createTool();
      if (binding.command === "session.switch")
        void refreshArchived().then(() => setSwitcherOpen(true));
      if (
        binding.command === "tool.next" ||
        binding.command === "tool.previous"
      ) {
        if (!selected || useIds.length === 0) return;
        const index = useIds.indexOf(selected.id);
        const nextIndex =
          binding.command === "tool.next"
            ? (index + 1) % useIds.length
            : (index - 1 + useIds.length) % useIds.length;
        const next = snapshot.usesById.get(useIds[nextIndex]!);
        if (next) selectTool(next);
      }
      if (binding.command === "tool.close" && selected)
        void runToolAction("archive", selected);
      if (binding.command === "session.close" && activeSession)
        requestCloseSession(activeSession.id);
      if (binding.command === "ui.showCommandPalette")
        void refreshArchived().then(() => setSwitcherOpen(true));
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    activeSession,
    closeChoice,
    createSession,
    createTool,
    refreshArchived,
    requestCloseSession,
    runToolAction,
    selectTool,
    selected,
    snapshot.usesById,
    switcherOpen,
    useIds,
  ]);

  const whichKeyEntries = TOOL_SESSION_PREFIX_BINDINGS.map((binding) => ({
    key: binding.key,
    desc: binding.desc,
  }));

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
      data-yaade-shell="tool-session"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 md:hidden">
        <SidebarOpenButton onClick={() => setSidebarOpen(true)} />
      </div>
      <SessionTabStrip
        sessions={visibleSessions}
        activeSessionId={snapshot.activeSessionId}
        onSelect={selectSession}
        onClose={requestCloseSession}
        onCreate={() => void createSession()}
        onRename={(id, title) => void renameSession(id, title)}
        onReorder={(ids) => void reorderSessions(ids)}
      />
      <div className="relative flex min-h-0 flex-1">
        <ToolUseSidebar
          open={sidebarOpen}
          onOpenChange={setSidebarOpen}
          useIds={useIds}
          usesById={snapshot.usesById}
          activeToolUseId={snapshot.activeToolUseId}
          onSelect={selectTool}
          onAddKind={(kind) => void createTool(kind)}
          onRename={(use, title) => void renameToolUse(use, title)}
          onReorder={(ids) => void reorderToolUses(ids)}
        />
        <main className="flex min-w-0 flex-1 flex-col">
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
          {selected ? (
            <ToolUseViewport
              selected={selected}
              processUses={processUses.filter((use) =>
                viewportIds.includes(use.id),
              )}
              theme={activeTheme}
              projects={projects}
              results={snapshot.searchResultsByUseId.get(selected.id) ?? []}
              onContextChange={async (use, nextProject, checkout) => {
                const latest =
                  client.store.getSnapshot().usesById.get(use.id) ?? use;
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
              }}
              onProviderChange={async (use, provider) => {
                const latest =
                  client.store.getSnapshot().usesById.get(use.id) ?? use;
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
              }}
              onAction={(action, use) => void runToolAction(action, use)}
              onSearchChange={async (use, next, options) => {
                const latest =
                  client.store.getSnapshot().usesById.get(use.id) ?? use;
                if (latest.input.kind !== "search") return;
                try {
                  const updated = await window.yaade?.tools?.updateUseInput?.({
                    _tag: "UpdateToolUseInput",
                    toolUseId: latest.id,
                    inputRevision: latest.inputRevision,
                    input: {
                      _tag: "SearchToolInput",
                      kind: "search",
                      query: next,
                      options,
                    },
                  });
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
            <EmptySession />
          )}
        </main>
      </div>
      {prefixPending ? (
        <WhichKeyPanel prefix={TOOL_SESSION_PREFIX} entries={whichKeyEntries} />
      ) : null}
      <SessionSwitcher
        open={switcherOpen}
        onOpenChange={setSwitcherOpen}
        sessions={visibleSessions}
        archived={archivedSessions}
        activeSessionId={snapshot.activeSessionId}
        onSelect={(session) => selectSession(session.id)}
        onRestore={(session) => void restoreSession(session)}
      />
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
  );
}

function EmptySession() {
  return (
    <div className="grid h-full place-items-center p-8">
      <Empty>
        <EmptyHeader>
          <Activity className="size-7 text-muted-foreground" />
          <EmptyTitle>Add a tool to start this session</EmptyTitle>
        </EmptyHeader>
        <EmptyDescription>
          Run a terminal, launch an agent, or search the project.
        </EmptyDescription>
      </Empty>
    </div>
  );
}

function ToolUseViewport(props: {
  readonly selected: ToolUse;
  readonly processUses: readonly ToolUse[];
  readonly theme: YaadeTheme;
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
}) {
  const processIds = new Set(props.processUses.map((use) => use.id));
  const render = (use: ToolUse, visible: boolean) => (
    <SelectedToolUse
      key={use.id}
      use={use}
      theme={props.theme}
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
}) {
  const { use } = props;
  const Renderer = rendererFor(use.kind);
  if (!Renderer) return null;
  return (
    <Suspense
      fallback={
        <div className="grid flex-1 place-items-center text-sm text-muted-foreground">
          <LoaderCircle className="mr-2 size-4 animate-spin" />
          Opening tool…
        </div>
      }
    >
      <Renderer
        use={use}
        theme={props.theme}
        toolbar={null}
        projects={props.projects}
        onContextChange={props.onContextChange}
        onProviderChange={props.onProviderChange}
        results={props.results}
        onSearchChange={props.onSearchChange}
        onLoadMore={props.onLoadMore}
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
        <DialogFooter>
          <Button variant="outline" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={() => props.onClose("keep-running")}
          >
            Keep running and archive
          </Button>
          <Button
            variant="destructive"
            onClick={() => props.onClose("stop-tools")}
          >
            Stop tools and archive
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
