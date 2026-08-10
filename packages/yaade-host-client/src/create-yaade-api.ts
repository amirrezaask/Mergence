import type { WorkspaceFileChangeKind, YaadeHostAPI } from "@yaade/workspace"
import { type LspLifecycleEvent } from "@yaade/rpc"
import type { YaadeHostTransport } from "./transport.js"
import {
  readFileWithDiagnostics,
  readTextFileWithDiagnostics,
} from "./fs-read-diagnostics.js"

// Host owns the authoritative terminal replay. This buffer only bridges the
// attach handshake, so keeping a second multi-megabyte copy is wasteful.
const MAX_BUFFERED_TERMINAL_CHARS = 64 * 1024

/** Prefer WS fire-and-forget for hot terminal I/O; fall back to HTTP RPC. */
function invokeTerminalHot(
  transport: YaadeHostTransport,
  channel: string,
  ...args: unknown[]
): Promise<void> {
  if (transport.sendRealtime?.(channel, ...args)) return Promise.resolve()
  return transport.invoke(channel, ...args).then(() => undefined)
}

function invokeCancellable<T>(
  transport: YaadeHostTransport,
  channel: string,
  args: unknown[],
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return transport.invoke(channel, ...args)
  if (transport.invokeWithSignal) return transport.invokeWithSignal(channel, args, signal)
  if (signal.aborted) return Promise.reject(clientAbortError(signal))
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(clientAbortError(signal))
    signal.addEventListener("abort", abort, { once: true })
    void transport.invoke<T>(channel, ...args).then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort)
    })
  })
}

function clientAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error && signal.reason.name === "AbortError") {
    return signal.reason
  }
  const error = new Error(
    signal.reason instanceof Error ? signal.reason.message : "host invoke aborted",
  )
  error.name = "AbortError"
  return error
}

