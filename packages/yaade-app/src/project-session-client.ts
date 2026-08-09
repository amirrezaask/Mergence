import {
  tryDecodeProjectSessionPayload,
  type ProjectSession,
  type ProjectSessionPayload,
  type ProjectSessionSummary,
} from "@yaade/rpc"

async function requestJson<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, init)
  if (!response.ok) {
    let message = `project-sessions API failed (${response.status})`
    try {
      const body = (await response.json()) as {
        error?: { message?: string }
      }
      if (body.error?.message) message = body.error.message
    } catch {
      /* keep status message */
    }
    throw new Error(message)
  }
  return (await response.json()) as T
}

function normalizeSession(raw: ProjectSession): ProjectSession {
  const payload = tryDecodeProjectSessionPayload(raw.payload)
  return {
    ...raw,
    payload: payload ?? {
      version: 2,
      layout: { tree: { root: null }, focusedPaneId: null, zoomedPaneId: null },
      sessions: [],
    },
  }
}

export async function listProjectSessions(
  rootPath: string,
): Promise<ProjectSessionSummary[]> {
  const q = encodeURIComponent(rootPath)
  return requestJson<ProjectSessionSummary[]>(
    `/api/v1/project-sessions?root=${q}`,
  )
}

export async function loadProjectSession(
  sessionId: string,
): Promise<ProjectSession> {
  const raw = await requestJson<ProjectSession>(
    `/api/v1/project-sessions/${encodeURIComponent(sessionId)}`,
  )
  return normalizeSession(raw)
}

export async function createProjectSession(input: {
  rootPath: string
  title?: string
  /** Attach an existing checkout (main or worktree) without `git worktree add`. */
  cwdPath?: string
  worktreeBranch?: string | null
  worktreePath?: string | null
  worktree?: { branch: string; baseRef?: string; createBranch?: boolean }
}): Promise<ProjectSession> {
  const raw = await requestJson<ProjectSession>("/api/v1/project-sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  })
  return normalizeSession(raw)
}

/**
 * Reopen the newest non-archived session for a checkout, or create one.
 * Used by the Worktrees picker to enter MuxApp for Main / an existing worktree.
 */
export async function openCheckoutSession(input: {
  rootPath: string
  cwdPath: string
  title?: string
  worktreeBranch?: string | null
  worktreePath?: string | null
}): Promise<ProjectSession> {
  const sessions = await listProjectSessions(input.rootPath)
  const match = sessions
    .filter(s => !s.archivedAt && s.cwdPath === input.cwdPath)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0]
  if (match) return loadProjectSession(match.id)

  const isMain = input.cwdPath === input.rootPath
  return createProjectSession({
    rootPath: input.rootPath,
    title:
      input.title ??
      (input.worktreeBranch?.trim()
        ? input.worktreeBranch.trim()
        : isMain
          ? "Main"
          : "Session"),
    ...(isMain
      ? {}
      : {
          cwdPath: input.cwdPath,
          worktreeBranch: input.worktreeBranch ?? null,
          worktreePath: input.worktreePath ?? input.cwdPath,
        }),
  })
}

export async function saveProjectSessionPayload(
  sessionId: string,
  payload: ProjectSessionPayload,
): Promise<ProjectSession> {
  const raw = await requestJson<ProjectSession>(
    `/api/v1/project-sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload }),
      keepalive: true,
    },
  )
  return normalizeSession(raw)
}

export async function renameProjectSession(
  sessionId: string,
  title: string,
): Promise<ProjectSession> {
  const raw = await requestJson<ProjectSession>(
    `/api/v1/project-sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    },
  )
  return normalizeSession(raw)
}

