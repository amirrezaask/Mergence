import { Effect, Schema } from "effect";
import {
  createDirectory,
  createFile,
  emptyTrash,
  fileSearch,
  exists,
  isSearchSupported,
  isSearchScanReady,
  listTrash,
  listProjectFiles,
  loadGlobalYaadercScanRoots,
  openInApp,
  revealInFolder,
  projectSearch,
  readDir,
  readFile,
  readTextFile,
  renamePath,
  restoreTrash,
  spawnTask,
  stat,
  trackFileAccess,
  trashPath,
  writeFile,
  writeTextFile,
  writeTempDrop,
  assertAllowedUri,
  type TerminalLaunch,
} from "@yaade/node-host";
import {
  ArchiveSession,
  ArchiveToolUse,
  CancelToolUse,
  CreateSession,
  CreateToolUse,
  GetSession,
  GetToolUse,
  ListSearchResults,
  ListSessions,
  ListCheckoutTargets,
  ReorderSessions,
  ReorderToolUses,
  RestoreSession,
  RenameSession,
  RestartToolUse,
  SearchToolOutput,
  SelectSessionToolUse,
  SessionNotFound,
  ToolUseNotFound,
  InvalidToolInput,
  InvalidToolCommand,
  ProjectTargetUnavailable,
  CheckoutResolutionFailed,
  ToolUseConflict,
  ToolRuntimeFailure,
  SessionArchived,
  SessionCreated,
  SessionRestored,
  SessionUpdated,
  ToolUseArchived,
  ToolUseCreated,
  ToolUseOutputChanged,
  ToolUseUpdated,
  UpdateToolUseInput,
  UpdateToolUseContext,
  ConflictError,
  OperationFailedError,
  FileChangedError,
  LspLogRequest,
  LspResolveRequest,
  NotFoundError,
  PathOutsideRootsError,
  PayloadTooLargeError,
  ResolvedLanguageServerTarget,
  TextFileWriteOptions,
  UnknownChannelError,
  unknownChannel,
  type HostRpcError,
} from "@yaade/rpc";
import type {
  BindNotificationSessionRequest,
  FileSearchOptions,
  IngestNotificationRequest,
  ListNotificationsRequest,
  MarkAllNotificationsReadRequest,
  NotificationPreferences,
  ProjectSearchOptions,
} from "@yaade/shared";
import { fileUriToPath, pathToFileUri } from "@yaade/shared";
import { getCliAgentDriver } from "@yaade/agents";
import { GitServiceLive, GitServiceTag } from "./effect/git.js";
import { HostRuntimeTag, LspHostTag } from "./effect/tags.js";
import type { HostRuntime } from "./host-runtime.js";
import type { ToolService } from "./tools/service.js";
import { normalizeHookEventName } from "./notifications/index.js";
import { installProjectHooksForProvider } from "./agents/index.js";
import {
  createTerminalInstance as createSharedTerminalInstance,
  restartTerminalInstance,
} from "./tools/process-driver.js";
import { ToolDriverFailure } from "./tools/errors.js";

export type { HostRuntime } from "./host-runtime.js";
export { createRuntime, shutdownRuntime } from "./host-runtime.js";

function requiredToolService(runtime: HostRuntime): ToolService {
  if (!runtime.toolService) throw new Error("ToolService is not initialized");
  return runtime.toolService;
}

function decodeToolCommand<S extends Schema.Schema.AnyNoContext>(
  schema: S,
  value: unknown,
  name: string,
): Schema.Schema.Type<S> {
  try {
    return Schema.decodeUnknownSync(schema)(value);
  } catch {
    throw new InvalidToolCommand({ message: `invalid ${name} command` });
  }
}

