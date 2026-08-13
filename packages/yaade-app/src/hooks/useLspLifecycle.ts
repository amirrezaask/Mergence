import { useCallback, useEffect, useRef, useState } from "react"
import type {
  JetLspWorkspaceDeps,
  LspClientHandle,
  LspStatus,
} from "@yaade/lsp"
import { isUntitledUri, fileUriToPath } from "@yaade/shared"
import type { WorkspaceService } from "@yaade/workspace"
import { showYaadeToast } from "@yaade/ui"
import {
  recordLspOutput,
  recordLspProgress,
  requestLspMessageAction,
} from "../lsp-ui-store.js"

export type UseLspLifecycleOptions = {
  applyWorkspaceEditTransaction?: JetLspWorkspaceDeps["applyWorkspaceEditTransaction"]
  processCwdUri?: string
}

type LspRuntime = {
  manager: InstanceType<typeof import("@yaade/lsp").LanguageServerManager> | null
  pool: InstanceType<typeof import("@yaade/lsp").LspClientPool>
  router: InstanceType<typeof import("@yaade/lsp").DocumentRouter>
}

let lspRuntimePromise: Promise<LspRuntime> | null = null
let lspRuntimeUsers = 0
let lspRuntimeReleaseGeneration = 0

async function loadLspRuntime(): Promise<LspRuntime> {
  if (!lspRuntimePromise) {
    lspRuntimePromise = (async () => {
      const lsp = await import("@yaade/lsp")
      const pool = new lsp.LspClientPool()
      const router = new lsp.DocumentRouter({
        open: (connection, uri) => pool.openDocument(connection.id, uri),
        close: (connectionId, uri) => pool.closeDocumentForConnection(connectionId, uri),
      })
      return {
        manager: window.yaade ? new lsp.LanguageServerManager(window.yaade.lsp) : null,
        pool,
        router,
      }
    })()
  }
  return lspRuntimePromise
}