export function createYaadeApi(
  transport: YaadeHostTransport,
): YaadeHostAPI {
  const terminalDataListeners = new Map<string, Set<(data: string) => void>>()
  type BufferedTerminalData = { data: string; sequence: number }
  const terminalDataBuffers = new Map<string, BufferedTerminalData[]>()
  const terminalDataBufferSizes = new Map<string, number>()
  const terminalReplayFloors = new Map<string, number>()

  transport.on("lsp:crashed", (...args: unknown[]) => {
    const id = args[0] as string
    for (const cb of lspCrashListeners) cb(id)
  })
  transport.on("lsp:lifecycle", (...args: unknown[]) => {
    const event = args[0] as LspLifecycleEvent
    for (const cb of lspLifecycleListeners) cb(event)
  })
  transport.on("fs:changed", (...args: unknown[]) => {
    const uri = args[0] as string
    const rawKind = args[1]
    const kind: WorkspaceFileChangeKind = rawKind === "created" || rawKind === "deleted"
      ? rawKind
      : "changed"
    for (const cb of fileChangeListeners) cb(uri, kind)
  })
  transport.on("yaade:close-tab", () => {
    window.dispatchEvent(new CustomEvent("jet-close-tab"))
  })
  transport.on("workspace:fileIndex", (...args: unknown[]) => {
    const payload = args[0] as { rootUri: string; files: string[] }
    for (const cb of fileIndexListeners) cb(payload.rootUri, payload.files)
  })
  transport.on("workspace:searchReady", (...args: unknown[]) => {
    const payload = args[0] as { rootUri: string }
    for (const cb of searchReadyListeners) cb(payload.rootUri)
  })
  transport.on("terminal:data", (...args: unknown[]) => {
    const id = args[0] as string
    const data = args[1] as string
    const sequence = (args[2] as number | undefined) ?? 0
    const floor = terminalReplayFloors.get(id) ?? 0
    if (sequence > 0 && sequence <= floor) return
    const listeners = terminalDataListeners.get(id)
    if (listeners && listeners.size > 0) {
      listeners.forEach(cb => cb(data))
      return
    }
    const pending = terminalDataBuffers.get(id) ?? []
    pending.push({ data, sequence })
    let size = (terminalDataBufferSizes.get(id) ?? 0) + data.length
    while (size > MAX_BUFFERED_TERMINAL_CHARS && pending.length > 1) {
      size -= pending.shift()!.data.length
    }
    terminalDataBuffers.set(id, pending)
    terminalDataBufferSizes.set(id, size)
  })
  transport.on("terminal:exit", (...args: unknown[]) => {
    const id = args[0] as string
    const exitCode = args[1] as number
    const signal = args[2] as number | undefined
    for (const cb of terminalExitListeners) cb(id, exitCode, signal)
  })
  transport.on("notifications:event", (...args: unknown[]) => {
    const event = args[0] as import("@yaade/shared").NotificationStreamEvent
    for (const cb of notificationEventListeners) cb(event)
  })
  transport.on("agents:event", (...args: unknown[]) => {
    const event = args[0] as {
      type: "agents.snapshot" | "agents.event" | "agents.run"
      sessionId: string
      snapshot?: import("@yaade/agents").AgentSessionSnapshot
      nativeSessionId?: string
      event?: import("@yaade/agents").AgentEvent
    }
    for (const cb of agentEventListeners) cb(event)
  })

  const lspCrashListeners = new Set<(id: string) => void>()
  const lspLifecycleListeners = new Set<(event: LspLifecycleEvent) => void>()
  const fileChangeListeners = new Set<
    (uri: string, kind: WorkspaceFileChangeKind) => void
  >()
  const fileIndexListeners = new Set<(rootUri: string, files: string[]) => void>()
  const searchReadyListeners = new Set<(rootUri: string) => void>()
  const terminalExitListeners = new Set<(id: string, exitCode: number, signal?: number) => void>()
  const notificationEventListeners = new Set<
    (event: import("@yaade/shared").NotificationStreamEvent) => void
  >()
  const agentEventListeners = new Set<
    (event: {
      type: "agents.snapshot" | "agents.event" | "agents.run"
      sessionId: string
      snapshot?: import("@yaade/agents").AgentSessionSnapshot
      nativeSessionId?: string
      event?: import("@yaade/agents").AgentEvent
      kind?: "run.created" | "run.updated" | "run.ended"
      run?: import("@yaade/workspace").AgentRunInfo
    }) => void
  >()
  return {
    fs: {
      readFile: uri =>
        readFileWithDiagnostics(uri, () => transport.invoke("fs:readFile", uri)),
      writeFile: (uri, content) => transport.invoke("fs:writeFile", uri, content),
      readTextFile: uri =>
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
      readDir: uri => transport.invoke("fs:readDir", uri),
      stat: uri => transport.invoke("fs:stat", uri),
      exists: uri => transport.invoke("fs:exists", uri),
      createFile: uri => transport.invoke("fs:createFile", uri),
      mkdir: uri => transport.invoke("fs:mkdir", uri),
      rename: (sourceUri, targetUri) =>
        transport.invoke("fs:rename", sourceUri, targetUri),
      trash: uri => transport.invoke("fs:trash", uri),
      restoreTrash: (id, targetUri) =>
        targetUri
          ? transport.invoke("fs:restoreTrash", id, targetUri)
          : transport.invoke("fs:restoreTrash", id),
      listTrash: () => transport.invoke("fs:listTrash"),
      emptyTrash: () => transport.invoke("fs:emptyTrash"),
      showOpenFolderDialog: () => transport.invoke("fs:showOpenFolderDialog"),
      showSaveFileDialog: (defaultPath?: string) =>
        transport.invoke("fs:showSaveFileDialog", defaultPath),
      onFileChanged: callback => {
        fileChangeListeners.add(callback)
        return () => fileChangeListeners.delete(callback)
      },
    },
    workspace: {
      activate: (rootUri, owner) =>
        transport.invoke("workspace:activate", rootUri, owner.sessionId),
      deactivate: (rootUri, owner) =>
        transport.invoke("workspace:deactivate", rootUri, owner.sessionId),
      onFileIndex: callback => {
        fileIndexListeners.add(callback)
        return () => fileIndexListeners.delete(callback)
      },
      onSearchReady: callback => {
        searchReadyListeners.add(callback)
        return () => searchReadyListeners.delete(callback)
      },
    },
    search: {
      project: (rootUri, query, opts, signal) =>
        invokeCancellable(transport, "search:project", [rootUri, query, opts], signal),
      listFiles: (rootUri, signal) =>
        invokeCancellable(transport, "search:listFiles", [rootUri], signal),
      fileSearch: (rootUri, query, opts, signal) =>
        invokeCancellable(transport, "search:fileSearch", [rootUri, query, opts], signal),
      trackFileAccess: (rootUri, query, path) =>
        transport.invoke("search:trackFileAccess", rootUri, query, path),
      isScanReady: rootUri => transport.invoke("search:isScanReady", rootUri),
      isSupported: rootUri => transport.invoke("search:isSupported", rootUri),
    },
    lsp: {
      resolve: request => transport.invoke("lsp:resolve", request),
      start: target => transport.invoke("lsp:start", target),
      stop: id => transport.invoke("lsp:stop", id),
      listDefinitions: () => transport.invoke("lsp:listDefinitions"),
      logs: request => transport.invoke("lsp:logs", request ?? {}),
      onLifecycle: cb => {
        lspLifecycleListeners.add(cb)
        return () => lspLifecycleListeners.delete(cb)
      },
      onCrashed: cb => {
        lspCrashListeners.add(cb)
        return () => lspCrashListeners.delete(cb)
      },
    },
    tasks: {
      spawn: req => transport.invoke("tasks:spawn", req),
    },
    git: {
      isRepo: rootUri => transport.invoke("git:isRepo", rootUri),
      status: rootUri => transport.invoke("git:status", rootUri),
      diff: (rootUri, opts) => transport.invoke("git:diff", rootUri, opts),
      show: (rootUri, path, ref) => transport.invoke("git:show", rootUri, { path, ref }),
      commitFileContents: (rootUri, hash, file) =>
        transport.invoke("git:commitFileContents", rootUri, hash, file),
      branch: rootUri => transport.invoke("git:branch", rootUri),
      summary: rootUri => transport.invoke("git:summary", rootUri),
      branches: rootUri => transport.invoke("git:branches", rootUri),
      stage: (rootUri, paths) => transport.invoke("git:stage", rootUri, paths),
      unstage: (rootUri, paths) => transport.invoke("git:unstage", rootUri, paths),
      discard: (rootUri, paths) => transport.invoke("git:discard", rootUri, paths),
      commit: (rootUri, summary, body) => transport.invoke("git:commit", rootUri, summary, body),
      checkout: (rootUri, branch) => transport.invoke("git:checkout", rootUri, branch),
      fetch: rootUri => transport.invoke("git:fetch", rootUri),
      pull: rootUri => transport.invoke("git:pull", rootUri),
      push: rootUri => transport.invoke("git:push", rootUri),
      history: (rootUri, limit) => transport.invoke("git:history", rootUri, limit),
      historyPage: (rootUri, cursor, pageSize) =>
        transport.invoke("git:historyPage", rootUri, cursor, pageSize),
      numstat: rootUri => transport.invoke("git:numstat", rootUri),
      commitFiles: (rootUri, hash) => transport.invoke("git:commitFiles", rootUri, hash),
      applyPatch: (rootUri, patch, opts) =>
        transport.invoke("git:applyPatch", rootUri, patch, opts),
      worktreeList: rootUri => transport.invoke("git:worktreeList", rootUri),
      worktreeAdd: (rootUri, worktreePath, opts) =>
        transport.invoke("git:worktreeAdd", rootUri, worktreePath, opts),
      worktreeRemove: (rootUri, worktreePath, opts) =>
        transport.invoke("git:worktreeRemove", rootUri, worktreePath, opts),
      defaultBranch: rootUri => transport.invoke("git:defaultBranch", rootUri),
    },
    shell: {
      openInApp: (appId, rootUri) => transport.invoke("shell:openInApp", appId, rootUri),
      revealInFolder: rootUri => transport.invoke("shell:revealInFolder", rootUri),
    },
    notifications: {
      list: req => transport.invoke("notifications:list", req ?? {}),
      counts: () => transport.invoke("notifications:counts"),
      get: id => transport.invoke("notifications:get", id),
      ingest: req => transport.invoke("notifications:ingest", req),
      markRead: id => transport.invoke("notifications:markRead", id),
      markUnread: id => transport.invoke("notifications:markUnread", id),
      dismiss: id => transport.invoke("notifications:dismiss", id),
      restore: id => transport.invoke("notifications:restore", id),
      acknowledge: id => transport.invoke("notifications:acknowledge", id),
      markAllRead: req => transport.invoke("notifications:markAllRead", req ?? {}),
      unreadBySession: () =>
        transport.invoke<Record<string, number>>("notifications:unreadBySession"),
      markSessionUnread: sessionId =>
        transport.invoke("notifications:markSessionUnread", sessionId),
      getPreferences: () => transport.invoke("notifications:getPreferences"),
      setPreferences: prefs => transport.invoke("notifications:setPreferences", prefs),
      bindSession: req => transport.invoke("notifications:bindSession", req),
      onEvent: callback => {
        notificationEventListeners.add(callback)
        return () => notificationEventListeners.delete(callback)
      },
    },
    agents: {
      listProviders: refresh => transport.invoke("agents:listProviders", refresh === true),
      launch: req => transport.invoke("agents:launch", req),
      stop: req => transport.invoke("agents:stop", req),
      listLive: projectId => transport.invoke("agents:listLive", projectId),
      get: runId => transport.invoke("agents:get", runId),
      listActivity: opts => transport.invoke("agents:listActivity", opts ?? {}),
      getSnapshot: sessionId => transport.invoke("agents:getSnapshot", sessionId),
      listEvents: (sessionId, opts) =>
        transport.invoke("agents:listEvents", sessionId, opts ?? {}),
      ingestNative: req => transport.invoke("agents:ingestNative", req),
      installProjectHooks: req =>
        transport.invoke("agents:installProjectHooks", req),
      onEvent: callback => {
        agentEventListeners.add(callback)
        return () => agentEventListeners.delete(callback)
      },
    },
    terminal: {
      create: (cwdUri, launch) => transport.invoke("terminal:create", cwdUri, launch),
      attach: async id => {
        const result = await transport.invoke<{
          id: string
          title?: string
          outputChunks?: string[]
          output: string
          lastSequence: number
          status: "running" | "exited"
          exitCode?: number
          signal?: number
        } | null>("terminal:attach", id)
        if (result) {
          terminalReplayFloors.set(id, result.lastSequence)
          const pending = terminalDataBuffers.get(id)
          if (pending) {
            const kept = pending.filter(
              chunk => chunk.sequence === 0 || chunk.sequence > result.lastSequence,
            )
            let size = 0
            for (const chunk of kept) size += chunk.data.length
            terminalDataBuffers.set(id, kept)
            terminalDataBufferSizes.set(id, size)
          }
        }
        return result
      },
      write: (id, data) =>
        invokeTerminalHot(transport, "terminal:write", id, data),
      writeBinary: (id, dataBase64) =>
        invokeTerminalHot(transport, "terminal:writeBinary", id, dataBase64),
      resize: (id, cols, rows) =>
        invokeTerminalHot(transport, "terminal:resize", id, cols, rows),
      acknowledgeData: (id, charCount) =>
        invokeTerminalHot(transport, "terminal:ack", id, charCount),
      getCwd: id => transport.invoke<string | null>("terminal:getCwd", id),
      getForegroundProcess: id =>
        transport.invoke<string | null>("terminal:getForegroundProcess", id),
      onData: (id, callback) => {
        let set = terminalDataListeners.get(id)
        if (!set) {
          set = new Set()
          terminalDataListeners.set(id, set)
        }
        set.add(callback)
        const pending = terminalDataBuffers.get(id)
        if (pending) {
          for (const chunk of pending) callback(chunk.data)
          terminalDataBuffers.delete(id)
          terminalDataBufferSizes.delete(id)
        }
        return () => {
          set!.delete(callback)
          if (set!.size === 0) terminalDataListeners.delete(id)
        }
      },
      onExit: cb => {
        terminalExitListeners.add(cb)
        return () => terminalExitListeners.delete(cb)
      },
      dispose: id => {
        terminalDataBuffers.delete(id)
        terminalDataBufferSizes.delete(id)
        terminalDataListeners.delete(id)
        terminalReplayFloors.delete(id)
        return transport.invoke("terminal:dispose", id)
      },
    },
    getLaunchConfig: () => transport.invoke("yaade:getLaunchConfig"),
    getHomeDir: () => transport.invoke("yaade:getHomeDir"),
    loadGlobalYaadercScanRoots: () => transport.invoke("yaade:loadGlobalYaadercScanRoots"),
    onLaunch: cb => {
      return transport.on("yaade:launch", (...args: unknown[]) => {
        cb(args[0] as import("@yaade/workspace").LaunchConfig)
      })
    },
    recordStartup: record => transport.invoke("perf:recordStartup", record),
    getStartupLogPath: () => transport.invoke("perf:getStartupLogPath"),
  }
}
