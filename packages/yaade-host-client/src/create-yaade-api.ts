import type { WorkspaceFileChangeKind, YaadeHostAPI } from "@yaade/workspace";
import { Schema } from "effect";
import { ToolEvent, type ProjectTarget } from "@yaade/rpc";
import type { YaadeHostTransport } from "./transport.js";
import {
  readFileWithDiagnostics,
  readTextFileWithDiagnostics,
} from "./fs-read-diagnostics.js";

// Host owns the authoritative terminal replay. This buffer only bridges the
// attach handshake, so keeping a second multi-megabyte copy is wasteful.
const MAX_BUFFERED_TERMINAL_CHARS = 64 * 1024;

type TerminalAttachResult = {
  id: string;
  title?: string;
  outputChunks?: string[];
  output: string;
  replayTruncated?: boolean;
  replayNeedsQueryResponses?: boolean;
  lastSequence: number;
  status: "running" | "exited";
  exitCode?: number;
  signal?: number;
};

/** Prefer acknowledged WS delivery for hot terminal I/O; fall back to HTTP RPC. */
function invokeTerminalHot(
  transport: YaadeHostTransport,
  channel: string,
  ...args: unknown[]
): Promise<void> {
  const realtime = transport.invokeRealtime?.<unknown>(channel, ...args);
  if (realtime) return realtime.then(() => undefined);
  return transport.invoke(channel, ...args).then(() => undefined);
}

