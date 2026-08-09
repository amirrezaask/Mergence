import { normalizeAbsPath, type WorkspaceFolder } from "@yaade/workspace"

export type ServerProject = {
  id: string
  name: string
  rootPath: string
  createdAt?: string
  updatedAt?: string
}

export type OpenServerProject = {
  project: ServerProject
  created: boolean
}

/** Legacy browser catalog — migrated once into host SQLite then cleared. */
const LEGACY_PROJECT_CATALOG_KEY = "jet-project-catalog-v1"

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  if (!response.ok) {
    let message = `YAADE project API failed (${response.status})`
    try {
      const body = (await response.json()) as {
        error?: { code?: string; message?: string }
      }
      if (body.error?.message) message = body.error.message
    } catch {
      /* keep status fallback */
    }
    throw new Error(message)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export async function loadServerProjects(): Promise<ServerProject[]> {
  return request<ServerProject[]>("/api/v1/projects")
}

export async function loadServerProjectPaths(): Promise<string[]> {
  const projects = await loadServerProjects()
  return projects.map(project => project.rootPath)
}

export async function addServerProject(
  rootPath: string,
  name?: string,
): Promise<ServerProject> {
  return (await openServerProject(rootPath, name)).project
}

/** The sole project-introduction operation. It never creates a filesystem directory. */
export async function openServerProject(
  rootPath: string,
  name?: string,
): Promise<OpenServerProject> {
  return request<OpenServerProject>("/api/v1/projects/open", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rootPath, name }),
  })
}

export async function removeServerProject(projectId: string): Promise<void> {
  await request<void>(`/api/v1/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
  })
}

let projectCatalogSyncQueue: Promise<void> = Promise.resolve()

/**
 * Make host SQLite `projects` table match the live workspace folder set.
 * Source of truth is the server DB after sync — no client Storage.
 *
 * Uses idempotent add (server realpaths) to collect keep-ids, then deletes
 * the rest — avoids /var vs /private/var false remove+readd races.
 */
export function syncServerProjectCatalog(
  folders: WorkspaceFolder[],
): Promise<void> {
  const snapshot = folders.map(folder => ({
    path: folder.root.path,
    name: folder.root.name,
  }))
  projectCatalogSyncQueue = projectCatalogSyncQueue
    .catch(() => {
      /* a newer snapshot can recover from a transient host failure */
    })
    .then(async () => {
      const keepIds = new Set<string>()
      for (const folder of snapshot) {
        const project = await addServerProject(folder.path, folder.name)
        keepIds.add(project.id)
      }
      const projects = await loadServerProjects()
      await Promise.all(
        projects
          .filter(project => !keepIds.has(project.id))
          .map(project => removeServerProject(project.id)),
      )
    })
  return projectCatalogSyncQueue
}

/**
 * One-shot: push any leftover localStorage catalog into SQLite, then delete key.
 * Safe to call every boot — no-op when key absent.
 */
export async function migrateLegacyLocalProjectCatalog(
  storage: Pick<Storage, "getItem" | "removeItem"> = localStorage,
): Promise<void> {
  let raw: string | null = null
  try {
    raw = storage.getItem(LEGACY_PROJECT_CATALOG_KEY)
  } catch {
    return
  }
  if (!raw) return

  try {
    const parsed = JSON.parse(raw) as {
      projects?: Array<{ path?: string }>
    }
    const paths = Array.isArray(parsed.projects)
      ? parsed.projects
          .map(item =>
            typeof item?.path === "string" ? normalizeAbsPath(item.path) : null,
          )
          .filter((path): path is string => Boolean(path))
      : []
    for (const rootPath of paths) {
      try {
        await addServerProject(rootPath)
      } catch {
        /* path may be outside allowed roots or gone — skip */
      }
    }
  } finally {
    try {
      storage.removeItem(LEGACY_PROJECT_CATALOG_KEY)
    } catch {
      /* ignore */
    }
  }
}
