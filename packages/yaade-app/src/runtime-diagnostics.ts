import { getFsReadDiagnostics, type FsReadDiagnostics } from "@yaade/host-client"

export type EditorDiagnostics = {
  models: {
    totalCount: number
    totalBytes: number
    entries: readonly unknown[]
  }
  editors: {
    mountedCount: number
    activeUri: string | null
    activeDirty: boolean
    openBuffers: string[]
    entries: readonly unknown[]
  }
  lifecycle: {
    mounts: number
    disposals: number
    modelAttaches: number
    modelDetaches: number
  }
  chunks: readonly unknown[]
  resources: {
    totalCount: number
    totalTransferBytes: number
    totalEncodedBytes: number
    totalDecodedBytes: number
    entries: readonly unknown[]
  }
  fsReads: FsReadDiagnostics
}

/** Compatibility snapshot for the agent bridge after the browser editor was removed. */
export function getEditorDiagnostics(input: {
  activeDirty: boolean
  openBuffers: string[]
}): EditorDiagnostics {
  return {
    models: { totalCount: 0, totalBytes: 0, entries: [] },
    editors: {
      mountedCount: 0,
      activeUri: null,
      activeDirty: input.activeDirty,
      openBuffers: [...input.openBuffers],
      entries: [],
    },
    lifecycle: { mounts: 0, disposals: 0, modelAttaches: 0, modelDetaches: 0 },
    chunks: [],
    resources: {
      totalCount: 0,
      totalTransferBytes: 0,
      totalEncodedBytes: 0,
      totalDecodedBytes: 0,
      entries: [],
    },
    fsReads: getFsReadDiagnostics(),
  }
}
