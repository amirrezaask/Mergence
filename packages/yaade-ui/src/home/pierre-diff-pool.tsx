import type { ReactNode } from "react"
import { DEFAULT_THEMES } from "@pierre/diffs"
import { WorkerPoolContextProvider } from "@pierre/diffs/react"
// Vite resolves `?worker&url` to a built worker asset URL (requires worker.format: "es").
import pierreWorkerUrl from "@pierre/diffs/worker/worker.js?worker&url"

function pierreWorkerFactory(): Worker {
  return new Worker(pierreWorkerUrl, { type: "module" })
}

const workerPoolAvailable = typeof Worker !== "undefined"

const PIERRE_POOL_OPTIONS = {
  workerFactory: pierreWorkerFactory,
  poolSize: 2,
  totalASTLRUCacheSize: 16,
}

const PIERRE_HIGHLIGHTER_OPTIONS = {
  theme: DEFAULT_THEMES,
}

/**
 * Shared Pierre worker pool — mount once above file switches so remounts of
 * `YaadeDiffViewer` do not tear down Shiki workers.
 */
export function PierreDiffPool(props: { children: ReactNode }) {
  if (!workerPoolAvailable) return <>{props.children}</>
  return (
    <WorkerPoolContextProvider
      poolOptions={PIERRE_POOL_OPTIONS}
      highlighterOptions={PIERRE_HIGHLIGHTER_OPTIONS}
    >
      {props.children}
    </WorkerPoolContextProvider>
  )
}
