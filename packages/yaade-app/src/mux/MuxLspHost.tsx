import { useCallback, useEffect, useMemo, useRef } from "react"
import type {
  JetLspWorkspaceDeps,
  LspClientHandle,
  LspStatus,
} from "@yaade/lsp"
import type { WorkspaceService } from "@yaade/workspace"
import { useLspLifecycle } from "../hooks/useLspLifecycle.js"
import { MuxLspMessageHost } from "./MuxLspMessageHost.js"

export type MuxLspController = {
  open: (uri: string) => Promise<void>
  close: (uri: string) => void
  resolve: (uri: string) => Promise<LspClientHandle | null>
  save: (
    uri: string,
    persist: (content: string) => Promise<void>,
    reason?: Parameters<LspClientHandle["saveDocument"]>[2],
  ) => Promise<void>
  restart: (uri: string) => Promise<void>
  cancelProgress: (connectionId: string, token: string | number) => Promise<boolean>
  status: () => LspStatus
}

/**
 * Mounts LSP only while an editor pane exists, so terminal-only sessions never
 * pay for the Monaco/LSP runtime at boot.
 */
export function MuxLspHost(props: {
  workspace: WorkspaceService
  onOpenFile: (
    uri: string,
    path: string,
    line?: number,
    column?: number,
  ) => void
  onReady: (lifecycle: MuxLspController | null) => void
  applyWorkspaceEditTransaction?: JetLspWorkspaceDeps["applyWorkspaceEditTransaction"]
  processCwdUri?: string
}) {
  const {
    resolveLspClient,
    ensureLspForFile,
    closeLspForFile,
    cancelLspProgress,
    stopLspServersForRoot,
    lspStatus,
  } = useLspLifecycle(props.workspace, props.onOpenFile, {
    applyWorkspaceEditTransaction: props.applyWorkspaceEditTransaction,
    processCwdUri: props.processCwdUri,
  })
  const statusRef = useRef(lspStatus)
  statusRef.current = lspStatus

  const restart = useCallback(
    async (uri: string) => {
      const rootUri = props.workspace.resolveRootUriForFile(uri)
      if (rootUri) await stopLspServersForRoot(rootUri)
      await ensureLspForFile(uri)
    },
    [ensureLspForFile, props.workspace, stopLspServersForRoot],
  )

  const save = useCallback(
    async (
      uri: string,
      persist: (content: string) => Promise<void>,
      reason: Parameters<LspClientHandle["saveDocument"]>[2],
    ) => {
      let client: LspClientHandle | null = null
      try {
        client = await resolveLspClient(uri)
      } catch {
        // Saving must remain available when server discovery or startup fails.
      }
      if (!client) {
        const { monacoModels } = await import("@yaade/monaco")
        const content = monacoModels.getContent(uri)
        if (content == null) throw new Error(`Cannot save an unloaded document: ${uri}`)
        await persist(content)
        return
      }
      await client.saveDocument(uri, persist, reason)
    },
    [resolveLspClient],
  )

  const controller = useMemo<MuxLspController>(
    () => ({
      open: ensureLspForFile,
      close: closeLspForFile,
      resolve: resolveLspClient,
      save,
      restart,
      cancelProgress: cancelLspProgress,
      status: () => statusRef.current,
    }),
    [cancelLspProgress, closeLspForFile, ensureLspForFile, resolveLspClient, restart, save],
  )

  useEffect(() => {
    props.onReady(controller)
    return () => props.onReady(null)
  }, [controller, props.onReady])
  return <MuxLspMessageHost />
}