export function useLspLifecycle(
  workspace: WorkspaceService,
  onOpenFile: (uri: string, path: string, line?: number, column?: number) => void,
  options: UseLspLifecycleOptions = {},
) {
  const [lspRevision, setLspRevision] = useState(0)
  const [lspStatus, setLspStatus] = useState<LspStatus>("idle")
  const runtimeRef = useRef<LspRuntime | null>(null)
  const attachPromisesRef = useRef(new Map<string, Promise<void>>())
  const knownRootUrisRef = useRef(new Set(workspace.folders.map(folder => folder.root.uri)))
  const onOpenFileRef = useRef(onOpenFile)
  onOpenFileRef.current = onOpenFile
  const applyWorkspaceEditTransactionRef = useRef(
    options.applyWorkspaceEditTransaction,
  )
  applyWorkspaceEditTransactionRef.current =
    options.applyWorkspaceEditTransaction
  const processCwdUri = options.processCwdUri

  useEffect(() => {
    lspRuntimeUsers += 1
    lspRuntimeReleaseGeneration += 1
    return () => {
      lspRuntimeUsers = Math.max(0, lspRuntimeUsers - 1)
      const generation = ++lspRuntimeReleaseGeneration
      queueMicrotask(() => {
        if (lspRuntimeUsers !== 0 || lspRuntimeReleaseGeneration !== generation) return
        const runtimePromise = lspRuntimePromise
        lspRuntimePromise = null
        if (!runtimePromise) return
        void runtimePromise.then(async runtime => {
          runtime.router.clear()
          await runtime.manager?.stopAll()
          runtime.pool.clear()
          runtime.manager?.dispose()
        })
      })
    }
  }, [])

  const bumpLspRevision = useCallback(() => setLspRevision(revision => revision + 1), [])

  const ensureRuntime = useCallback(async () => {
    if (runtimeRef.current) return runtimeRef.current
    const runtime = await loadLspRuntime()
    runtimeRef.current = runtime
    const { monacoModels } = await import("@yaade/monaco")
    runtime.pool.setWorkspaceDeps({
      openFile: (uri, path, line, column) => onOpenFileRef.current(uri, path, line, column),
      pushJumpLocation: (uri, line, column) => {
        workspace.jumpStack.push({ fileUri: uri, line, column })
      },
      readFile: uri => workspace.readFile(uri),
      getLanguageId: uri => {
        const file = workspace.fileForUri(uri)
        if (file) return file.languageId
        const path = isUntitledUri(uri) ? "" : fileUriToPath(uri)
        return workspace.createWorkspaceFile(uri, path).languageId
      },
      isDirty: uri => workspace.fileForUri(uri)?.isDirty ?? false,
      getContent: uri => monacoModels.getContent(uri),
      updateContent: (uri, content) => {
        monacoModels.updateContent(uri, content, { preserveCursor: true })
      },
      writeFile: async (uri, content) => {
        await workspace.writeFile(uri, content)
        workspace.setSavedBaseline(uri, content)
        const { editorBufferServiceFor } = await import("../editor/editor-buffer-service.js")
        const buffers = editorBufferServiceFor(workspace)
        if (buffers.snapshot(uri)) buffers.markSaved(uri)
        else workspace.markDirty(uri, false)
      },
      onFileChanged: callback =>
        window.yaade?.fs.onFileChanged?.((uri, kind) =>
          callback({ uri, kind }),
        ) ?? (() => {}),
      showDocument: async params => {
        if (!workspace.resolveRootUriForFile(params.uri)) return false
        const selection = params.selection
        onOpenFileRef.current(
          params.uri,
          fileUriToPath(params.uri),
          selection ? selection.start.line + 1 : undefined,
          selection ? selection.start.character + 1 : undefined,
        )
        return true
      },
      showMessageRequest: params =>
        requestLspMessageAction({
          type: params.type,
          message: params.message,
          actions: params.actions,
        }),
      onProgress: recordLspProgress,
      onOutput: recordLspOutput,
      isUriAllowed: uri => workspace.resolveRootUriForFile(uri) != null,
      ...(applyWorkspaceEditTransactionRef.current
        ? {
            applyWorkspaceEditTransaction: (edit, transactionOptions) =>
              applyWorkspaceEditTransactionRef.current!(edit, transactionOptions),
          }
        : {}),
    })
    runtime.pool.setServerMessageHandler((message, kind) => {
      showYaadeToast(message, {
        variant: kind === "error" ? "destructive" : kind === "warning" ? "warning" : "info",
      })
    })
    return runtime
  }, [workspace])

  useEffect(() => {
    if (!window.yaade?.lsp) setLspStatus("unavailable")
  }, [])

  const resolveLspClient = useCallback(
    async (fileUri: string): Promise<LspClientHandle | null> => {
      const runtime = await ensureRuntime()
      const { manager, pool, router } = runtime
      if (!manager) return null
      const rootUri = workspace.resolveRootUriForFile(fileUri)
      if (!rootUri) return null
      const path = isUntitledUri(fileUri) ? "" : fileUriToPath(fileUri)
      const file = workspace.fileForUri(fileUri) ?? workspace.createWorkspaceFile(fileUri, path)
      const connection = await manager.ensureServerForFile(
        file,
        rootUri,
        processCwdUri,
      )
      if (!connection) return null
      const client = await pool.getOrCreateClient(connection)
      await router.route(fileUri, file.languageId, manager.listConnections())
      return client
    },
    [ensureRuntime, processCwdUri, workspace],
  )

  const ensureLspForFile = useCallback(
    async (fileUri: string) => {
      if (isUntitledUri(fileUri)) return
      if (!window.yaade?.lsp) {
        setLspStatus("unavailable")
        return
      }
      const runtime = await ensureRuntime()
      const { manager, pool, router } = runtime
      if (!manager) return
      setLspStatus("starting")
      const rootUri = workspace.resolveRootUriForFile(fileUri)
      if (!rootUri) {
        setLspStatus("idle")
        return
      }
      const path = fileUriToPath(fileUri)
      const file = workspace.fileForUri(fileUri) ?? workspace.createWorkspaceFile(fileUri, path)
      try {
        const connection = await manager.ensureServerForFile(
          file,
          rootUri,
          processCwdUri,
        )
        if (!connection) {
          const spawnError = manager.consumeLastSpawnError()
          if (spawnError && manager.isLanguageSupported(file.languageId)) {
            showYaadeToast(
              `Language server unavailable for ${file.name} — is ${spawnError.serverId ?? "the configured server"} on PATH?`,
            )
            setLspStatus("failed")
          } else {
            setLspStatus(manager.hasAnyConnection() ? "ready" : "idle")
          }
          return
        }
        await pool.getOrCreateClient(connection)
        await router.route(fileUri, file.languageId, manager.listConnections())
        setLspStatus("ready")
        bumpLspRevision()
      } catch {
        const connection = manager.listConnections().find(candidate =>
          candidate.languageIds.includes(file.languageId) &&
          fileUri.startsWith(candidate.projectRootUri),
        )
        if (connection) {
          await manager.stopConnection(connection.id)
          router.releaseConnection(connection.id)
          pool.releaseConnection(connection.id)
        }
        setLspStatus("disconnected")
      }
    },
    [bumpLspRevision, ensureRuntime, processCwdUri, workspace],
  )

  const ensureLspForFileDeduped = useCallback((fileUri: string): Promise<void> => {
    const existing = attachPromisesRef.current.get(fileUri)
    if (existing) return existing
    const pending = ensureLspForFile(fileUri).finally(() => {
      if (attachPromisesRef.current.get(fileUri) === pending) {
        attachPromisesRef.current.delete(fileUri)
      }
    })
    attachPromisesRef.current.set(fileUri, pending)
    return pending
  }, [ensureLspForFile])

  const handleLspAttachFailed = useCallback(
    (fileUri: string) => {
      void ensureLspForFileDeduped(fileUri)
    },
    [ensureLspForFileDeduped],
  )

  const closeLspForFile = useCallback((fileUri: string) => {
    runtimeRef.current?.router.close(fileUri)
  }, [])

  const cancelLspProgress = useCallback(
    async (connectionId: string, token: string | number) => {
      const runtime = runtimeRef.current ?? await ensureRuntime()
      return runtime.pool.cancelWorkDoneProgress(connectionId, token)
    },
    [ensureRuntime],
  )

  const stopLspServersForRoot = useCallback(
    async (rootUri: string) => {
      const runtime = runtimeRef.current
      if (!runtime?.manager) return
      const stoppedIds = await runtime.manager.stopServersForRoot(rootUri)
      for (const id of stoppedIds) {
        runtime.router.releaseConnection(id)
        runtime.pool.releaseConnection(id)
      }
      setLspStatus(runtime.manager.hasAnyConnection() ? "ready" : "idle")
      bumpLspRevision()
    },
    [bumpLspRevision],
  )

  const stopAllLspServers = useCallback(async () => {
    const runtime = runtimeRef.current
    if (!runtime?.manager) return
    const stoppedIds = await runtime.manager.stopAll()
    for (const id of stoppedIds) {
      runtime.router.releaseConnection(id)
      runtime.pool.releaseConnection(id)
    }
    setLspStatus("idle")
    bumpLspRevision()
  }, [bumpLspRevision])

  const previousProcessCwdUriRef = useRef(processCwdUri)
  useEffect(() => {
    if (previousProcessCwdUriRef.current === processCwdUri) return
    previousProcessCwdUriRef.current = processCwdUri
    void stopAllLspServers()
  }, [processCwdUri, stopAllLspServers])

  useEffect(() => {
    const subscription = workspace.manager.onDidChangeFolders.event(folders => {
      const next = new Set(folders.map(folder => folder.root.uri))
      const runtime = runtimeRef.current
      if (runtime?.manager) {
        for (const rootUri of knownRootUrisRef.current) {
          if (next.has(rootUri)) continue
          void runtime.manager.stopServersForRoot(rootUri).then(stoppedIds => {
            for (const id of stoppedIds) {
              runtime.router.releaseConnection(id)
              runtime.pool.releaseConnection(id)
            }
            setLspStatus(runtime.manager?.hasAnyConnection() ? "ready" : "idle")
            bumpLspRevision()
          })
        }
      }
      knownRootUrisRef.current = next
    })
    return () => subscription.dispose()
  }, [bumpLspRevision, workspace])

  useEffect(() => {
    let disposed = false
    let disposeLifecycle: (() => void) | null = null
    void ensureRuntime().then(runtime => {
      if (disposed || !runtime.manager) return
      const subscription = runtime.manager.onLifecycle.event(event => {
        if (event.kind === "crashed" || event.kind === "stopped") {
          if (event.sessionId) {
            runtime.router.releaseConnection(event.sessionId)
            runtime.pool.releaseConnection(event.sessionId)
          }
          setLspStatus(event.kind === "crashed" ? "disconnected" : "idle")
        } else if (event.kind === "restarting") {
          setLspStatus("restarting")
        } else if (event.kind === "ready") {
          setLspStatus("ready")
          for (const uri of workspace.openBuffers) void ensureLspForFileDeduped(uri)
        } else if (event.kind === "configuration-invalid") {
          showYaadeToast(`Invalid language server configuration: ${event.message ?? "unknown error"}`, {
            variant: "destructive",
          })
        } else if (event.kind === "configuration-changed") {
          if (event.settingsOnly && event.serverId) {
            void runtime.pool.updateServerSettings(event.serverId, event.settings)
          } else {
            for (const uri of workspace.openBuffers) void ensureLspForFileDeduped(uri)
          }
        }
        bumpLspRevision()
      })
      disposeLifecycle = () => subscription.dispose()
    })
    return () => {
      disposed = true
      disposeLifecycle?.()
    }
  }, [bumpLspRevision, ensureLspForFileDeduped, ensureRuntime, workspace])

  const reconnectOpenDocuments = useCallback(async () => {
    const runtime = runtimeRef.current
    if (!runtime?.manager) return
    setLspStatus("restarting")
    const staleIds = await runtime.manager.stopAll()
    for (const id of staleIds) {
      runtime.router.releaseConnection(id)
      runtime.pool.releaseConnection(id)
    }
    const documents = [...workspace.openBuffers]
    await Promise.all(documents.map(uri => ensureLspForFileDeduped(uri)))
    setLspStatus(runtime.manager.hasAnyConnection() ? "ready" : "idle")
    bumpLspRevision()
  }, [bumpLspRevision, ensureLspForFileDeduped, workspace])

  useEffect(() => {
    let disposed = false
    let release: (() => void) | null = null
    void ensureRuntime().then(runtime => {
      if (disposed) return
      const subscription = runtime.pool.onDidDisconnect.event(event => {
        const stale = runtime.manager?.listConnections().some(
          connection => connection.id === event.connectionId,
        )
        if (!stale) return
        runtime.manager?.clearConnection(event.connectionId)
        runtime.router.releaseConnection(event.connectionId)
        runtime.pool.releaseConnection(event.connectionId)
        setLspStatus("disconnected")
        window.setTimeout(() => {
          if (disposed) return
          void reconnectOpenDocuments().catch(() => {
            if (!disposed) setLspStatus("disconnected")
          })
        }, 250)
      })
      release = () => subscription.dispose()
    })
    return () => {
      disposed = true
      release?.()
    }
  }, [ensureRuntime, reconnectOpenDocuments])

  useEffect(() => {
    const reconnectClients = () => {
      void reconnectOpenDocuments().catch(() => {
        setLspStatus("disconnected")
      })
    }
    window.addEventListener("yaade:host-reconnected", reconnectClients)
    return () => {
      window.removeEventListener("yaade:host-reconnected", reconnectClients)
    }
  }, [reconnectOpenDocuments])

  return {
    lspManager: runtimeRef.current?.manager ?? null,
    lspClientPool: runtimeRef.current?.pool ?? null,
    lspRevision,
    bumpLspRevision,
    resolveLspClient,
    ensureLspForFile: ensureLspForFileDeduped,
    closeLspForFile,
    cancelLspProgress,
    handleLspAttachFailed,
    stopLspServersForRoot,
    stopAllLspServers,
    lspStatus,
    setLspStatus,
  }
}