export function mapDispatchError(
  channel: string,
  error: unknown,
): HostRpcError {
  if (
    error instanceof ConflictError ||
    error instanceof FileChangedError ||
    error instanceof NotFoundError ||
    error instanceof PathOutsideRootsError ||
    error instanceof PayloadTooLargeError ||
    error instanceof SessionNotFound ||
    error instanceof ToolUseNotFound ||
    error instanceof InvalidToolInput ||
    error instanceof InvalidToolCommand ||
    error instanceof ProjectTargetUnavailable ||
    error instanceof CheckoutResolutionFailed ||
    error instanceof ToolUseConflict ||
    error instanceof ToolRuntimeFailure
  ) {
    return error;
  }
  if (error instanceof ToolDriverFailure) {
    return new ToolRuntimeFailure({
      toolUseId: error.toolUseId,
      message: error.message,
      cause: error.cause,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("not allowed") || message.includes("PATH_OUTSIDE")) {
    return new PathOutsideRootsError({ message });
  }
  if (message.startsWith("unknown host channel:")) {
    return unknownChannel(channel);
  }
  if (message.startsWith("unknown")) {
    return new UnknownChannelError({ channel, message });
  }
  return new OperationFailedError({ message, cause: error });
}

export type DispatchEnv = HostRuntimeTag | LspHostTag | GitServiceTag;

export function dispatch(
  channel: string,
  args: unknown[],
  clientId: string,
  signal?: AbortSignal,
): Effect.Effect<unknown, HostRpcError, DispatchEnv> {
  return Effect.gen(function* () {
    if (channel.startsWith("git:")) {
      return yield* handleGitEffect(channel, args);
    }
    if (channel.startsWith("lsp:")) {
      return yield* handleLspEffect(channel, args);
    }
    const runtime = yield* HostRuntimeTag;
    return yield* Effect.tryPromise({
      try: () => dispatchImpl(runtime, channel, args, clientId, signal),
      catch: (err) => mapDispatchError(channel, err),
    });
  });
}

export function dispatchPromise(
  runtime: HostRuntime,
  channel: string,
  args: unknown[],
  clientId: string,
  signal?: AbortSignal,
): Promise<unknown> {
  return Effect.runPromise(
    dispatch(channel, args, clientId, signal).pipe(
      Effect.provideService(HostRuntimeTag, runtime),
      Effect.provideService(LspHostTag, runtime.lsp),
      Effect.provide(GitServiceLive),
    ),
  );
}

async function dispatchImpl(
  runtime: HostRuntime,
  channel: string,
  args: unknown[],
  clientId: string,
  signal?: AbortSignal,
): Promise<unknown> {
  if (
    channel === "fs:showOpenFolderDialog" ||
    channel === "fs:showSaveFileDialog"
  )
    return null;
  if (channel === "yaade:getLaunchConfig") return runtime.config.launchConfig;
  if (channel === "yaade:getHomeDir") return runtime.homeDir;
  if (channel === "yaade:loadGlobalYaadercScanRoots") {
    return loadGlobalYaadercScanRoots(runtime.homeDir);
  }

  if (channel.startsWith("agents:")) {
    return handleAgents(runtime, channel, args, clientId);
  }
  if (channel.startsWith("notifications:")) {
    return handleNotifications(runtime, channel, args);
  }
  if (channel.startsWith("tools:"))
    return handleTools(runtime, channel, args, clientId);
  if (channel.startsWith("fs:")) return handleFs(runtime, channel, args);
  if (channel.startsWith("search:"))
    return handleSearch(runtime, channel, args, signal);
  if (channel.startsWith("workspace:")) {
    return handleWorkspace(runtime, channel, args, clientId);
  }
  if (channel.startsWith("terminal:"))
    return handleTerminal(runtime, channel, args, clientId);
  if (channel.startsWith("shell:")) return handleShell(channel, args);
  if (channel.startsWith("tasks:")) return handleTasks(channel, args);
  if (channel.startsWith("perf:")) return handlePerf(runtime, channel, args);

  throw new Error(`unknown host channel: ${channel}`);
}

async function handleTools(
  runtime: HostRuntime,
  channel: string,
  args: unknown[],
  clientId: string,
): Promise<unknown> {
  const store = runtime.toolSessions;
  switch (channel) {
    case "tools:listSessions": {
      const command = decodeToolCommand(
        ListSessions,
        {
          _tag: "ListSessions",
          ...(args[0] === true ? { includeArchived: true } : {}),
        },
        "list sessions",
      );
      return store
        .listSessions(command.includeArchived === true)
        .map((session) => ({
          session,
          toolUses: store.listToolUses(
            session.id,
            command.includeArchived === true,
          ),
        }));
    }
    case "tools:createSession": {
      const command = decodeToolCommand(
        CreateSession,
        {
          _tag: "CreateSession",
          ...(typeof args[0] === "string" ? { title: args[0] } : {}),
        },
        "create session",
      );
      const session = store.createSession(command.title ?? "New session");
      runtime.events.emit("tools:event", [
        SessionCreated.make({
          eventId: `evt-${Date.now()}`,
          revision: 1,
          occurredAt: session.updatedAt,
          session,
        }),
      ]);
      const project = runtime.db.projects()[0];
      if (project) {
        await requiredToolService(runtime).ensureDefaultToolsForSession(
          session.id,
          project,
          clientId,
        );
      }
      return store.getSession(session.id) ?? session;
    }
    case "tools:reorderSessions": {
      const command = decodeToolCommand(
        ReorderSessions,
        args[0],
        "reorder sessions",
      );
      return store.reorderSessions(command.sessionIds);
    }
    case "tools:archiveSession": {
      const command = decodeToolCommand(
        ArchiveSession,
        args[0],
        "archive session",
      );
      return requiredToolService(runtime).archiveSession(
        command.sessionId,
        command.mode === "stop-tools",
      );
    }
    case "tools:restoreSession": {
      const command = decodeToolCommand(
        RestoreSession,
        args[0],
        "restore session",
      );
      const session = store.restoreSession(command.sessionId);
      runtime.events.emit("tools:event", [
        SessionRestored.make({
          eventId: `evt-${Date.now()}`,
          revision: 1,
          occurredAt: session.updatedAt,
          session,
        }),
      ]);
      return session;
    }
    case "tools:renameSession": {
      const command = decodeToolCommand(
        RenameSession,
        {
          _tag: "RenameSession",
          sessionId: args[0],
          title: args[1],
        },
        "rename session",
      );
      const session = store.renameSession(command.sessionId, command.title);
      runtime.events.emit("tools:event", [
        SessionUpdated.make({
          eventId: `evt-${Date.now()}`,
          revision: 1,
          occurredAt: session.updatedAt,
          session,
        }),
      ]);
      return session;
    }
    case "tools:getSession": {
      const command = decodeToolCommand(
        GetSession,
        {
          _tag: "GetSession",
          sessionId: args[0],
        },
        "get session",
      );
      const session = store.getSession(command.sessionId);
      return session
        ? { session, toolUses: store.listToolUses(session.id) }
        : null;
    }
    case "tools:getUse": {
      const command = decodeToolCommand(
        GetToolUse,
        {
          _tag: "GetToolUse",
          toolUseId: args[0],
        },
        "get tool use",
      );
      return store.getToolUse(command.toolUseId);
    }
    case "tools:updateUseInput": {
      const command = decodeToolCommand(
        UpdateToolUseInput,
        args[0],
        "update tool input",
      );
      return requiredToolService(runtime).updateInput(
        command.toolUseId,
        command.inputRevision,
        command.input,
        clientId,
      );
    }
    case "tools:updateUseContext": {
      const command = decodeToolCommand(
        UpdateToolUseContext,
        args[0],
        "update tool context",
      );
      const current = store.getToolUse(command.toolUseId);
      if (!current)
        throw new ToolUseNotFound({
          toolUseId: command.toolUseId,
          message: "tool use not found",
        });
      return requiredToolService(runtime).updateContext(
        {
          _tag: "CreateToolUse",
          sessionId: current.sessionId,
          kind: current.kind,
          project: command.project,
          checkout: command.checkout,
          input: current.input,
        },
        current.id,
        command.revision,
        clientId,
      );
    }
    case "tools:listSearchResults": {
      const command = decodeToolCommand(
        ListSearchResults,
        args[0],
        "list search results",
      );
      return store.listSearchResults(
        command.toolUseId,
        command.resultRevision,
        command.cursor ?? 0,
        command.limit ?? 100,
      );
    }
    case "tools:loadMore": {
      const command = decodeToolCommand(
        ListSearchResults,
        args[0],
        "load more search results",
      );
      await requiredToolService(runtime).loadMore(
        command.toolUseId,
        command.resultRevision,
        command.cursor ?? 0,
      );
      return store.listSearchResults(
        command.toolUseId,
        command.resultRevision,
        command.cursor ?? 0,
        command.limit ?? 100,
      );
    }
    case "tools:reorderUses": {
      const command = decodeToolCommand(
        ReorderToolUses,
        args[0],
        "reorder tool uses",
      );
      return store.reorderToolUses(command.sessionId, command.toolUseIds);
    }
    case "tools:selectUse": {
      const command = decodeToolCommand(
        SelectSessionToolUse,
        {
          _tag: "SelectSessionToolUse",
          sessionId: args[0],
          ...(args[1] == null ? {} : { toolUseId: args[1] }),
        },
        "select tool use",
      );
      return store.setActiveToolUse(
        command.sessionId,
        command.toolUseId ?? null,
      );
    }
    case "tools:createUse": {
      const command = decodeToolCommand(
        CreateToolUse,
        args[0],
        "create tool use",
      );
      return requiredToolService(runtime).create(command, clientId);
    }
    case "tools:cancelUse": {
      const command = decodeToolCommand(
        CancelToolUse,
        {
          _tag: "CancelToolUse",
          toolUseId: args[0],
          revision: args[1],
        },
        "cancel tool use",
      );
      return requiredToolService(runtime).cancel(
        command.toolUseId,
        command.revision,
      );
    }
    case "tools:restartUse": {
      const command = decodeToolCommand(
        RestartToolUse,
        {
          _tag: "RestartToolUse",
          toolUseId: args[0],
          revision: args[1],
        },
        "restart tool use",
      );
      return requiredToolService(runtime).restart(
        command.toolUseId,
        command.revision,
        clientId,
      );
    }
    case "tools:archiveUse": {
      const command = decodeToolCommand(
        ArchiveToolUse,
        args[0],
        "archive tool use",
      );
      const use = store.archiveToolUse(command.toolUseId);
      runtime.events.emit("tools:event", [
        ToolUseArchived.make({
          eventId: `evt-${Date.now()}`,
          toolUseId: use.id,
          revision: use.revision,
          occurredAt: use.updatedAt,
        }),
      ]);
      return use;
    }
    case "tools:renameUse": {
      const toolUseId = args[0];
      const title = typeof args[1] === "string" ? args[1] : "";
      if (typeof toolUseId !== "string" || !title.trim())
        throw new InvalidToolCommand({
          message: "invalid rename tool use command",
        });
      const use = store.renameToolUse(toolUseId as never, title);
      runtime.events.emit("tools:event", [
        ToolUseUpdated.make({
          eventId: `evt-${Date.now()}`,
          toolUseId: use.id,
          revision: use.revision,
          occurredAt: use.updatedAt,
          toolUse: use,
        }),
      ]);
      return use;
    }
    case "tools:listProjects":
      return runtime.db
        .projects()
        .map((project) => ({
          projectId: project.id,
          projectPath: project.rootPath,
          projectName: project.name,
        }));
    case "tools:listCheckoutTargets": {
      const command = decodeToolCommand(
        ListCheckoutTargets,
        args[0],
        "list checkout targets",
      );
      const project = runtime.db.project(command.projectId);
      if (!project) throw new Error("project is unavailable");
      let trees: readonly {
        readonly path: string;
        readonly branch?: string | null;
      }[] = [];
      try {
        trees = await import("@yaade/node-host").then(({ gitWorktreeList }) =>
          gitWorktreeList(pathToFileUri(project.rootPath)),
        );
      } catch (error) {
        // A plain directory is still a valid Main checkout. Worktree discovery
        // is best-effort for the nested menu and must not block tool creation.
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("not a git repository")) throw error;
      }
      return [
        { kind: "main", path: project.rootPath, branch: null },
        ...trees.filter((tree) => tree.path !== project.rootPath),
      ];
    }
    default:
      throw new Error(`unknown tools channel: ${channel}`);
  }
}

function handleNotifications(
  runtime: HostRuntime,
  channel: string,
  args: unknown[],
): unknown {
  const n = runtime.notifications;
  switch (channel) {
    case "notifications:list":
      return n.list((args[0] as ListNotificationsRequest | undefined) ?? {});
    case "notifications:counts":
      return n.counts();
    case "notifications:get":
      return n.get(str(args[0], "id"));
    case "notifications:ingest": {
      const body = args[0] as IngestNotificationRequest;
      if (!body || typeof body !== "object")
        throw new Error("missing ingest body");
      if (typeof body.title !== "string" || !body.title.trim()) {
        throw new Error("ingest requires title");
      }
      if (body.title.length > 240) throw new Error("ingest title is too long");
      if (body.message != null && body.message.length > 8_000) {
        throw new Error("ingest message is too long");
      }
      if (
        ![
          "turn-completed",
          "input-required",
          "permission-required",
          "failed",
          "process-exited",
          "session-started",
          "provider-notification",
          "background-output",
          "system",
        ].includes(body.type)
      ) {
        throw new Error("ingest type is invalid");
      }
      if (
        ![
          "interactive-runtime",
          "provider-hook",
          "provider-plugin",
          "osc",
          "process",
          "system",
          "aggregated-pty",
        ].includes(body.source)
      ) {
        throw new Error("ingest source is invalid");
      }
      const request = { ...body };
      // Normalize hook event names when providerEvent is set without type refinement.
      if (request.providerEvent && request.type === "provider-notification") {
        const mapped = normalizeHookEventName(request.providerEvent);
        if (mapped) request.type = mapped;
      }
      return n.ingest(request);
    }
    case "notifications:markRead":
      return n.markRead(str(args[0], "id"));
    case "notifications:markUnread":
      return n.markUnread(str(args[0], "id"));
    case "notifications:dismiss":
      return n.dismiss(str(args[0], "id"));
    case "notifications:restore":
      return n.restore(str(args[0], "id"));
    case "notifications:acknowledge":
      return n.acknowledge(str(args[0], "id"));
    case "notifications:markAllRead":
      return n.markAllRead(
        (args[0] as MarkAllNotificationsReadRequest | undefined) ?? {},
      );
    case "notifications:unreadBySession":
      return n.unreadBySession();
    case "notifications:markSessionUnread":
      return n.markSessionUnread(str(args[0], "sessionId"));
    case "notifications:getPreferences":
      return n.getPreferences();
    case "notifications:setPreferences":
      return n.setPreferences(
        (args[0] as Partial<NotificationPreferences> | undefined) ?? {},
      );
    case "notifications:bindSession": {
      const body = args[0] as BindNotificationSessionRequest;
      if (!body?.sessionId) throw new Error("bindSession requires sessionId");
      n.bindSession({
        sessionId: body.sessionId,
        projectId: body.projectId ?? null,
        projectName: body.projectName ?? null,
        sessionTitle: body.sessionTitle ?? null,
        provider: body.provider ?? null,
        ptyId: body.ptyId ?? null,
      });
      const provider = parseAgentProvider(body.provider ?? "");
      if (provider && body.ptyId) {
        runtime.agents.onProcessStarted({
          provider,
          sessionId: body.sessionId,
          processId: body.ptyId,
          projectId: body.projectId ?? undefined,
        });
      }
      return { ok: true };
    }
    case "notifications:runRetention":
      return n.runRetention();
    default:
      throw new Error(`unknown notifications channel: ${channel}`);
  }
}

async function handleAgents(
  runtime: HostRuntime,
  channel: string,
  args: unknown[],
  clientId: string,
): Promise<unknown> {
  const agents = runtime.agents;
  switch (channel) {
    case "agents:listProviders":
      return runtime.agentRuns.listProviders(args[0] === true);
    case "agents:listLive": {
      const projectId =
        typeof args[0] === "string" && args[0] ? args[0] : undefined;
      return runtime.terminalInstances
        .listLive(projectId)
        .filter((instance) => instance.provider)
        .map(instanceToAgentRunInfo);
    }
    case "agents:listProject":
      return runtime.terminalInstances
        .listProject(str(args[0], "projectId"))
        .filter((instance) => instance.provider)
        .map(instanceToAgentRunInfo);
    case "agents:get": {
      const instance = runtime.terminalInstances.get(str(args[0], "runId"));
      return instance?.provider
        ? instanceToAgentRunInfo(instance)
        : runtime.agentRuns.get(str(args[0], "runId"));
    }
    case "agents:getTranscript": {
      const fromInstance = runtime.terminalInstances.transcript(
        str(args[0], "runId"),
      );
      return (
        fromInstance ?? runtime.agentRuns.transcript(str(args[0], "runId"))
      );
    }
    case "agents:listActivity": {
      const body =
        (args[0] as
          | { limit?: number; cursor?: string; projectId?: string }
          | undefined) ?? {};
      return runtime.agentRuns.listActivity(body);
    }
    case "agents:launch": {
      const body = args[0] as {
        launchRequestId?: string;
        provider?: string;
        projectId?: string;
        workspaceId?: string;
        checkoutKey?: string;
        checkoutPath?: string;
        title?: string;
        args?: string[];
      };
      if (
        !body?.launchRequestId ||
        !body.provider ||
        !body.projectId ||
        !body.workspaceId
      ) {
        throw new Error(
          "agents:launch requires launchRequestId, provider, projectId, and workspaceId",
        );
      }
      const instance = await createTerminalInstance(
        runtime,
        {
          projectId: body.projectId,
          workspaceId: body.workspaceId,
          checkoutKey: body.checkoutKey,
          checkoutPath: body.checkoutPath,
          title: body.title,
          provider: body.provider,
          launchRequestId: body.launchRequestId,
          args: body.args,
        },
        clientId,
      );
      return {
        run: instanceToAgentRunInfo(instance),
        pty: instance.ptyId
          ? { id: instance.ptyId, title: instance.title }
          : null,
      };
    }
    case "agents:stop": {
      const body = args[0] as { runId?: string; generation?: number };
      if (!body?.runId) throw new Error("agents:stop requires runId");
      const instance = runtime.terminalInstances.get(body.runId);
      if (instance) {
        if (
          body.generation != null &&
          body.generation !== instance.generation
        ) {
          return instanceToAgentRunInfo(instance);
        }
        if (instance.ptyId) {
          runtime.terminal.dispose(instance.ptyId);
        }
        const closed = runtime.terminalInstances.close(
          instance.id,
          instance.generation,
          "",
        );
        return closed?.provider ? instanceToAgentRunInfo(closed) : null;
      }
      const run = runtime.agentRuns.get(body.runId);
      if (!run) return null;
      if (body.generation != null && body.generation !== run.generation)
        return run;
      if (run.ptyId) {
        const replay = runtime.terminal.readOutput(run.ptyId);
        runtime.agentRuns.storeTranscript(
          run.ptyId,
          replay?.output ?? "",
          replay?.truncated ?? false,
        );
        runtime.terminal.dispose(run.ptyId);
      }
      return runtime.agentRuns.stop(run.runId, run.generation);
    }
    case "agents:close": {
      const body = args[0] as { runId?: string; generation?: number };
      if (!body?.runId) throw new Error("agents:close requires runId");
      const instance = runtime.terminalInstances.get(body.runId);
      if (instance) {
        if (
          body.generation != null &&
          body.generation !== instance.generation
        ) {
          return instanceToAgentRunInfo(instance);
        }
        if (instance.ptyId) {
          runtime.terminal.dispose(instance.ptyId);
        }
        const closed = runtime.terminalInstances.close(
          instance.id,
          instance.generation,
          "",
        );
        return closed?.provider ? instanceToAgentRunInfo(closed) : null;
      }
      const run = runtime.agentRuns.get(body.runId);
      if (!run) return null;
      if (body.generation != null && body.generation !== run.generation)
        return run;
      if (run.ptyId) {
        const replay = runtime.terminal.readOutput(run.ptyId);
        runtime.agentRuns.storeTranscript(
          run.ptyId,
          replay?.output ?? "",
          replay?.truncated ?? false,
        );
        runtime.terminal.dispose(run.ptyId);
      }
      return runtime.agentRuns.close(run.runId, run.generation);
    }
    case "agents:getSnapshot":
      return agents.getSnapshot(str(args[0], "sessionId"));
    case "agents:listEvents": {
      const sessionId = str(args[0], "sessionId");
      const opts =
        (args[1] as { limit?: number; before?: string } | undefined) ?? {};
      return agents.listEvents(sessionId, opts);
    }
    case "agents:ingestNative": {
      const body = args[0] as {
        provider: string;
        sessionId: string;
        payload: unknown;
        processId?: string;
        projectId?: string;
        focusedSessionId?: string | null;
        appFocused?: boolean;
      };
      if (!body?.sessionId || !body.provider) {
        throw new Error("agents:ingestNative requires provider + sessionId");
      }
      const provider = parseAgentProvider(body.provider);
      if (!provider) throw new Error("invalid agent provider");
      const result = agents.ingestNative(body.payload, {
        provider,
        sessionId: body.sessionId,
        processId: body.processId,
        projectId: body.projectId,
        focusedSessionId: body.focusedSessionId,
        appFocused: body.appFocused,
      });
      return {
        eventCount: result.events.length,
        snapshot: result.snapshot,
        nativeSessionId: result.snapshot?.nativeSessionId ?? null,
      };
    }
    case "agents:installProjectHooks": {
      const body = args[0] as { provider: string; projectRoot: string };
      if (!body?.projectRoot || !body.provider) {
        throw new Error(
          "agents:installProjectHooks requires provider + projectRoot",
        );
      }
      const provider = parseAgentProvider(body.provider);
      if (!provider) throw new Error("invalid agent provider");
      const written = installProjectHooksForProvider(
        provider,
        body.projectRoot,
        runtime.config.dataDir,
      );
      return { written };
    }
    default:
      throw new Error(`unknown agents channel: ${channel}`);
  }
}

function parseAgentProvider(
  value: string,
): "claude" | "codex" | "cursor" | "opencode" | "grok" | "pi" | null {
  if (
    value === "claude" ||
    value === "codex" ||
    value === "cursor" ||
    value === "opencode" ||
    value === "grok" ||
    value === "pi"
  ) {
    return value;
  }
  return null;
}

function instanceToAgentRunInfo(
  instance: import("./terminal-instances.js").TerminalInstance,
) {
  if (!instance.provider) {
    throw new Error("terminal instance is not an agent process");
  }
  return {
    runId: instance.id,
    launchRequestId: instance.launchRequestId ?? instance.id,
    generation: instance.generation,
    provider: instance.provider,
    projectId: instance.projectId,
    workspaceId: instance.workspaceId ?? "",
    checkoutKey: instance.checkoutKey,
    checkoutPath: instance.checkoutPath,
    title: instance.title,
    ptyId: instance.ptyId,
    nativeSessionId: instance.nativeSessionId,
    processState:
      instance.processState === "failed"
        ? ("exited" as const)
        : instance.processState,
    activityState: instance.activityState,
    telemetryState: instance.telemetryState,
    createdAt: instance.createdAt,
    startedAt: instance.startedAt,
    lastActivityAt: instance.lastActivityAt,
    endedAt: instance.endedAt,
    exitCode: instance.exitCode,
    endReason: instance.endReason,
    telemetryError: instance.telemetryError,
    revision: instance.revision,
  };
}

async function createTerminalInstance(
  runtime: HostRuntime,
  rawBody: unknown,
  clientId: string,
): Promise<import("./terminal-instances.js").TerminalInstance> {
  const body = (rawBody ?? {}) as {
    projectId?: string;
    checkoutKey?: string;
    checkoutPath?: string;
    title?: string;
    provider?: string;
    workspaceId?: string;
    launchRequestId?: string;
    args?: string[];
  };
  if (!body.projectId)
    throw new Error("terminal:createInstance requires projectId");
  const provider = body.provider ? parseAgentProvider(body.provider) : null;
  if (body.provider && !provider) throw new Error("invalid agent provider");
  const project = runtime.db.project(body.projectId);
  if (!project) throw new Error("project is unavailable");

  let checkoutPath = body.checkoutPath?.trim() ?? "";
  if (body.workspaceId) {
    const workspace = runtime.db
      .raw()
      .prepare(
        `SELECT id, project_path, cwd_path FROM project_sessions WHERE id=? AND archived_at IS NULL`,
      )
      .get(body.workspaceId) as
      | { id: string; project_path: string; cwd_path: string }
      | undefined;
    if (!workspace || workspace.project_path !== project.rootPath) {
      throw new Error("project workspace is unavailable");
    }
    if (!checkoutPath) checkoutPath = workspace.cwd_path;
  }
  if (!checkoutPath)
    throw new Error("terminal:createInstance requires checkoutPath");
  return createSharedTerminalInstance(
    runtime,
    {
      projectId: project.id,
      workspaceId: body.workspaceId,
      checkoutKey: body.checkoutKey,
      checkoutPath,
      title: body.title,
      ...(provider ? { provider } : {}),
      launchRequestId: body.launchRequestId,
      args: body.args,
    },
    clientId,
  );
}

async function handleFs(
  runtime: HostRuntime,
  channel: string,
  args: unknown[],
): Promise<unknown> {
  const mutationOptions = {
    dataDir: runtime.config.dataDir,
    allowedRoots: runtime.config.allowedRoots,
  };
  switch (channel) {
    case "fs:readFile":
      return readFile(str(args[0], "uri"));
    case "fs:writeFile":
      await writeFile(str(args[0], "uri"), String(args[1] ?? ""));
      return null;
    case "fs:readTextFile":
      return readTextFile(str(args[0], "uri"));
    case "fs:writeTextFile": {
      const options = await Schema.decodeUnknownPromise(TextFileWriteOptions)(
        args[2],
      );
      return writeTextFile(str(args[0], "uri"), String(args[1] ?? ""), options);
    }
    case "fs:writeTempDrop":
      return writeTempDrop(
        String(args[0] ?? "drop.bin"),
        str(args[1], "content"),
      );
    case "fs:readDir":
      return readDir(str(args[0], "uri"));
    case "fs:stat":
      return stat(str(args[0], "uri"));
    case "fs:exists":
      return exists(str(args[0], "uri"));
    case "fs:createFile":
      return createFile(str(args[0], "uri"), mutationOptions);
    case "fs:mkdir":
      return createDirectory(str(args[0], "uri"), mutationOptions);
    case "fs:rename":
      return renamePath(
        str(args[0], "sourceUri"),
        str(args[1], "targetUri"),
        mutationOptions,
      );
    case "fs:trash":
      return trashPath(str(args[0], "uri"), mutationOptions);
    case "fs:restoreTrash":
      return restoreTrash(
        str(args[0], "trashId"),
        typeof args[1] === "string" ? args[1] : undefined,
        mutationOptions,
      );
    case "fs:listTrash":
      return listTrash(mutationOptions);
    case "fs:emptyTrash":
      return emptyTrash(mutationOptions);
    default:
      throw new Error(`unknown fs channel: ${channel}`);
  }
}

function handleGitEffect(
  channel: string,
  args: unknown[],
): Effect.Effect<unknown, HostRpcError, GitServiceTag> {
  const rootUri = str(args[0], "rootUri");
  return Effect.gen(function* () {
    const git = yield* GitServiceTag;
    switch (channel) {
      case "git:isRepo":
        return yield* git.isRepo(rootUri);
      case "git:status":
        return yield* git.status(rootUri);
      case "git:diff": {
        const opts =
          (args[1] as { path?: string; staged?: boolean } | undefined) ??
          undefined;
        return yield* git.diff(rootUri, opts);
      }
      case "git:show": {
        const opts = args[1] as { path?: string; ref?: string } | undefined;
        const filePath = typeof opts?.path === "string" ? opts.path : "";
        const ref =
          typeof opts?.ref === "string" && opts.ref ? opts.ref : "HEAD";
        return yield* git.show(rootUri, filePath, ref);
      }
      case "git:commitFileContents": {
        const hash = str(args[1], "hash");
        const file = args[2] as
          | { path?: string; status?: string; originalPath?: string }
          | undefined;
        const path = typeof file?.path === "string" ? file.path : "";
        const status =
          typeof file?.status === "string" ? file.status : "modified";
        const originalPath =
          typeof file?.originalPath === "string"
            ? file.originalPath
            : undefined;
        return yield* git.commitFileContents(rootUri, hash, {
          path,
          status,
          originalPath,
        });
      }
      case "git:branch":
        return yield* git.branch(rootUri);
      case "git:summary":
        return yield* git.summary(rootUri);
      case "git:branches":
        return yield* git.branches(rootUri);
      case "git:stage":
        yield* git.stage(rootUri, stringArray(args[1]));
        return null;
      case "git:unstage":
        yield* git.unstage(rootUri, stringArray(args[1]));
        return null;
      case "git:discard":
        yield* git.discard(rootUri, stringArray(args[1]));
        return null;
      case "git:commit": {
        const summary = String(args[1] ?? "");
        const body = typeof args[2] === "string" ? args[2] : undefined;
        yield* git.commit(rootUri, summary, body);
        return null;
      }
      case "git:checkout":
        yield* git.checkout(rootUri, str(args[1], "branch"));
        return null;
      case "git:fetch":
        yield* git.fetch(rootUri);
        return null;
      case "git:pull":
        yield* git.pull(rootUri);
        return null;
      case "git:push":
        yield* git.push(rootUri);
        return null;
      case "git:history":
        return yield* git.history(
          rootUri,
          typeof args[1] === "number" ? args[1] : 50,
        );
      case "git:historyPage":
        return yield* git.historyPage(
          rootUri,
          typeof args[1] === "string" ? args[1] : undefined,
          typeof args[2] === "number" ? args[2] : undefined,
        );
      case "git:numstat":
        return yield* git.numstat(rootUri);
      case "git:commitFiles":
        return yield* git.commitFiles(rootUri, str(args[1], "hash"));
      case "git:applyPatch": {
        const patch = String(args[1] ?? "");
        const opts =
          (args[2] as { reverse?: boolean; cached?: boolean } | undefined) ??
          undefined;
        yield* git.applyPatch(rootUri, patch, opts);
        return null;
      }
      case "git:worktreeList":
        return yield* git.worktreeList(rootUri);
      case "git:worktreeAdd": {
        const worktreePath = str(args[1], "worktreePath");
        const opts =
          (args[2] as
            | { branch?: string; baseRef?: string; createBranch?: boolean }
            | undefined) ?? {};
        const branch = typeof opts.branch === "string" ? opts.branch : "";
        if (!branch.trim()) throw new Error("branch is required");
        return yield* git.worktreeAdd(rootUri, worktreePath, {
          branch: branch.trim(),
          baseRef: typeof opts.baseRef === "string" ? opts.baseRef : undefined,
          createBranch: opts.createBranch,
        });
      }
      case "git:worktreeRemove": {
        const worktreePath = str(args[1], "worktreePath");
        const opts = (args[2] as { force?: boolean } | undefined) ?? undefined;
        yield* git.worktreeRemove(rootUri, worktreePath, opts);
        return null;
      }
      case "git:defaultBranch":
        return yield* git.defaultBranch(rootUri);
      default:
        return yield* Effect.fail(unknownChannel(channel));
    }
  }).pipe(
    Effect.catchTag("GitCommandFailed", (e) =>
      Effect.fail(new OperationFailedError({ message: e.message, cause: e })),
    ),
  );
}

async function handleSearch(
  runtime: HostRuntime,
  channel: string,
  args: unknown[],
  signal?: AbortSignal,
): Promise<unknown> {
  const rootUri = str(args[0], "rootUri");
  switch (channel) {
    case "search:listFiles": {
      // Return via RPC only — do not push tens of thousands of paths into EventHub/WS replay.
      return listProjectFiles(rootUri, undefined, signal);
    }
    case "search:project":
      return projectSearch(
        rootUri,
        String(args[1] ?? ""),
        args[2] as ProjectSearchOptions | undefined,
        signal,
      );
    case "search:fileSearch":
      return fileSearch(
        rootUri,
        String(args[1] ?? ""),
        args[2] as FileSearchOptions | undefined,
        signal,
      );
    case "search:trackFileAccess":
      await trackFileAccess(
        rootUri,
        String(args[1] ?? ""),
        String(args[2] ?? ""),
      );
      return null;
    case "search:isScanReady":
      return isSearchScanReady(rootUri);
    case "search:isSupported":
      return isSearchSupported(rootUri);
    default:
      throw new Error(`unknown search channel: ${channel}`);
  }
}

function handleWorkspace(
  runtime: HostRuntime,
  channel: string,
  args: unknown[],
  clientId: string,
): unknown {
  const rootUri = str(args[0], "rootUri");
  const sessionId = str(args[1], "sessionId");
  const owner = { clientId, sessionId };
  if (channel === "workspace:activate") {
    return runtime.workspace.activate(runtime.events, rootUri, owner);
  }
  if (channel === "workspace:deactivate") {
    return runtime.workspace.deactivate(rootUri, owner);
  }
  throw new Error(`unknown workspace channel: ${channel}`);
}

function decodeLspInput<A, I, R>(
  schema: Schema.Schema<A, I, R>,
  input: unknown,
): Effect.Effect<A, HostRpcError, R> {
  return Schema.decodeUnknown(schema)(input).pipe(
    Effect.mapError(
      (error) =>
        new OperationFailedError({
          message: `Invalid LSP request: ${error.message}`,
          cause: error,
        }),
    ),
  );
}

function handleLspEffect(
  channel: string,
  args: unknown[],
): Effect.Effect<unknown, HostRpcError, LspHostTag> {
  return Effect.gen(function* () {
    const lsp = yield* LspHostTag;
    switch (channel) {
      case "lsp:resolve": {
        const request = yield* decodeLspInput(LspResolveRequest, args[0]);
        return yield* Effect.promise(() => lsp.resolve(request));
      }
      case "lsp:start": {
        const target = yield* decodeLspInput(
          ResolvedLanguageServerTarget,
          args[0],
        );
        return yield* Effect.promise(() => lsp.start(target));
      }
      case "lsp:stop":
        yield* Effect.promise(() => lsp.stop(str(args[0], "id")));
        return null;
      case "lsp:listDefinitions":
        return lsp.listDefinitions();
      case "lsp:logs": {
        const request = yield* decodeLspInput(LspLogRequest, args[0] ?? {});
        return lsp.logs(request);
      }
      default:
        return yield* Effect.fail(unknownChannel(channel));
    }
  });
}

async function handleTerminal(
  runtime: HostRuntime,
  channel: string,
  args: unknown[],
  clientId: string,
): Promise<unknown> {
  switch (channel) {
    case "terminal:listInstances":
      return runtime.terminalInstances.listProject(str(args[0], "projectId"));
    case "terminal:getInstanceTranscript":
      return runtime.terminalInstances.transcript(str(args[0], "id"));
    case "terminal:createInstance": {
      return createTerminalInstance(runtime, args[0], clientId);
    }
    case "terminal:restartInstance": {
      const body = args[0] as { id?: string; generation?: number };
      if (!body?.id || body.generation == null) {
        throw new Error("terminal:restartInstance requires id and generation");
      }
      const instance = runtime.terminalInstances.get(body.id);
      if (!instance || instance.generation !== body.generation) return instance;
      return restartTerminalInstance(runtime, instance, [], clientId);
    }
    case "terminal:closeInstance": {
      const body = args[0] as { id?: string; generation?: number };
      if (!body?.id || body.generation == null) {
        throw new Error("terminal:closeInstance requires id and generation");
      }
      const instance = runtime.terminalInstances.get(body.id);
      if (!instance || instance.generation !== body.generation) return instance;
      const replay = instance.ptyId
        ? runtime.terminal.readOutput(instance.ptyId)
        : null;
      if (instance.ptyId) runtime.terminal.dispose(instance.ptyId);
      return runtime.terminalInstances.close(
        instance.id,
        instance.generation,
        replay?.output ?? "",
      );
    }
    case "terminal:create": {
      const cwdUri = str(args[0], "cwdUri");
      await assertAllowedUri(
        cwdUri,
        runtime.config.allowedRoots,
        fileUriToPath,
      );
      const launch = (args[1] as TerminalLaunch | null | undefined) ?? null;
      const created = runtime.terminal.create(cwdUri, launch, clientId);
      runtime.db.recordSession(created.id, "terminal", "running", {
        title: created.title,
      });
      return created;
    }
    case "terminal:write":
      return runtime.terminal.write(str(args[0], "id"), String(args[1] ?? ""));
    case "terminal:writeBinary":
      return runtime.terminal.writeBinary(
        str(args[0], "id"),
        String(args[1] ?? ""),
      );
    case "terminal:resize":
      return runtime.terminal.resize(
        str(args[0], "id"),
        typeof args[1] === "number" ? args[1] : undefined,
        typeof args[2] === "number" ? args[2] : undefined,
      );
    case "terminal:ack":
      return runtime.terminal.acknowledgeData(
        str(args[0], "id"),
        typeof args[1] === "number" ? args[1] : Number(args[1] ?? 0),
      );
    case "terminal:attach":
      return runtime.terminal.attach(
        str(args[0], "id"),
        clientId,
        typeof args[1] === "number" ? args[1] : undefined,
      );
    case "terminal:getCwd":
      return runtime.terminal.getCwd(str(args[0], "id"));
    case "terminal:getForegroundProcess":
      return runtime.terminal.getForegroundProcess(str(args[0], "id"));
    case "terminal:dispose": {
      const id = str(args[0], "id");
      runtime.terminal.dispose(id);
      runtime.db.updateSessionStatus(id, "stopped");
      // A terminal can be disposed while its agent history remains useful in
      // HQ.  The terminal exit callback marks the durable run ended; never
      // delete its snapshot/events here.
      return null;
    }
    default:
      throw new Error(`unknown terminal channel: ${channel}`);
  }
}

function handleShell(channel: string, args: unknown[]): unknown {
  if (channel === "shell:openInApp") {
    return openInApp(str(args[0], "appId"), str(args[1], "rootUri"));
  }
  if (channel === "shell:revealInFolder") {
    return revealInFolder(str(args[0], "rootUri"));
  }
  throw new Error(`unknown shell channel: ${channel}`);
}

async function handleTasks(channel: string, args: unknown[]): Promise<unknown> {
  if (channel !== "tasks:spawn")
    throw new Error(`unknown tasks channel: ${channel}`);
  const req = args[0] as { command?: string; args?: string[]; cwd?: string };
  if (!req?.command || !req.cwd)
    throw new Error("tasks:spawn requires command and cwd");
  return spawnTask({ command: req.command, args: req.args, cwd: req.cwd });
}

function handlePerf(
  runtime: HostRuntime,
  channel: string,
  args: unknown[],
): unknown {
  if (channel === "perf:recordStartup") {
    return runtime.perf.recordStartup(
      (args[0] as Record<string, unknown>) ?? {},
    );
  }
  if (channel === "perf:getStartupLogPath")
    return runtime.perf.getStartupLogPath();
  throw new Error(`unknown perf channel: ${channel}`);
}

function str(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`missing ${label}`);
  return value;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}