export function createYaadeApi(transport: YaadeHostTransport): YaadeHostAPI {
  type TerminalDataListener = (
    data: string,
    replay?: boolean,
    replayNeedsQueryResponses?: boolean,
    replayTruncated?: boolean,
  ) => void;
  const terminalDataListeners = new Map<string, Set<TerminalDataListener>>();
  type BufferedTerminalData = {
    data: string;
    sequence: number;
    replay?: boolean;
    replayNeedsQueryResponses?: boolean;
    replayTruncated?: boolean;
  };
  const terminalDataBuffers = new Map<string, BufferedTerminalData[]>();
  const terminalDataBufferSizes = new Map<string, number>();
  const terminalReplayFloors = new Map<string, number>();
  const terminalResyncing = new Set<string>();
  let realtimeConnected = false;
  let reconnectGeneration = 0;
  let hadRealtimeDisconnect = false;

  const bufferTerminalData = (
    id: string,
    data: string,
    sequence: number,
    replay = false,
    replayNeedsQueryResponses = false,
    replayTruncated = false,
  ) => {
    const pending = terminalDataBuffers.get(id) ?? [];
    pending.push({
      data,
      sequence,
      ...(replay ? { replay: true } : {}),
      ...(replayNeedsQueryResponses ? { replayNeedsQueryResponses: true } : {}),
      ...(replayTruncated ? { replayTruncated: true } : {}),
    });
    let size = (terminalDataBufferSizes.get(id) ?? 0) + data.length;
    while (size > MAX_BUFFERED_TERMINAL_CHARS && pending.length > 1) {
      size -= pending.shift()!.data.length;
    }
    terminalDataBuffers.set(id, pending);
    terminalDataBufferSizes.set(id, size);
  };

  const deliverTerminalData = (
    id: string,
    data: string,
    replay = false,
    replayNeedsQueryResponses = false,
    replayTruncated = false,
  ) => {
    const listeners = terminalDataListeners.get(id);
    if (!listeners || listeners.size === 0) return false;
    listeners.forEach((cb) =>
      cb(data, replay, replayNeedsQueryResponses, replayTruncated),
    );
    return true;
  };

  const resyncTerminal = async (id: string, generation: number) => {
    const afterSequence = terminalReplayFloors.get(id) ?? 0;
    try {
      const result = await transport.invoke<TerminalAttachResult | null>(
        "terminal:attach",
        id,
        afterSequence,
      );
      if (
        generation !== reconnectGeneration ||
        !realtimeConnected ||
        !terminalResyncing.has(id)
      ) {
        return;
      }
      if (!result) {
        terminalResyncing.delete(id);
        return;
      }
      const chunks =
        result.outputChunks && result.outputChunks.length > 0
          ? result.outputChunks
          : result.output
            ? [result.output]
            : [];
      const pending = terminalDataBuffers.get(id);
      terminalDataBuffers.delete(id);
      terminalDataBufferSizes.delete(id);
      terminalReplayFloors.set(id, result.lastSequence);
      terminalResyncing.delete(id);
      let firstReplayChunk = true;
      for (const chunk of chunks) {
        const replayTruncated =
          firstReplayChunk && result.replayTruncated === true;
        if (chunk) {
          if (
            !deliverTerminalData(
              id,
              chunk,
              true,
              result.replayNeedsQueryResponses === true,
              replayTruncated,
            )
          ) {
            bufferTerminalData(
              id,
              chunk,
              0,
              true,
              result.replayNeedsQueryResponses === true,
              replayTruncated,
            );
          }
          firstReplayChunk = false;
        }
      }
      for (const chunk of pending ?? []) {
        if (chunk.sequence > 0 && chunk.sequence <= result.lastSequence)
          continue;
        if (chunk.sequence > 0) terminalReplayFloors.set(id, chunk.sequence);
        if (
          !deliverTerminalData(
            id,
            chunk.data,
            chunk.replay === true,
            chunk.replayNeedsQueryResponses === true,
            chunk.replayTruncated === true,
          )
        ) {
          bufferTerminalData(
            id,
            chunk.data,
            chunk.sequence,
            chunk.replay === true,
            chunk.replayNeedsQueryResponses === true,
            chunk.replayTruncated === true,
          );
        }
      }
    } catch {
      // Keep the terminal marked for resync. A later socket recovery will retry;
      // normal HTTP errors remain owned by the connection lifecycle.
    }
  };

  transport.on("connection:status", (...args: unknown[]) => {
    const status = args[0];
    if (status === "disconnected") {
      realtimeConnected = false;
      hadRealtimeDisconnect = true;
      reconnectGeneration += 1;
      for (const id of terminalDataListeners.keys()) terminalResyncing.add(id);
      return;
    }
    if (status !== "connected") return;
    realtimeConnected = true;
    const generation = reconnectGeneration;
    for (const id of terminalResyncing) {
      void resyncTerminal(id, generation);
    }
    if (hadRealtimeDisconnect && typeof window !== "undefined") {
      hadRealtimeDisconnect = false;
      window.dispatchEvent(new Event("yaade:host-reconnected"));
    }
  });

  transport.on("protocol:replay-gap", (...args: unknown[]) => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent("yaade:host-replay-gap", {
        detail: { replayFloor: args[0], lastSequence: args[1] },
      }),
    );
  });

  transport.on("fs:changed", (...args: unknown[]) => {
    const uri = args[0] as string;
    const rawKind = args[1];
    const kind: WorkspaceFileChangeKind =
      rawKind === "created" || rawKind === "deleted" ? rawKind : "changed";
    for (const cb of fileChangeListeners) cb(uri, kind);
  });
  transport.on("yaade:close-tab", () => {
    window.dispatchEvent(new CustomEvent("jet-close-tab"));
  });
  transport.on("terminal:data", (...args: unknown[]) => {
    const id = args[0] as string;
    const data = args[1] as string;
    const sequence = (args[2] as number | undefined) ?? 0;
    const floor = terminalReplayFloors.get(id) ?? 0;
    if (sequence > 0 && sequence <= floor) return;
    if (terminalResyncing.has(id)) {
      bufferTerminalData(id, data, sequence);
      return;
    }
    const listeners = terminalDataListeners.get(id);
    if (listeners && listeners.size > 0) {
      if (sequence > 0) terminalReplayFloors.set(id, sequence);
      listeners.forEach((cb) => cb(data, false, false, false));
      return;
    }
    if (terminalReplayFloors.has(id)) {
      if (sequence > 0) terminalReplayFloors.set(id, sequence);
      bufferTerminalData(id, data, sequence);
    }
  });
  transport.on("terminal:exit", (...args: unknown[]) => {
    const id = args[0] as string;
    const exitCode = args[1] as number;
    const signal = args[2] as number | undefined;
    for (const cb of terminalExitListeners) cb(id, exitCode, signal);
  });
  transport.on("terminal-instances:event", (...args: unknown[]) => {
    const event = args[0] as import("@yaade/workspace").TerminalInstanceEvent;
    for (const cb of terminalInstanceListeners) cb(event);
  });
  transport.on("notifications:event", (...args: unknown[]) => {
    const event = args[0] as import("@yaade/shared").NotificationStreamEvent;
    for (const cb of notificationEventListeners) cb(event);
  });
  transport.on("agents:event", (...args: unknown[]) => {
    const event = args[0] as {
      type: "agents.snapshot" | "agents.event" | "agents.run";
      sessionId: string;
      snapshot?: import("@yaade/agent-telemetry").AgentSessionSnapshot;
      nativeSessionId?: string;
      event?: import("@yaade/agent-telemetry").AgentEvent;
    };
    for (const cb of agentEventListeners) cb(event);
  });
  transport.on("tools:event", (...args: unknown[]) => {
    try {
      const event = Schema.decodeUnknownSync(ToolEvent)(args[0]);
      for (const cb of toolEventListeners) cb(event);
    } catch {
      // Malformed generic events are ignored; the next reconciliation refetches state.
    }
  });

  const fileChangeListeners = new Set<
    (uri: string, kind: WorkspaceFileChangeKind) => void
  >();
  const terminalExitListeners = new Set<
    (id: string, exitCode: number, signal?: number) => void
  >();
  const terminalInstanceListeners = new Set<
    (event: import("@yaade/workspace").TerminalInstanceEvent) => void
  >();
  const notificationEventListeners = new Set<
    (event: import("@yaade/shared").NotificationStreamEvent) => void
  >();
  const agentEventListeners = new Set<
    (event: {
      type: "agents.snapshot" | "agents.event" | "agents.run";
      sessionId: string;
      snapshot?: import("@yaade/agent-telemetry").AgentSessionSnapshot;
      nativeSessionId?: string;
      event?: import("@yaade/agent-telemetry").AgentEvent;
      kind?: "run.created" | "run.updated" | "run.ended";
      run?: import("@yaade/workspace").AgentRunInfo;
    }) => void
  >();
  const toolEventListeners = new Set<
    (event: import("@yaade/rpc").ToolEvent) => void
  >();
  return {
    fs: {
      readFile: (uri) =>
        readFileWithDiagnostics(uri, () =>
          transport.invoke("fs:readFile", uri),
        ),
      writeFile: (uri, content) =>
        transport.invoke("fs:writeFile", uri, content),
      readTextFile: (uri) =>
        readTextFileWithDiagnostics(uri, () =>
          transport.readTextFile
            ? transport.readTextFile(uri)
            : transport.invoke("fs:readTextFile", uri),
        ),
      writeTextFile: (uri, content, options) =>
        transport.writeTextFile
          ? transport.writeTextFile(uri, content, options)
          : transport.invoke("fs:writeTextFile", uri, content, options),
      writeTempDrop: (name, contentBase64) =>
        transport.invoke("fs:writeTempDrop", name, contentBase64),
      readDir: (uri) => transport.invoke("fs:readDir", uri),
      stat: (uri) => transport.invoke("fs:stat", uri),
      exists: (uri) => transport.invoke("fs:exists", uri),
      createFile: (uri) => transport.invoke("fs:createFile", uri),
      mkdir: (uri) => transport.invoke("fs:mkdir", uri),
      rename: (sourceUri, targetUri) =>
        transport.invoke("fs:rename", sourceUri, targetUri),
      trash: (uri) => transport.invoke("fs:trash", uri),
      restoreTrash: (id, targetUri) =>
        targetUri
          ? transport.invoke("fs:restoreTrash", id, targetUri)
          : transport.invoke("fs:restoreTrash", id),
      listTrash: () => transport.invoke("fs:listTrash"),
      emptyTrash: () => transport.invoke("fs:emptyTrash"),
      showOpenFolderDialog: () => transport.invoke("fs:showOpenFolderDialog"),
      showSaveFileDialog: (defaultPath?: string) =>
        transport.invoke("fs:showSaveFileDialog", defaultPath),
      onFileChanged: (callback) => {
        fileChangeListeners.add(callback);
        return () => fileChangeListeners.delete(callback);
      },
    },
    tasks: {
      spawn: (req) => transport.invoke("tasks:spawn", req),
    },
    git: {
      isRepo: (rootUri) => transport.invoke("git:isRepo", rootUri),
      status: (rootUri) => transport.invoke("git:status", rootUri),
      diff: (rootUri, opts) => transport.invoke("git:diff", rootUri, opts),
      show: (rootUri, path, ref) =>
        transport.invoke("git:show", rootUri, { path, ref }),
      commitFileContents: (rootUri, hash, file) =>
        transport.invoke("git:commitFileContents", rootUri, hash, file),
      branch: (rootUri) => transport.invoke("git:branch", rootUri),
      summary: (rootUri) => transport.invoke("git:summary", rootUri),
      branches: (rootUri) => transport.invoke("git:branches", rootUri),
      stage: (rootUri, paths) => transport.invoke("git:stage", rootUri, paths),
      unstage: (rootUri, paths) =>
        transport.invoke("git:unstage", rootUri, paths),
      discard: (rootUri, paths) =>
        transport.invoke("git:discard", rootUri, paths),
      commit: (rootUri, summary, body) =>
        transport.invoke("git:commit", rootUri, summary, body),
      checkout: (rootUri, branch) =>
        transport.invoke("git:checkout", rootUri, branch),
      fetch: (rootUri) => transport.invoke("git:fetch", rootUri),
      pull: (rootUri) => transport.invoke("git:pull", rootUri),
      push: (rootUri) => transport.invoke("git:push", rootUri),
      history: (rootUri, limit) =>
        transport.invoke("git:history", rootUri, limit),
      historyPage: (rootUri, cursor, pageSize) =>
        transport.invoke("git:historyPage", rootUri, cursor, pageSize),
      numstat: (rootUri) => transport.invoke("git:numstat", rootUri),
      commitFiles: (rootUri, hash) =>
        transport.invoke("git:commitFiles", rootUri, hash),
      applyPatch: (rootUri, patch, opts) =>
        transport.invoke("git:applyPatch", rootUri, patch, opts),
      worktreeList: (rootUri) => transport.invoke("git:worktreeList", rootUri),
      worktreeAdd: (rootUri, worktreePath, opts) =>
        transport.invoke("git:worktreeAdd", rootUri, worktreePath, opts),
      worktreeRemove: (rootUri, worktreePath, opts) =>
        transport.invoke("git:worktreeRemove", rootUri, worktreePath, opts),
      defaultBranch: (rootUri) =>
        transport.invoke("git:defaultBranch", rootUri),
    },
    shell: {
      openInApp: (appId, rootUri) =>
        transport.invoke("shell:openInApp", appId, rootUri),
      revealInFolder: (rootUri) =>
        transport.invoke("shell:revealInFolder", rootUri),
    },
    notifications: {
      list: (req) => transport.invoke("notifications:list", req ?? {}),
      counts: () => transport.invoke("notifications:counts"),
      get: (id) => transport.invoke("notifications:get", id),
      ingest: (req) => transport.invoke("notifications:ingest", req),
      markRead: (id) => transport.invoke("notifications:markRead", id),
      markUnread: (id) => transport.invoke("notifications:markUnread", id),
      dismiss: (id) => transport.invoke("notifications:dismiss", id),
      restore: (id) => transport.invoke("notifications:restore", id),
      acknowledge: (id) => transport.invoke("notifications:acknowledge", id),
      markAllRead: (req) =>
        transport.invoke("notifications:markAllRead", req ?? {}),
      unreadBySession: () =>
        transport.invoke<Record<string, number>>(
          "notifications:unreadBySession",
        ),
      markSessionUnread: (sessionId) =>
        transport.invoke("notifications:markSessionUnread", sessionId),
      getPreferences: () => transport.invoke("notifications:getPreferences"),
      setPreferences: (prefs) =>
        transport.invoke("notifications:setPreferences", prefs),
      bindSession: (req) => transport.invoke("notifications:bindSession", req),
      onEvent: (callback) => {
        notificationEventListeners.add(callback);
        return () => notificationEventListeners.delete(callback);
      },
    },
    tools: {
      listSessions: (includeArchived) =>
        transport.invoke("tools:listSessions", includeArchived === true),
      reorderSessions: (command) =>
        transport.invoke("tools:reorderSessions", command),
      createTab: (command) => transport.invoke("tools:createTab", command),
      renameTab: (command) => transport.invoke("tools:renameTab", command),
      saveTabLayout: (command) =>
        transport.invoke("tools:saveTabLayout", command),
      reorderTabs: (command) => transport.invoke("tools:reorderTabs", command),
      archiveTab: (command) => transport.invoke("tools:archiveTab", command),
      selectTab: (command) => transport.invoke("tools:selectTab", command),
      archiveSession: (command) =>
        transport.invoke("tools:archiveSession", command),
      restoreSession: (command) =>
        transport.invoke("tools:restoreSession", command),
      createSession: (title) => transport.invoke("tools:createSession", title),
      renameSession: (sessionId, title) =>
        transport.invoke("tools:renameSession", sessionId, title),
      getSession: (sessionId) =>
        transport.invoke("tools:getSession", sessionId),
      createUse: (command) => transport.invoke("tools:createUse", command),
      getUse: (toolUseId) => transport.invoke("tools:getUse", toolUseId),
      reorderUses: (command) => transport.invoke("tools:reorderUses", command),
      updateUseContext: (command) =>
        transport.invoke("tools:updateUseContext", command),
      selectUse: (sessionId, toolUseId) =>
        transport.invoke("tools:selectUse", sessionId, toolUseId),
      cancelUse: (toolUseId, revision) =>
        transport.invoke("tools:cancelUse", toolUseId, revision),
      restartUse: (toolUseId, revision) =>
        transport.invoke("tools:restartUse", toolUseId, revision),
      archiveUse: (command) => transport.invoke("tools:archiveUse", command),
      renameUse: (toolUseId, title) =>
        transport.invoke("tools:renameUse", toolUseId, title),
      listCheckoutTargets: (projectId) =>
        transport.invoke("tools:listCheckoutTargets", {
          _tag: "ListCheckoutTargets",
          projectId,
        }),
      addProject: (rootPath) =>
        transport.invoke<ProjectTarget>(
          "tools:addProject",
          rootPath,
        ),
      onEvent: (callback) => {
        toolEventListeners.add(callback);
        return () => toolEventListeners.delete(callback);
      },
      listProjects: () => transport.invoke("tools:listProjects"),
    },
    agents: {
      listProviders: (refresh) =>
        transport.invoke("agents:listProviders", refresh === true),
      launch: (req) => transport.invoke("agents:launch", req),
      stop: (req) => transport.invoke("agents:stop", req),
      close: (req) => transport.invoke("agents:close", req),
      listLive: (projectId) => transport.invoke("agents:listLive", projectId),
      listProject: (projectId) =>
        transport.invoke("agents:listProject", projectId),
      get: (runId) => transport.invoke("agents:get", runId),
      getTranscript: (runId) => transport.invoke("agents:getTranscript", runId),
      listActivity: (opts) =>
        transport.invoke("agents:listActivity", opts ?? {}),
      getSnapshot: (sessionId) =>
        transport.invoke("agents:getSnapshot", sessionId),
      listEvents: (sessionId, opts) =>
        transport.invoke("agents:listEvents", sessionId, opts ?? {}),
      ingestNative: (req) => transport.invoke("agents:ingestNative", req),
      installProjectHooks: (req) =>
        transport.invoke("agents:installProjectHooks", req),
      onEvent: (callback) => {
        agentEventListeners.add(callback);
        return () => agentEventListeners.delete(callback);
      },
    },
    terminal: {
      create: (cwdUri, launch) =>
        transport.invoke("terminal:create", cwdUri, launch),
      attach: async (id) => {
        const realtime = transport.invokeRealtime?.<TerminalAttachResult | null>(
          "terminal:attach",
          id,
        );
        const result = realtime
          ? await realtime
          : await transport.invoke<TerminalAttachResult | null>(
              "terminal:attach",
              id,
            );
        if (result) {
          terminalReplayFloors.set(id, result.lastSequence);
          const pending = terminalDataBuffers.get(id);
          if (pending) {
            const kept = pending.filter(
              (chunk) =>
                chunk.sequence === 0 || chunk.sequence > result.lastSequence,
            );
            let size = 0;
            for (const chunk of kept) size += chunk.data.length;
            terminalDataBuffers.set(id, kept);
            terminalDataBufferSizes.set(id, size);
          }
        }
        return result;
      },
      write: (id, data) => {
        if (transport.sendRealtime?.("terminal:write", id, data)) {
          return Promise.resolve();
        }
        return invokeTerminalHot(transport, "terminal:write", id, data);
      },
      writeBinary: (id, dataBase64) => {
        if (transport.sendRealtime?.("terminal:writeBinary", id, dataBase64)) {
          return Promise.resolve();
        }
        return invokeTerminalHot(
          transport,
          "terminal:writeBinary",
          id,
          dataBase64,
        );
      },
      resize: (id, cols, rows) => {
        if (transport.sendRealtime?.("terminal:resize", id, cols, rows)) {
          return Promise.resolve();
        }
        return invokeTerminalHot(transport, "terminal:resize", id, cols, rows);
      },
      acknowledgeData: (id, charCount) =>
        invokeTerminalHot(transport, "terminal:ack", id, charCount),
      markReplayReady: (id) =>
        invokeTerminalHot(transport, "terminal:ready", id),
      getCwd: (id) => transport.invoke<string | null>("terminal:getCwd", id),
      getForegroundProcess: (id) =>
        transport.invoke<string | null>("terminal:getForegroundProcess", id),
      onData: (id, callback) => {
        let set = terminalDataListeners.get(id);
        if (!set) {
          set = new Set();
          terminalDataListeners.set(id, set);
        }
        set.add(callback);
        if (!realtimeConnected) terminalResyncing.add(id);
        const pending = terminalDataBuffers.get(id);
        if (pending) {
          for (const chunk of pending) {
            callback(
              chunk.data,
              chunk.replay === true,
              chunk.replayNeedsQueryResponses === true,
              chunk.replayTruncated === true,
            );
          }
          terminalDataBuffers.delete(id);
          terminalDataBufferSizes.delete(id);
        }
        return () => {
          set!.delete(callback);
          if (set!.size === 0) terminalDataListeners.delete(id);
        };
      },
      onExit: (cb) => {
        terminalExitListeners.add(cb);
        return () => terminalExitListeners.delete(cb);
      },
      dispose: (id) => {
        terminalDataBuffers.delete(id);
        terminalDataBufferSizes.delete(id);
        terminalDataListeners.delete(id);
        terminalReplayFloors.delete(id);
        return transport.invoke("terminal:dispose", id);
      },
      listInstances: (projectId) =>
        transport.invoke("terminal:listInstances", projectId),
      createInstance: (req) => transport.invoke("terminal:createInstance", req),
      restartInstance: (req) =>
        transport.invoke("terminal:restartInstance", req),
      closeInstance: (req) => transport.invoke("terminal:closeInstance", req),
      getInstanceTranscript: (id) =>
        transport.invoke("terminal:getInstanceTranscript", id),
      onInstanceEvent: (callback) => {
        terminalInstanceListeners.add(callback);
        return () => terminalInstanceListeners.delete(callback);
      },
    },
    getLaunchConfig: () => transport.invoke("yaade:getLaunchConfig"),
    getHomeDir: () => transport.invoke("yaade:getHomeDir"),
    loadGlobalYaadercScanRoots: () =>
      transport.invoke("yaade:loadGlobalYaadercScanRoots"),
    onLaunch: (cb) => {
      return transport.on("yaade:launch", (...args: unknown[]) => {
        cb(args[0] as import("@yaade/workspace").LaunchConfig);
      });
    },
    recordStartup: (record) => transport.invoke("perf:recordStartup", record),
    getStartupLogPath: () => transport.invoke("perf:getStartupLogPath"),
  };
}
