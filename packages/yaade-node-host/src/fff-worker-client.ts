import { Worker } from "node:worker_threads"

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads")
let finderPromise

async function finder() {
  if (!finderPromise) {
    finderPromise = import(workerData.moduleUrl).then(async mod => {
      const created = mod.FileFinder.create({
        basePath: workerData.rootPath,
        frecencyDbPath: workerData.frecencyDbPath,
        historyDbPath: workerData.historyDbPath,
      })
      if (!created.ok) throw new Error(created.error)
      const ready = await created.value.waitForIndexReady(workerData.timeoutMs)
      if (!ready.ok) {
        created.value.destroy()
        throw new Error(ready.error)
      }
      return created.value
    })
  }
  return finderPromise
}

parentPort.on("message", async message => {
  const { id, operation, payload } = message
  try {
    const instance = await finder()
    let value
    if (operation === "ready") {
      value = true
    } else if (operation === "fileSearch") {
      const result = instance.fileSearch(payload.query, payload.options)
      if (!result.ok) throw new Error(result.error)
      value = {
        items: result.value.items.map(item => item.relativePath),
        totalMatched: result.value.totalMatched,
      }
    } else if (operation === "glob") {
      const result = instance.glob("**/*", payload.options)
      if (!result.ok) throw new Error(result.error)
      value = {
        items: result.value.items.map(item => item.relativePath),
        totalMatched: result.value.totalMatched,
      }
    } else if (operation === "grep") {
      const options = { ...(payload.options || {}) }
      // GrepCursor is a branded { _offset } file-index cursor. Reconstruct it
      // inline — createGrepCursor is not always re-exported from the package root,
      // and finder.grep only reads cursor._offset.
      if (typeof options.cursorOffset === "number") {
        options.cursor = { __brand: "GrepCursor", _offset: options.cursorOffset }
        delete options.cursorOffset
      }
      const result = instance.grep(payload.query, options)
      if (!result.ok) throw new Error(result.error)
      const next = result.value.nextCursor
      const nextOffset =
        next && typeof next._offset === "number" ? next._offset : null
      value = {
        items: result.value.items.map(match => ({
          relativePath: match.relativePath,
          lineContent: match.lineContent,
          lineNumber: match.lineNumber,
          col: match.col,
          matchRanges: match.matchRanges,
        })),
        hasMore: nextOffset != null,
        nextCursorOffset: nextOffset,
      }
    } else if (operation === "track") {
      instance.trackQuery(payload.query, payload.selectedPath)
      value = null
    } else if (operation === "destroy") {
      instance.destroy()
      value = null
    } else {
      throw new Error("Unknown FFF worker operation: " + operation)
    }
    parentPort.postMessage({ id, ok: true, value })
    if (operation === "destroy") parentPort.close()
  } catch (error) {
    parentPort.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})
`

type PendingRequest = {
  resolve(value: unknown): void
  reject(error: unknown): void
  cleanup(): void
}

export type FffWorkerGrepMatch = {
  relativePath: string
  lineContent: string
  lineNumber: number
  col: number
  matchRanges: Array<[number, number]>
}

export class FffWorkerClient {
  private readonly worker: Worker
  private readonly pending = new Map<number, PendingRequest>()
  private nextRequestId = 1
  private stopped = false

  constructor(options: {
    moduleUrl: string
    rootPath: string
    frecencyDbPath: string
    historyDbPath: string
    timeoutMs: number
  }) {
    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: options,
    })
    this.worker.on("message", message => this.handleMessage(message))
    this.worker.on("error", error => this.failAll(error))
    this.worker.on("exit", code => {
      if (!this.stopped && code !== 0) {
        this.failAll(new Error(`FFF worker exited with code ${code}`))
      }
    })
  }

  request<T>(operation: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    if (this.stopped) return Promise.reject(new Error("FFF worker is stopped"))
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("search aborted"))
    const id = this.nextRequestId++
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id)
        reject(signal?.reason ?? new Error("search aborted"))
        // Native FFF calls are synchronous. Terminating their isolated worker
        // is the only way to make a superseded query stop immediately.
        void this.terminate(signal?.reason)
      }
      const cleanup = () => signal?.removeEventListener("abort", onAbort)
      this.pending.set(id, { resolve: value => resolve(value as T), reject, cleanup })
      signal?.addEventListener("abort", onAbort, { once: true })
      this.worker.postMessage({ id, operation, payload })
    })
  }

  async destroy(): Promise<void> {
    if (this.stopped) return
    try {
      await this.request("destroy", null)
    } finally {
      await this.terminate()
    }
  }

  async terminate(reason: unknown = new Error("FFF worker stopped")): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.failAll(reason)
    await this.worker.terminate()
  }

  private handleMessage(message: unknown): void {
    if (!message || typeof message !== "object") return
    const response = message as { id?: unknown; ok?: unknown; value?: unknown; error?: unknown }
    if (typeof response.id !== "number") return
    const request = this.pending.get(response.id)
    if (!request) return
    this.pending.delete(response.id)
    request.cleanup()
    if (response.ok === true) request.resolve(response.value)
    else request.reject(new Error(typeof response.error === "string" ? response.error : "FFF worker failed"))
  }

  private failAll(error: unknown): void {
    for (const request of this.pending.values()) {
      request.cleanup()
      request.reject(error)
    }
    this.pending.clear()
  }
}
