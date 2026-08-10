export type ProjectSurface =
  | "changes"
  | "agents"
  | "editors"
  | "terminals"

export type ProjectSurfaceSelection = {
  workspaceId?: string | null
  checkoutKey?: string | null
  checkoutPath?: string | null
  runId?: string | null
}

export type ProjectSurfaceStateRow = {
  surface: ProjectSurface
  state: ProjectSurfaceSelection
  revision: number
  updatedAt: string
}

async function decode<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const fallback = `Project state request failed (${response.status})`
    try {
      const body = (await response.json()) as { error?: { message?: string } }
      throw new Error(body.error?.message ?? fallback)
    } catch (error) {
      if (error instanceof Error && error.message !== fallback) throw error
      throw new Error(fallback)
    }
  }
  return response.json() as Promise<T>
}

export async function loadProjectSurfaceState(
  projectId: string,
): Promise<ProjectSurfaceStateRow[]> {
  return decode(
    await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/surface-state`),
  )
}

const writers = new Map<string, Promise<void>>()

/** Serialize writes per project/surface so the latest user action wins. */
export function saveProjectSurfaceState(
  projectId: string,
  surface: ProjectSurface,
  state: ProjectSurfaceSelection,
): Promise<void> {
  const key = `${projectId}:${surface}`
  const next = (writers.get(key) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      await decode<ProjectSurfaceStateRow>(
        await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/surface-state`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ surface, state }),
        }),
      )
    })
  writers.set(key, next)
  return next.finally(() => {
    if (writers.get(key) === next) writers.delete(key)
  })
}