export async function archiveProjectSession(
  sessionId: string,
  archived = true,
): Promise<ProjectSession> {
  const raw = await requestJson<ProjectSession>(
    `/api/v1/project-sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived }),
    },
  )
  return normalizeSession(raw)
}

export async function deleteProjectSession(
  sessionId: string,
  opts?: { removeWorktree?: boolean },
): Promise<void> {
  const q = opts?.removeWorktree ? "?removeWorktree=1" : ""
  await requestJson<{ ok: boolean }>(
    `/api/v1/project-sessions/${encodeURIComponent(sessionId)}${q}`,
    { method: "DELETE" },
  )
}

type PendingPayload = {
  sessionId: string
  payload: ProjectSessionPayload
}

/**
 * Debounced single-writer for project session layouts.
 * Coalesces rapid pane/layout mutations into one PUT.
 *
 * Unmount must call `flushAndStop()` (not `flush()` + `stop()`): a plain
 * `stop()` used to flip `stopped` before the async drain ran, which dropped
 * the pending snapshot — closed panes and newly launched agents never hit
 * SQLite, so HQ live-agents stayed empty and layouts resurrected on revisit.
 */
export class ProjectSessionPersistWriter {
  private pending: PendingPayload | null = null
  private writing = false
  private retryAttempt = 0
  private cancelRetry: (() => void) | null = null
  private stopped = false
  private flushing = false
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private readonly debounceMs: number
  private writeWaiters: Array<() => void> = []

  constructor(
    private readonly save: (
      sessionId: string,
      payload: ProjectSessionPayload,
    ) => Promise<ProjectSession> = saveProjectSessionPayload,
    debounceMs = 400,
  ) {
    this.debounceMs = debounceMs
  }

  enqueue(sessionId: string, payload: ProjectSessionPayload): void {
    if (this.stopped) return
    this.pending = { sessionId, payload }
    this.cancelScheduledRetry()
    if (this.flushing) return
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.drain()
    }, this.debounceMs)
  }

  flush(): Promise<void> {
    return this.flushPending()
  }

  /**
   * Persist any pending snapshot (including one still in the debounce window),
   * wait for in-flight writes, then refuse further enqueues.
   */
  async flushAndStop(): Promise<void> {
    try {
      await this.flushPending()
    } finally {
      this.stopped = true
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer)
        this.debounceTimer = null
      }
      this.cancelScheduledRetry()
    }
  }

  /** @deprecated Prefer `flushAndStop()` on unmount so pending writes are not dropped. */
  stop(): void {
    void this.flushAndStop()
  }

  private clearDebounce(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
  }

  private cancelScheduledRetry(): void {
    this.cancelRetry?.()
    this.cancelRetry = null
  }

  private scheduleNextRetry(): void {
    if (this.stopped || this.flushing || this.cancelRetry || !this.pending) {
      return
    }
    const delayMs = Math.min(5_000, 250 * 2 ** this.retryAttempt)
    this.retryAttempt += 1
    const timer = globalThis.setTimeout(() => {
      this.cancelRetry = null
      void this.drain()
    }, delayMs)
    this.cancelRetry = () => globalThis.clearTimeout(timer)
  }

  private notifyWriteWaiters(): void {
    const waiters = this.writeWaiters
    this.writeWaiters = []
    for (const resolve of waiters) resolve()
  }

  private waitForWriteSlot(): Promise<void> {
    if (!this.writing) return Promise.resolve()
    return new Promise<void>(resolve => {
      this.writeWaiters.push(resolve)
    })
  }

  /** Run pending saves to completion (best-effort; one retry on hard flush). */
  private async flushPending(): Promise<void> {
    this.clearDebounce()
    this.cancelScheduledRetry()
    this.flushing = true
    try {
      await this.waitForWriteSlot()
      while (this.pending) {
        const snapshot = this.pending
        this.pending = null
        this.writing = true
        try {
          try {
            await this.save(snapshot.sessionId, snapshot.payload)
            this.retryAttempt = 0
          } catch {
            try {
              await this.save(snapshot.sessionId, snapshot.payload)
              this.retryAttempt = 0
            } catch {
              // Best-effort flush — abandon after one immediate retry.
            }
          }
        } finally {
          this.writing = false
          this.notifyWriteWaiters()
        }
      }
    } finally {
      this.flushing = false
    }
  }

  private async drain(): Promise<void> {
    if (this.flushing || this.writing || !this.pending) return
    this.writing = true
    try {
      while (this.pending && !this.flushing) {
        const snapshot = this.pending
        this.pending = null
        try {
          await this.save(snapshot.sessionId, snapshot.payload)
          this.retryAttempt = 0
        } catch {
          this.pending ??= snapshot
          this.scheduleNextRetry()
          return
        }
      }
    } finally {
      this.writing = false
      this.notifyWriteWaiters()
      if (this.pending && !this.flushing && !this.cancelRetry) void this.drain()
    }
  }
}
