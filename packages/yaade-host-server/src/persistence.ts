import fs from "node:fs"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { DatabaseOwner, type DatabaseSession } from "./database.js"
import { ensureAgentTelemetrySchema } from "./agents/schema.js"
import { ensureNotificationSchema } from "./notifications/schema.js"
import {
  EMPTY_SESSION_ROSTER,
  MAX_EDITOR_RECOVERY_BUFFER_BYTES,
  MAX_EDITOR_RECOVERY_SESSION_BYTES,
  emptyProjectSessionPayload,
  emptyWorkspaceSession,
  tryDecodeProjectSessionPayload,
  tryDecodeSessionRoster,
  tryDecodeWorkspaceSession,
  type ProjectSession,
  type ProjectSessionPayload,
  type ProjectSessionSummary,
  type EditorRecoveryBuffer,
  type EditorRecoveryBufferSummary,
  type SessionRoster,
  type SessionRosterEntry,
  type SessionRosterMode,
  type TerminalSessionStatus,
  type WorkspaceSession,
} from "@yaade/rpc"
import {
  canonicalizeFileUri,
  fileUriToPath,
  pathToFileUri,
} from "@yaade/shared"
export type Project = {
  id: string
  name: string
  rootPath: string
  createdAt: string
  updatedAt: string
}

export type SessionRosterStatus = TerminalSessionStatus
export type { SessionRosterMode, SessionRosterEntry, SessionRoster }

export class EditorRecoveryQuotaError extends Error {
  constructor(
    readonly quota: "buffer" | "session",
    readonly size: number,
    readonly max: number,
  ) {
    super(`editor recovery ${quota} quota exceeded: ${size} bytes (max ${max})`)
    this.name = "EditorRecoveryQuotaError"
  }
}

type ProjectDatabaseOptions = {
  maxEditorRecoveryBufferBytes?: number
  maxEditorRecoverySessionBytes?: number
}

type ProjectRow = {
  id: string
  name: string
  root_path: string
  created_at: string
  updated_at: string
}

type RosterEntryRow = {
  tab_id: string
  cwd_root_uri: string
  label: string
  launch_command: string | null
  launch_args_json: string | null
  pty_id: string | null
  status: string
  exit_code: number | null
  custom_label: string | null
  agent_id: string | null
  agent_title: string | null
  agent_driver_id: string | null
  agent_thread_id: string | null
  agent_cli_session_id: string | null
  has_user_input: number
  has_meaningful_output: number
  last_activity_at: string | null
  done_at: string | null
  transcript: string | null
}

type RosterModalRow = {
  tab_id: string | null
  session_mode: string | null
}

type EditorRecoveryRow = {
  session_id: string
  uri: string
  content: string
  base_disk_version: string | null
  language_id: string
  content_bytes: number
  updated_at: string
}

function parseLaunchArgsJson(value: string | null): unknown {
  if (!value) return undefined
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return Object.fromEntries(Object.entries(value))
}

function maxPanelId(node: unknown): number {
  const record = objectRecord(node)
  if (!record) return 0
  if (record.kind === "leaf") {
    const panelId = objectRecord(record.panelId)
    return typeof panelId?.id === "number" ? panelId.id : 0
  }
  const split = objectRecord(record.split)
  if (!split || !Array.isArray(split.children)) return 0
  let max = 0
  for (const child of split.children) max = Math.max(max, maxPanelId(child))
  return max
}

function remapPanelIds(
  node: unknown,
  nextPanelId: { value: number },
): unknown | null {
  const record = objectRecord(node)
  if (!record) return null
  if (record.kind === "leaf") {
    const panelId = objectRecord(record.panelId)
    if (!panelId || typeof panelId.id !== "number") return null
    const id = nextPanelId.value++
    return { ...record, panelId: { ...panelId, id } }
  }
  if (record.kind !== "row" && record.kind !== "column") return null
  const split = objectRecord(record.split)
  if (!split || !Array.isArray(split.children)) return null
  const children = split.children
    .map(child => remapPanelIds(child, nextPanelId))
    .filter(child => child != null)
  if (children.length === 0) return null
  return { ...record, split: { ...split, children } }
}

/** Keep panes from checkout-scoped sessions reachable after the one-session migration. */
function mergeProjectSessionLayouts(
  base: ProjectSessionPayload["layout"],
  extra: ProjectSessionPayload["layout"],
): ProjectSessionPayload["layout"] {
  const baseTree = objectRecord(base.tree)
  const extraTree = objectRecord(extra.tree)
  if (!extraTree) return base
  const extraRoot = extraTree.root
  if (!extraRoot) return base

  const declaredNext =
    typeof baseTree?.nextPanelId === "number" ? baseTree.nextPanelId : 1
  const nextPanelId = {
    value: Math.max(declaredNext, maxPanelId(baseTree?.root) + 1),
  }
  const remappedRoot = remapPanelIds(extraRoot, nextPanelId)
  if (!remappedRoot) return base

  const baseRoot = baseTree?.root
  const root = baseRoot
    ? {
        kind: "row",
        split: {
          children: [baseRoot, remappedRoot],
          ratios: [0.5, 0.5],
        },
      }
    : remappedRoot
  return {
    ...base,
    tree: {
      ...baseTree,
      root,
      nextPanelId: nextPanelId.value,
    },
  }
}

/** Validate + normalize a PUT body. Returns null when structurally invalid. */
export function parseSessionRosterBody(raw: unknown): SessionRoster | null {
  return tryDecodeSessionRoster(raw)
}

export class ProjectDatabase {
  private readonly owner: DatabaseOwner
  private readonly db: DatabaseSession
  private readonly maxEditorRecoveryBufferBytes: number
  private readonly maxEditorRecoverySessionBytes: number

  constructor(dbPath: string, options: ProjectDatabaseOptions = {}) {
    this.maxEditorRecoveryBufferBytes =
      options.maxEditorRecoveryBufferBytes ?? MAX_EDITOR_RECOVERY_BUFFER_BYTES
    this.maxEditorRecoverySessionBytes =
      options.maxEditorRecoverySessionBytes ?? MAX_EDITOR_RECOVERY_SESSION_BYTES
    if (
      !Number.isSafeInteger(this.maxEditorRecoveryBufferBytes) ||
      this.maxEditorRecoveryBufferBytes < 0 ||
      !Number.isSafeInteger(this.maxEditorRecoverySessionBytes) ||
      this.maxEditorRecoverySessionBytes < this.maxEditorRecoveryBufferBytes
    ) {
      throw new Error("invalid editor recovery limits")
    }
    this.owner = new DatabaseOwner(dbPath)
    this.db = this.owner.session
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES(1);
      CREATE TABLE IF NOT EXISTS projects(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions(
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, project_id TEXT,
        status TEXT NOT NULL, metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      UPDATE sessions SET status='interrupted', updated_at=datetime('now')
        WHERE status IN ('starting','running','waiting');
      CREATE TABLE IF NOT EXISTS project_surface_state(
        project_id TEXT NOT NULL,
        machine TEXT NOT NULL,
        surface TEXT NOT NULL,
        state_json TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(project_id, machine, surface),
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS host_identity(
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        server_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS terminal_recovery_snapshots(
        terminal_instance_id TEXT PRIMARY KEY,
        terminal_epoch TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        path TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        encrypted INTEGER NOT NULL DEFAULT 0
      );
    `)
    const identity = this.db
      .prepare("SELECT server_id FROM host_identity WHERE singleton=1")
      .get() as { server_id: string } | undefined
    if (!identity?.server_id) {
      this.db
        .prepare("INSERT OR IGNORE INTO host_identity(singleton, server_id, created_at) VALUES(1, ?, ?)")
        .run(randomUUID(), new Date().toISOString())
    }
    this.owner.migrate([
      {
        id: "notifications/schema-v1",
        apply: session => ensureNotificationSchema(session),
      },
      {
        id: "agents/schema-v1",
        apply: session => ensureAgentTelemetrySchema(session),
      },
    ])
    this.ensureSessionRosterSchema()
    this.ensureWorkspaceSessionSchema()
    this.ensureProjectSessionSchema()
    this.ensureEditorRecoverySchema()
    this.backfillProjectsFromProjectSessions()
  }

  private ensureWorkspaceSessionSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_sessions(
        machine TEXT NOT NULL,
        root_path TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (machine, root_path)
      );
    `)
  }

  private ensureProjectSessionSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_sessions(
        id TEXT PRIMARY KEY,
        machine TEXT NOT NULL,
        project_path TEXT NOT NULL,
        cwd_path TEXT NOT NULL,
        title TEXT NOT NULL,
        worktree_branch TEXT,
        worktree_path TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );
      CREATE INDEX IF NOT EXISTS project_sessions_by_project
        ON project_sessions (machine, project_path, updated_at DESC);
    `)
    this.migrateWorkspaceSessionsToProjectSessions()
    this.migrateCanonicalProjectSessions()
    this.migrateOneSessionPerProject()
  }

  /**
   * The session pivot briefly allowed multiple live rows for one checkout.
   * Keep layouts recoverable, but make the newest row the sole active workspace
   * before installing the database-level invariant used by openCheckout.
   */
  private migrateCanonicalProjectSessions(): void {
    const migrated = this.db
      .prepare("SELECT version FROM schema_migrations WHERE version=10")
      .get() as { version: number } | undefined
    if (migrated) return

    this.db.exec("BEGIN IMMEDIATE")
    try {
      const legacyRows = this.db.prepare(
        "SELECT id, project_path, cwd_path, worktree_path FROM project_sessions",
      ).all() as Array<{
        id: string
        project_path: string
        cwd_path: string
        worktree_path: string | null
      }>
      const canonicalize = this.db.prepare(
        "UPDATE project_sessions SET project_path=?, cwd_path=?, worktree_path=? WHERE id=?",
      )
      for (const row of legacyRows) {
        const projectPath = this.canonicalizeRootPath(row.project_path)
        const cwdPath = this.canonicalizeRootPath(row.cwd_path)
        const worktreePath = row.worktree_path
          ? this.canonicalizeRootPath(row.worktree_path)
          : null
        canonicalize.run(projectPath, cwdPath, worktreePath, row.id)
      }
      this.db.exec(`
        WITH ranked AS (
          SELECT id,
                 ROW_NUMBER() OVER (
                   PARTITION BY machine, project_path, cwd_path
                   ORDER BY updated_at DESC, created_at DESC, id DESC
                 ) AS ordinal
            FROM project_sessions
           WHERE archived_at IS NULL
        )
        UPDATE project_sessions
           SET archived_at=COALESCE(archived_at, datetime('now'))
         WHERE id IN (SELECT id FROM ranked WHERE ordinal > 1);
        CREATE UNIQUE INDEX IF NOT EXISTS project_sessions_one_active_checkout
          ON project_sessions(machine, project_path, cwd_path)
          WHERE archived_at IS NULL;
      `)
      this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES(10)").run()
      this.db.exec("COMMIT")
    } catch (error) {
      try { this.db.exec("ROLLBACK") } catch { /* ignore */ }
      throw error
    }
  }

  /**
   * Per-surface worktrees: one live session per project (cwd = repo root).
   * Merge checkout-scoped sessions into Main, preserving leaf cwdRootUri values.
   */
  private migrateOneSessionPerProject(): void {
    const migrated = this.db
      .prepare("SELECT version FROM schema_migrations WHERE version=11")
      .get() as { version: number } | undefined
    const targetIndex = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='project_sessions_one_active_project'",
      )
      .get() as { name: string } | undefined
    // Version 11 was briefly emitted before the index migration was finalized.
    // Verify the schema itself so those databases are repaired on next boot.
    if (migrated && targetIndex) return

    this.db.exec("BEGIN IMMEDIATE")
    try {
      const active = this.db.prepare(
        `SELECT id, machine, project_path, cwd_path, title, worktree_path, payload_json,
                created_at, updated_at
           FROM project_sessions
          WHERE archived_at IS NULL
          ORDER BY updated_at DESC, created_at DESC, id DESC`,
      ).all() as Array<{
        id: string
        machine: string
        project_path: string
        cwd_path: string
        title: string
        worktree_path: string | null
        payload_json: string
        created_at: string
        updated_at: string
      }>

      type Group = {
        machine: string
        projectPath: string
        rows: typeof active
      }
      const groups = new Map<string, Group>()
      for (const row of active) {
        const projectPath = this.canonicalizeRootPath(row.project_path)
        const key = `${row.machine}\0${projectPath}`
        const group = groups.get(key) ?? {
          machine: row.machine,
          projectPath,
          rows: [],
        }
        group.rows.push({
          ...row,
          project_path: projectPath,
          cwd_path: this.canonicalizeRootPath(row.cwd_path),
          worktree_path: row.worktree_path
            ? this.canonicalizeRootPath(row.worktree_path)
            : null,
        })
        groups.set(key, group)
      }

      const now = new Date().toISOString()
      const archive = this.db.prepare(
        `UPDATE project_sessions
            SET archived_at=COALESCE(archived_at, ?), updated_at=?
          WHERE id=?`,
      )
      const normalizeSurvivor = this.db.prepare(
        `UPDATE project_sessions
            SET project_path=?, cwd_path=?, title=?,
                worktree_branch=NULL, worktree_path=NULL,
                payload_json=?, updated_at=?
          WHERE id=?`,
      )
      const hasAgentRuns = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_runs'",
      ).get()
      const repointAgentRuns = hasAgentRuns
        ? this.db.prepare("UPDATE agent_runs SET workspace_id=? WHERE workspace_id=?")
        : null

      for (const group of groups.values()) {
        const main = group.rows.find(row => row.cwd_path === group.projectPath)
        const survivor = main ?? group.rows[0]!
        const losers = group.rows.filter(row => row.id !== survivor.id)

        let payload = emptyProjectSessionPayload()
        try {
          const decoded = tryDecodeProjectSessionPayload(
            JSON.parse(survivor.payload_json),
          )
          if (decoded) payload = decoded
        } catch {
          /* corrupt */
        }

        const seenTabs = new Set(payload.sessions.map(leaf => leaf.ptyTabId))
        const gitRoots = { ...payload.gitRoots }
        const editorFiles = { ...payload.editorFiles }
        const editorViewStates = { ...payload.editorViewStates }

        for (const loser of losers) {
          let loserPayload = emptyProjectSessionPayload()
          try {
            const decoded = tryDecodeProjectSessionPayload(
              JSON.parse(loser.payload_json),
            )
            if (decoded) loserPayload = decoded
          } catch {
            /* corrupt */
          }
          payload = {
            ...payload,
            layout: mergeProjectSessionLayouts(
              payload.layout,
              loserPayload.layout,
            ),
          }
          for (const leaf of loserPayload.sessions) {
            if (seenTabs.has(leaf.ptyTabId)) continue
            seenTabs.add(leaf.ptyTabId)
            payload = {
              ...payload,
              sessions: [...payload.sessions, leaf],
            }
          }
          if (loserPayload.gitRoots) {
            for (const [tabId, rootUri] of Object.entries(loserPayload.gitRoots)) {
              if (!(tabId in gitRoots)) gitRoots[tabId] = rootUri
            }
          }
          if (loserPayload.editorFiles) {
            for (const [tabId, file] of Object.entries(loserPayload.editorFiles)) {
              if (!(tabId in editorFiles)) editorFiles[tabId] = file
            }
          }
          if (loserPayload.editorViewStates) {
            for (const [tabId, state] of Object.entries(
              loserPayload.editorViewStates,
            )) {
              if (!(tabId in editorViewStates)) editorViewStates[tabId] = state
            }
          }
          archive.run(now, now, loser.id)
          repointAgentRuns?.run(survivor.id, loser.id)
        }

        const merged: ProjectSessionPayload = {
          version: 2,
          layout: payload.layout,
          sessions: payload.sessions,
          ...(Object.keys(gitRoots).length > 0 ? { gitRoots } : {}),
          ...(Object.keys(editorFiles).length > 0 ? { editorFiles } : {}),
          ...(Object.keys(editorViewStates).length > 0
            ? { editorViewStates }
            : {}),
        }
        normalizeSurvivor.run(
          group.projectPath,
          group.projectPath,
          survivor.title.trim() || "Main",
          JSON.stringify(this.normalizePayload(merged)),
          now,
          survivor.id,
        )
      }

      this.db.exec(`
        DROP INDEX IF EXISTS project_sessions_one_active_checkout;
        CREATE UNIQUE INDEX IF NOT EXISTS project_sessions_one_active_project
          ON project_sessions(machine, project_path)
          WHERE archived_at IS NULL;
      `)
      this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES(11)").run()
      this.db.exec("COMMIT")
    } catch (error) {
      try { this.db.exec("ROLLBACK") } catch { /* ignore */ }
      throw error
    }
  }

  private ensureEditorRecoverySchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS editor_recovery_buffers(
        session_id TEXT NOT NULL,
        uri TEXT NOT NULL,
        content TEXT NOT NULL,
        base_disk_version TEXT,
        language_id TEXT NOT NULL,
        content_bytes INTEGER NOT NULL CHECK(content_bytes >= 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, uri),
        FOREIGN KEY (session_id) REFERENCES project_sessions(id) ON DELETE CASCADE
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS editor_recovery_buffers_by_session_time
        ON editor_recovery_buffers(session_id, updated_at DESC);
    `)
  }

  /** One-time catalog backfill from persisted sessions. Never scans the filesystem. */
  private backfillProjectsFromProjectSessions(): void {
    const migrated = this.db
      .prepare("SELECT version FROM schema_migrations WHERE version=9")
      .get() as { version: number } | undefined
    if (migrated) return

    const rows = this.db
      .prepare(
        `SELECT project_path, MAX(updated_at) AS updated_at
           FROM project_sessions
          GROUP BY project_path`,
      )
      .all() as unknown as Array<{ project_path: string; updated_at: string }>
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO projects(id, name, root_path, created_at, updated_at)
       VALUES(?,?,?,?,?)`,
    )
    for (const row of rows) {
      const root = this.canonicalizeRootPath(row.project_path)
      const name = path.basename(root) || root
      insert.run(randomUUID(), name, root, row.updated_at, row.updated_at)
    }
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES(9)").run()
  }

  /** One-time: copy legacy workspace_sessions rows into project_sessions. */
  private migrateWorkspaceSessionsToProjectSessions(): void {
    const migrated = this.db
      .prepare("SELECT version FROM schema_migrations WHERE version=8")
      .get() as { version: number } | undefined
    if (migrated) return

    const rows = this.db
      .prepare(
        "SELECT machine, root_path, payload_json, updated_at FROM workspace_sessions",
      )
      .all() as unknown as Array<{
      machine: string
      root_path: string
      payload_json: string
      updated_at: string
    }>

    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO project_sessions(
         id, machine, project_path, cwd_path, title,
         worktree_branch, worktree_path, payload_json,
         created_at, updated_at, archived_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,NULL)`,
    )

    for (const row of rows) {
      let payload = emptyProjectSessionPayload()
      try {
        const decoded = tryDecodeWorkspaceSession(JSON.parse(row.payload_json))
        if (decoded) {
          payload = {
            version: 2,
            layout: decoded.layout,
            sessions: decoded.sessions,
            ...(decoded.gitRoots ? { gitRoots: decoded.gitRoots } : {}),
            ...(decoded.editorFiles ? { editorFiles: decoded.editorFiles } : {}),
          }
        }
      } catch {
        /* keep empty payload */
      }
      const root = this.canonicalizeRootPath(row.root_path)
      insert.run(
        `ses-${randomUUID()}`,
        row.machine,
        root,
        root,
        "Session 1",
        null,
        null,
        JSON.stringify(payload),
        row.updated_at,
        row.updated_at,
      )
    }

    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES(8)").run()
  }

  private ensureSessionRosterSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_roster_entries(
        tab_id TEXT PRIMARY KEY,
        cwd_root_uri TEXT NOT NULL,
        label TEXT NOT NULL,
        launch_command TEXT,
        launch_args_json TEXT,
        pty_id TEXT,
        status TEXT NOT NULL,
        exit_code INTEGER,
        custom_label TEXT,
        agent_id TEXT,
        agent_title TEXT,
        agent_driver_id TEXT,
        agent_thread_id TEXT,
        agent_cli_session_id TEXT,
        has_user_input INTEGER NOT NULL DEFAULT 0,
        has_meaningful_output INTEGER NOT NULL DEFAULT 0,
        last_activity_at TEXT,
        done_at TEXT,
        transcript TEXT,
        project_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_roster_modal(
        id INTEGER PRIMARY KEY CHECK (id = 1),
        tab_id TEXT,
        session_mode TEXT,
        updated_at TEXT NOT NULL
      );
    `)
    const columns = this.db
      .prepare("PRAGMA table_info(session_roster_entries)")
      .all() as unknown as Array<{ name: string }>
    if (!columns.some(column => column.name === "launch_args_json")) {
      this.db.exec(
        "ALTER TABLE session_roster_entries ADD COLUMN launch_args_json TEXT",
      )
    }
    if (!columns.some(column => column.name === "has_user_input")) {
      this.db.exec(
        "ALTER TABLE session_roster_entries ADD COLUMN has_user_input INTEGER NOT NULL DEFAULT 0",
      )
    }
    if (!columns.some(column => column.name === "has_meaningful_output")) {
      this.db.exec(
        "ALTER TABLE session_roster_entries ADD COLUMN has_meaningful_output INTEGER NOT NULL DEFAULT 0",
      )
    }
    if (!columns.some(column => column.name === "done_at")) {
      this.db.exec("ALTER TABLE session_roster_entries ADD COLUMN done_at TEXT")
    }
    if (!columns.some(column => column.name === "agent_cli_session_id")) {
      this.db.exec(
        "ALTER TABLE session_roster_entries ADD COLUMN agent_cli_session_id TEXT",
      )
    }
    if (!columns.some(column => column.name === "agent_title")) {
      this.db.exec(
        "ALTER TABLE session_roster_entries ADD COLUMN agent_title TEXT",
      )
    }
    if (!columns.some(column => column.name === "transcript")) {
      this.db.exec(
        "ALTER TABLE session_roster_entries ADD COLUMN transcript TEXT",
      )
    }
    this.db.exec(`
      UPDATE session_roster_entries
         SET agent_title=COALESCE(NULLIF(TRIM(custom_label), ''), label)
       WHERE agent_id IS NOT NULL
         AND TRIM(COALESCE(agent_id, '')) != ''
         AND (agent_title IS NULL OR TRIM(agent_title) = '');
    `)
    this.db
      .prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES(7)")
      .run()
    // Keep all roster rows across host restart (including blank shells).
    // Drop incomplete agent stubs only (agent_id set but no launch_command).
    this.db.exec(`
      DELETE FROM session_roster_entries
        WHERE agent_id IS NOT NULL AND TRIM(COALESCE(agent_id, '')) != ''
          AND (launch_command IS NULL OR TRIM(COALESCE(launch_command, '')) = '');
      UPDATE session_roster_entries SET status='starting', pty_id=NULL, updated_at=datetime('now')
        WHERE status IN ('starting','running')
          AND (done_at IS NULL OR TRIM(COALESCE(done_at, '')) = '');
      UPDATE session_roster_modal SET tab_id=NULL, session_mode=NULL, updated_at=datetime('now')
        WHERE tab_id IS NOT NULL
          AND tab_id NOT IN (SELECT tab_id FROM session_roster_entries);
    `)
  }

  /** The installation-scoped identity. It is stable across API restarts. */
  serverId(): string {
    const row = this.db
      .prepare("SELECT server_id FROM host_identity WHERE singleton=1")
      .get() as { server_id: string } | undefined
    if (!row?.server_id) throw new Error("host identity is missing")
    return row.server_id
  }

  /** Domain repositories receive this restricted session, not the owner. */
  session(): DatabaseSession {
    return this.db
  }

  projects(): Project[] {
    const rows = this.db
      .prepare(
        "SELECT id,name,root_path,created_at,updated_at FROM projects ORDER BY updated_at DESC",
      )
      .all() as unknown as ProjectRow[]
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  project(id: string): Project | null {
    const row = this.db
      .prepare("SELECT id,name,root_path,created_at,updated_at FROM projects WHERE id=?")
      .get(id) as ProjectRow | undefined
    if (!row) return null
    return {
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  addProject(rootPath: string, name?: string): Project {
    const root = fs.realpathSync(path.resolve(rootPath))
    const existing = this.db
      .prepare("SELECT id,name,root_path,created_at,updated_at FROM projects WHERE root_path=?")
      .get(root) as ProjectRow | undefined
    if (existing) {
      const now = new Date().toISOString()
      const projectName = name?.trim() || existing.name
      this.db
        .prepare("UPDATE projects SET name=?, updated_at=? WHERE id=?")
        .run(projectName, now, existing.id)
      return {
        id: existing.id,
        name: projectName,
        rootPath: existing.root_path,
        createdAt: existing.created_at,
        updatedAt: now,
      }
    }
    const now = new Date().toISOString()
    const id = randomUUID()
    const projectName = name?.trim() || path.basename(root) || root
    this.db
      .prepare(
        "INSERT INTO projects(id,name,root_path,created_at,updated_at) VALUES(?,?,?,?,?)",
      )
      .run(id, projectName, root, now, now)
    return { id, name: projectName, rootPath: root, createdAt: now, updatedAt: now }
  }

  /** Atomically get or create a catalog row for an already-canonical directory. */
  openProject(rootPath: string, name?: string): { project: Project; created: boolean } {
    const root = fs.realpathSync(path.resolve(rootPath))
    const existing = this.db
      .prepare("SELECT id,name,root_path,created_at,updated_at FROM projects WHERE root_path=?")
      .get(root) as ProjectRow | undefined
    if (existing) {
      return {
        project: {
          id: existing.id,
          name: existing.name,
          rootPath: existing.root_path,
          createdAt: existing.created_at,
          updatedAt: existing.updated_at,
        },
        created: false,
      }
    }
    const now = new Date().toISOString()
    const created: Project = {
      id: randomUUID(),
      name: name?.trim() || path.basename(root) || root,
      rootPath: root,
      createdAt: now,
      updatedAt: now,
    }
    try {
      this.db
        .prepare("INSERT INTO projects(id,name,root_path,created_at,updated_at) VALUES(?,?,?,?,?)")
        .run(created.id, created.name, created.rootPath, created.createdAt, created.updatedAt)
      return { project: created, created: true }
    } catch (error) {
      const raced = this.db
        .prepare("SELECT id,name,root_path,created_at,updated_at FROM projects WHERE root_path=?")
        .get(root) as ProjectRow | undefined
      if (!raced) throw error
      return {
        project: {
          id: raced.id,
          name: raced.name,
          rootPath: raced.root_path,
          createdAt: raced.created_at,
          updatedAt: raced.updated_at,
        },
        created: false,
      }
    }
  }

  removeProject(id: string): boolean {
    const result = this.db.prepare("DELETE FROM projects WHERE id=?").run(id)
    return Number(result.changes) > 0
  }

  projectSurfaceState(projectId: string, machine: string): Array<{
    surface: string
    state: Record<string, unknown>
    revision: number
    updatedAt: string
  }> {
    const rows = this.db.prepare(
      `SELECT surface,state_json,revision,updated_at
         FROM project_surface_state WHERE project_id=? AND machine=?`,
    ).all(projectId, machine) as Array<{
      surface: string
      state_json: string
      revision: number
      updated_at: string
    }>
    return rows.map(row => {
      let state: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(row.state_json) as unknown
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          state = parsed as Record<string, unknown>
        }
      } catch {
        /* malformed legacy state resets on the next write */
      }
      return {
        surface: row.surface,
        state,
        revision: row.revision,
        updatedAt: row.updated_at,
      }
    })
  }

  putProjectSurfaceState(input: {
    projectId: string
    machine: string
    surface: string
    state: Record<string, unknown>
  }): { surface: string; state: Record<string, unknown>; revision: number; updatedAt: string } {
    if (!this.project(input.projectId)) throw new Error("project not found")
    if (
      !["changes", "running", "editors", "agents", "terminals", "search"].includes(
        input.surface,
      )
    ) {
      throw new Error("invalid project surface")
    }
    const updatedAt = new Date().toISOString()
    this.db.prepare(
      `INSERT INTO project_surface_state(project_id,machine,surface,state_json,revision,updated_at)
       VALUES(?,?,?,?,1,?)
       ON CONFLICT(project_id,machine,surface) DO UPDATE SET
         state_json=excluded.state_json,
         revision=project_surface_state.revision+1,
         updated_at=excluded.updated_at`,
    ).run(input.projectId, input.machine, input.surface, JSON.stringify(input.state), updatedAt)
    return this.projectSurfaceState(input.projectId, input.machine)
      .find(row => row.surface === input.surface)!
  }

  recordSession(id: string, kind: string, status: string, metadata: unknown = {}): void {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO sessions(id,kind,project_id,status,metadata_json,created_at,updated_at)
         VALUES(?,?,NULL,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, metadata_json=excluded.metadata_json, updated_at=excluded.updated_at`,
      )
      .run(id, kind, status, JSON.stringify(metadata), now, now)
  }

  updateSessionStatus(id: string, status: string): void {
    this.db
      .prepare("UPDATE sessions SET status=?, updated_at=? WHERE id=?")
      .run(status, new Date().toISOString(), id)
  }

  getSessionRoster(): SessionRoster {
    const rows = this.db
      .prepare(
        `SELECT tab_id, cwd_root_uri, label, launch_command, launch_args_json, pty_id, status, exit_code,
                custom_label, agent_id, agent_title, agent_driver_id, agent_thread_id, agent_cli_session_id,
                has_user_input, has_meaningful_output, last_activity_at, done_at, transcript
         FROM session_roster_entries
         ORDER BY updated_at ASC`,
      )
      .all() as unknown as RosterEntryRow[]

    const sessions = rows.map(row => ({
      tabId: row.tab_id,
      cwdRootUri: row.cwd_root_uri,
      label: row.label,
      launchCommand: row.launch_command ?? undefined,
      launchArgs: parseLaunchArgsJson(row.launch_args_json),
      ptyId: row.pty_id ?? undefined,
      status: row.status,
      exitCode: row.exit_code ?? undefined,
      customLabel: row.custom_label ?? undefined,
      agentId: row.agent_id ?? undefined,
      agentTitle: row.agent_title ?? undefined,
      agentDriverId: row.agent_driver_id ?? undefined,
      agentThreadId: row.agent_thread_id ?? undefined,
      agentCliSessionId: row.agent_cli_session_id ?? undefined,
      hasUserInput: row.has_user_input === 1,
      hasMeaningfulOutput: row.has_meaningful_output === 1,
      lastActivityAt: row.last_activity_at ?? undefined,
      doneAt: row.done_at ?? undefined,
      transcript: row.transcript ?? undefined,
    }))

    const modalRow = this.db
      .prepare("SELECT tab_id, session_mode FROM session_roster_modal WHERE id=1")
      .get() as RosterModalRow | undefined
    const modal =
      modalRow?.tab_id && modalRow.session_mode
        ? { tabId: modalRow.tab_id, sessionMode: modalRow.session_mode }
        : null

    return (
      tryDecodeSessionRoster({ version: 2, sessions, modal }) ?? EMPTY_SESSION_ROSTER
    )
  }

  replaceSessionRoster(roster: SessionRoster): SessionRoster {
    const normalized = parseSessionRosterBody(roster)
    if (!normalized) throw new Error("invalid session roster")

    const now = new Date().toISOString()
    const projectIdByPath = this.projectIdByRootPath()

    this.db.exec("BEGIN")
    try {
      this.db.prepare("DELETE FROM session_roster_entries").run()
      const insert = this.db.prepare(
        `INSERT INTO session_roster_entries(
           tab_id, cwd_root_uri, label, launch_command, launch_args_json, pty_id, status, exit_code,
           custom_label, agent_id, agent_title, agent_driver_id, agent_thread_id, agent_cli_session_id,
           has_user_input, has_meaningful_output, last_activity_at, done_at, transcript,
           project_id, created_at, updated_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      for (const entry of normalized.sessions) {
        const cwdRootUri = this.canonicalizeCwdUri(entry.cwdRootUri)
        const projectId = this.resolveProjectId(cwdRootUri, projectIdByPath)
        insert.run(
          entry.tabId,
          cwdRootUri,
          entry.label,
          entry.launchCommand ?? null,
          entry.launchArgs ? JSON.stringify(entry.launchArgs) : null,
          null,
          entry.status,
          entry.exitCode ?? null,
          entry.customLabel ?? null,
          entry.agentId ?? null,
          entry.agentTitle ?? null,
          entry.agentDriverId ?? null,
          entry.agentThreadId ?? null,
          entry.agentCliSessionId ?? null,
          entry.hasUserInput ? 1 : 0,
          entry.hasMeaningfulOutput ? 1 : 0,
          entry.lastActivityAt ?? null,
          entry.doneAt ?? null,
          entry.doneAt ? entry.transcript ?? null : null,
          projectId,
          now,
          now,
        )
      }

      if (normalized.modal) {
        this.db
          .prepare(
            `INSERT INTO session_roster_modal(id, tab_id, session_mode, updated_at)
             VALUES(1,?,?,?)
             ON CONFLICT(id) DO UPDATE SET
               tab_id=excluded.tab_id,
               session_mode=excluded.session_mode,
               updated_at=excluded.updated_at`,
          )
          .run(normalized.modal.tabId, normalized.modal.sessionMode, now)
      } else {
        this.db
          .prepare(
            `INSERT INTO session_roster_modal(id, tab_id, session_mode, updated_at)
             VALUES(1, NULL, NULL, ?)
             ON CONFLICT(id) DO UPDATE SET
               tab_id=NULL, session_mode=NULL, updated_at=excluded.updated_at`,
          )
          .run(now)
      }
      this.db.exec("COMMIT")
    } catch (error) {
      try {
        this.db.exec("ROLLBACK")
      } catch {
        /* ignore */
      }
      throw error
    }

    return this.getSessionRoster()
  }

  private canonicalizeRootPath(rootPath: string): string {
    try {
      return fs.realpathSync(path.resolve(rootPath))
    } catch {
      return path.resolve(rootPath)
    }
  }

  getWorkspaceSession(machine: string, rootPath: string): WorkspaceSession {
    const root = this.canonicalizeRootPath(rootPath)
    const row = this.db
      .prepare(
        "SELECT payload_json FROM workspace_sessions WHERE machine=? AND root_path=?",
      )
      .get(machine, root) as { payload_json: string } | undefined
    if (!row?.payload_json) {
      return emptyWorkspaceSession(machine, root)
    }
    try {
      const decoded = tryDecodeWorkspaceSession(JSON.parse(row.payload_json))
      if (decoded) {
        return {
          ...decoded,
          machine,
          rootPath: root,
        }
      }
    } catch {
      /* corrupt row */
    }
    return emptyWorkspaceSession(machine, root)
  }

  replaceWorkspaceSession(session: WorkspaceSession): WorkspaceSession {
    const normalized = tryDecodeWorkspaceSession(session)
    if (!normalized) throw new Error("invalid workspace session")
    const root = this.canonicalizeRootPath(normalized.rootPath)
    const machine = normalized.machine.trim()
    if (!machine) throw new Error("invalid workspace session machine")

    // Keep ptyId so a browser reload can reattach while this host process lives.
    const sessions = normalized.sessions.map(leaf => ({
      ...leaf,
      cwdRootUri: this.canonicalizeCwdUri(leaf.cwdRootUri),
      ...(leaf.liveCwdUri
        ? { liveCwdUri: this.canonicalizeCwdUri(leaf.liveCwdUri) }
        : {}),
    }))

    const payload: WorkspaceSession = {
      version: 1,
      machine,
      rootPath: root,
      layout: normalized.layout,
      sessions,
      ...(normalized.gitRoots ? { gitRoots: normalized.gitRoots } : {}),
    }
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO workspace_sessions(machine, root_path, payload_json, updated_at)
         VALUES(?,?,?,?)
         ON CONFLICT(machine, root_path) DO UPDATE SET
           payload_json=excluded.payload_json,
           updated_at=excluded.updated_at`,
      )
      .run(machine, root, JSON.stringify(payload), now)
    return payload
  }

  listProjectSessions(
    machine: string,
    projectPath: string,
  ): ProjectSessionSummary[] {
    const root = this.canonicalizeRootPath(projectPath)
    const rows = this.db
      .prepare(
        `SELECT id, machine, project_path, cwd_path, title,
                worktree_branch, worktree_path, created_at, updated_at, archived_at
           FROM project_sessions
          WHERE machine=? AND project_path=?
          ORDER BY updated_at DESC`,
      )
      .all(machine, root) as unknown as Array<{
      id: string
      machine: string
      project_path: string
      cwd_path: string
      title: string
      worktree_branch: string | null
      worktree_path: string | null
      created_at: string
      updated_at: string
      archived_at: string | null
    }>
    return rows.map(row => this.mapProjectSessionSummary(row))
  }

  listAllProjectSessions(machine: string): ProjectSession[] {
    const rows = this.db
      .prepare(
        `SELECT id, machine, project_path, cwd_path, title,
                worktree_branch, worktree_path, payload_json,
                created_at, updated_at, archived_at
           FROM project_sessions
          WHERE machine=?
          ORDER BY updated_at DESC`,
      )
      .all(machine) as unknown as Array<{
      id: string
      machine: string
      project_path: string
      cwd_path: string
      title: string
      worktree_branch: string | null
      worktree_path: string | null
      payload_json: string
      created_at: string
      updated_at: string
      archived_at: string | null
    }>
    return rows.map(row => this.mapProjectSession(row))
  }

  getProjectSession(id: string): ProjectSession | null {
    const row = this.db
      .prepare(
        `SELECT id, machine, project_path, cwd_path, title,
                worktree_branch, worktree_path, payload_json,
                created_at, updated_at, archived_at
           FROM project_sessions WHERE id=?`,
      )
      .get(id) as
      | {
          id: string
          machine: string
          project_path: string
          cwd_path: string
          title: string
          worktree_branch: string | null
          worktree_path: string | null
          payload_json: string
          created_at: string
          updated_at: string
          archived_at: string | null
        }
      | undefined
    if (!row) return null
    return this.mapProjectSession(row)
  }

  createProjectSession(input: {
    machine: string
    projectPath: string
    cwdPath: string
    title: string
    worktreeBranch?: string | null
    worktreePath?: string | null
    payload?: ProjectSessionPayload
  }): ProjectSession {
    const machine = input.machine.trim()
    if (!machine) throw new Error("invalid project session machine")
    const projectPath = this.canonicalizeRootPath(input.projectPath)
    // One session per project — cwd is always the project root.
    const cwdPath = projectPath
    const title = input.title.trim() || "Main"
    const payload = tryDecodeProjectSessionPayload(
      input.payload ?? emptyProjectSessionPayload(),
    )
    if (!payload) throw new Error("invalid project session payload")
    const id = `ses-${randomUUID()}`
    const now = new Date().toISOString()
    this.openProject(projectPath)
    // Explicit create archives the previous live project session so callers
    // that mint a fresh layout (tests, recovery) still get a clean row.
    this.db
      .prepare(
        `UPDATE project_sessions SET archived_at=?, updated_at=?
          WHERE machine=? AND project_path=? AND archived_at IS NULL`,
      )
      .run(now, now, machine, projectPath)
    this.db
      .prepare(
        `INSERT INTO project_sessions(
           id, machine, project_path, cwd_path, title,
           worktree_branch, worktree_path, payload_json,
           created_at, updated_at, archived_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,NULL)`,
      )
      .run(
        id,
        machine,
        projectPath,
        cwdPath,
        title,
        null,
        null,
        JSON.stringify(this.normalizePayload(payload)),
        now,
        now,
      )
    const created = this.getProjectSession(id)
    if (!created) throw new Error("failed to create project session")
    return created
  }

  /**
   * Return the one active persistent workspace for this project (cwd = root).
   * `cwdPath` / worktree fields are ignored — worktrees are per-pane, not sessions.
   */
  openProjectCheckout(input: {
    machine: string
    projectPath: string
    cwdPath?: string
    title?: string
    worktreeBranch?: string | null
    worktreePath?: string | null
  }): ProjectSession {
    return this.ensureProjectSession({
      machine: input.machine,
      projectPath: input.projectPath,
      title: input.title,
    })
  }

  /** Idempotent Main session for a project. */
  ensureProjectSession(input: {
    machine: string
    projectPath: string
    title?: string
  }): ProjectSession {
    const machine = input.machine.trim()
    if (!machine) throw new Error("invalid project session machine")
    const projectPath = fs.realpathSync(path.resolve(input.projectPath))
    const existing = this.db.prepare(
      `SELECT id, machine, project_path, cwd_path, title, worktree_branch,
              worktree_path, payload_json, created_at, updated_at, archived_at
         FROM project_sessions
        WHERE machine=? AND project_path=? AND archived_at IS NULL`,
    ).get(machine, projectPath) as Parameters<ProjectDatabase["mapProjectSession"]>[0] | undefined
    if (existing) {
      if (
        existing.cwd_path !== projectPath ||
        existing.worktree_branch != null ||
        existing.worktree_path != null
      ) {
        const now = new Date().toISOString()
        this.db
          .prepare(
            `UPDATE project_sessions
                SET cwd_path=?, title=?, worktree_branch=NULL, worktree_path=NULL,
                    updated_at=?
              WHERE id=?`,
          )
          .run(
            projectPath,
            existing.title?.trim() || input.title?.trim() || "Main",
            now,
            existing.id,
          )
        const normalized = this.getProjectSession(existing.id)
        if (!normalized) throw new Error("failed to normalize project session")
        return normalized
      }
      return this.mapProjectSession(existing)
    }

    const id = `ses-${randomUUID()}`
    const now = new Date().toISOString()
    this.openProject(projectPath)
    try {
      this.db.prepare(
        `INSERT INTO project_sessions(
           id, machine, project_path, cwd_path, title, worktree_branch,
           worktree_path, payload_json, created_at, updated_at, archived_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,NULL)`,
      ).run(
        id,
        machine,
        projectPath,
        projectPath,
        input.title?.trim() || "Main",
        null,
        null,
        JSON.stringify(this.normalizePayload(emptyProjectSessionPayload())),
        now,
        now,
      )
    } catch (error) {
      const raced = this.db.prepare(
        `SELECT id, machine, project_path, cwd_path, title, worktree_branch,
                worktree_path, payload_json, created_at, updated_at, archived_at
           FROM project_sessions
          WHERE machine=? AND project_path=? AND archived_at IS NULL`,
      ).get(machine, projectPath) as Parameters<ProjectDatabase["mapProjectSession"]>[0] | undefined
      if (!raced) throw error
      return this.mapProjectSession(raced)
    }
    const created = this.getProjectSession(id)
    if (!created) throw new Error("failed to create project session")
    return created
  }

  /** Leaves whose cwdRootUri resolves under `checkoutPath` (busy worktree check). */
  listLeavesForCheckout(
    sessionId: string,
    checkoutPath: string,
  ): ProjectSession["payload"]["sessions"] {
    const session = this.getProjectSession(sessionId)
    if (!session) return []
    const target = this.canonicalizeRootPath(checkoutPath)
    return session.payload.sessions.filter(leaf => {
      try {
        const leafPath = this.canonicalizeRootPath(fileUriToPath(leaf.cwdRootUri))
        return leafPath === target
      } catch {
        return false
      }
    })
  }

  updateProjectSessionPayload(
    id: string,
    payload: ProjectSessionPayload,
  ): ProjectSession {
    const normalized = tryDecodeProjectSessionPayload(payload)
    if (!normalized) throw new Error("invalid project session payload")
    const existing = this.getProjectSession(id)
    if (!existing) throw new Error("project session not found")
    const now = new Date().toISOString()
    this.db
      .prepare(
        `UPDATE project_sessions
            SET payload_json=?, updated_at=?
          WHERE id=?`,
      )
      .run(JSON.stringify(this.normalizePayload(normalized)), now, id)
    const updated = this.getProjectSession(id)
    if (!updated) throw new Error("project session not found")
    return updated
  }

  renameProjectSession(id: string, title: string): ProjectSession {
    const trimmed = title.trim()
    if (!trimmed) throw new Error("invalid project session title")
    const existing = this.getProjectSession(id)
    if (!existing) throw new Error("project session not found")
    const now = new Date().toISOString()
    this.db
      .prepare(
        `UPDATE project_sessions SET title=?, updated_at=? WHERE id=?`,
      )
      .run(trimmed, now, id)
    const updated = this.getProjectSession(id)
    if (!updated) throw new Error("project session not found")
    return updated
  }

  touchProjectSession(id: string): ProjectSession {
    const existing = this.getProjectSession(id)
    if (!existing) throw new Error("project session not found")
    const now = new Date().toISOString()
    this.db
      .prepare(`UPDATE project_sessions SET updated_at=? WHERE id=?`)
      .run(now, id)
    const updated = this.getProjectSession(id)
    if (!updated) throw new Error("project session not found")
    return updated
  }

  archiveProjectSession(id: string, archived = true): ProjectSession {
    const existing = this.getProjectSession(id)
    if (!existing) throw new Error("project session not found")
    const now = new Date().toISOString()
    this.db
      .prepare(
        `UPDATE project_sessions
            SET archived_at=?, updated_at=?
          WHERE id=?`,
      )
      .run(archived ? now : null, now, id)
    const updated = this.getProjectSession(id)
    if (!updated) throw new Error("project session not found")
    return updated
  }

  listEditorRecoveryBuffers(sessionId: string): EditorRecoveryBufferSummary[] {
    const id = this.requireRecoverySessionId(sessionId)
    const rows = this.db
      .prepare(
        `SELECT session_id, uri, base_disk_version, language_id,
                content_bytes, updated_at
           FROM editor_recovery_buffers
          WHERE session_id=?
          ORDER BY updated_at DESC, uri ASC`,
      )
      .all(id) as unknown as Array<Omit<EditorRecoveryRow, "content">>
    return rows.map(row => this.mapEditorRecoverySummary(row))
  }

  getEditorRecoveryBuffer(
    sessionId: string,
    uri: string,
  ): EditorRecoveryBuffer | null {
    const id = this.requireRecoverySessionId(sessionId)
    const canonicalUri = this.canonicalizeRecoveryUri(uri)
    const row = this.db
      .prepare(
        `SELECT session_id, uri, content, base_disk_version, language_id,
                content_bytes, updated_at
           FROM editor_recovery_buffers
          WHERE session_id=? AND uri=?`,
      )
      .get(id, canonicalUri) as EditorRecoveryRow | undefined
    if (!row) return null
    return {
      ...this.mapEditorRecoverySummary(row),
      content: row.content,
    }
  }

  upsertEditorRecoveryBuffer(input: {
    sessionId: string
    uri: string
    content: string
    baseVersion: string | null
    languageId: string
  }): EditorRecoveryBufferSummary {
    const sessionId = this.requireRecoverySessionId(input.sessionId)
    const uri = this.canonicalizeRecoveryUri(input.uri)
    const baseVersion = this.validateRecoveryBaseVersion(input.baseVersion)
    const languageId = this.validateRecoveryLanguageId(input.languageId)
    const contentBytes = Buffer.byteLength(input.content, "utf8")
    if (contentBytes > this.maxEditorRecoveryBufferBytes) {
      throw new EditorRecoveryQuotaError(
        "buffer",
        contentBytes,
        this.maxEditorRecoveryBufferBytes,
      )
    }
    if (!this.projectSessionExists(sessionId)) {
      throw new Error("project session not found")
    }

    const now = new Date().toISOString()
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const row = this.db
        .prepare(
          `SELECT COALESCE(SUM(content_bytes), 0) AS content_bytes
             FROM editor_recovery_buffers
            WHERE session_id=? AND uri<>?`,
        )
        .get(sessionId, uri) as { content_bytes: number }
      const sessionBytes = row.content_bytes + contentBytes
      if (sessionBytes > this.maxEditorRecoverySessionBytes) {
        throw new EditorRecoveryQuotaError(
          "session",
          sessionBytes,
          this.maxEditorRecoverySessionBytes,
        )
      }
      this.db
        .prepare(
          `INSERT INTO editor_recovery_buffers(
             session_id, uri, content, base_disk_version, language_id,
             content_bytes, updated_at
           ) VALUES(?,?,?,?,?,?,?)
           ON CONFLICT(session_id, uri) DO UPDATE SET
             content=excluded.content,
             base_disk_version=excluded.base_disk_version,
             language_id=excluded.language_id,
             content_bytes=excluded.content_bytes,
             updated_at=excluded.updated_at`,
        )
        .run(
          sessionId,
          uri,
          input.content,
          baseVersion,
          languageId,
          contentBytes,
          now,
        )
      this.db.exec("COMMIT")
    } catch (error) {
      try {
        this.db.exec("ROLLBACK")
      } catch {
        /* transaction already closed */
      }
      throw error
    }

    return {
      sessionId,
      uri,
      baseVersion,
      languageId,
      contentBytes,
      updatedAt: now,
    }
  }

  deleteEditorRecoveryBuffer(sessionId: string, uri: string): boolean {
    const id = this.requireRecoverySessionId(sessionId)
    const canonicalUri = this.canonicalizeRecoveryUri(uri)
    const result = this.db
      .prepare(
        "DELETE FROM editor_recovery_buffers WHERE session_id=? AND uri=?",
      )
      .run(id, canonicalUri)
    return Number(result.changes ?? 0) > 0
  }

  deleteEditorRecoverySession(sessionId: string): number {
    const id = this.requireRecoverySessionId(sessionId)
    const result = this.db
      .prepare("DELETE FROM editor_recovery_buffers WHERE session_id=?")
      .run(id)
    return Number(result.changes ?? 0)
  }

  deleteProjectSession(id: string): boolean {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      this.db
        .prepare("DELETE FROM editor_recovery_buffers WHERE session_id=?")
        .run(id)
      const result = this.db
        .prepare("DELETE FROM project_sessions WHERE id=?")
        .run(id)
      this.db.exec("COMMIT")
      return Number(result.changes ?? 0) > 0
    } catch (error) {
      try {
        this.db.exec("ROLLBACK")
      } catch {
        /* transaction already closed */
      }
      throw error
    }
  }

  private projectSessionExists(id: string): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM project_sessions WHERE id=?").get(id),
    )
  }

  private requireRecoverySessionId(sessionId: string): string {
    const id = sessionId.trim()
    if (!id || id.length > 256 || /[\0\r\n]/.test(id)) {
      throw new Error("invalid editor recovery session id")
    }
    return id
  }

  private canonicalizeRecoveryUri(uri: string): string {
    const trimmed = uri.trim()
    if (
      !trimmed ||
      trimmed.length > 16 * 1024 ||
      /[\0\r\n]/.test(trimmed) ||
      !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed) ||
      (trimmed.startsWith("file:") && !trimmed.startsWith("file://"))
    ) {
      throw new Error("invalid editor recovery URI")
    }
    return trimmed.startsWith("file://")
      ? canonicalizeFileUri(trimmed)
      : trimmed
  }

  private validateRecoveryBaseVersion(value: string | null): string | null {
    if (value === null) return null
    if (value.length > 1024 || /[\0\r\n]/.test(value)) {
      throw new Error("invalid editor recovery base version")
    }
    return value
  }

  private validateRecoveryLanguageId(value: string): string {
    const languageId = value.trim()
    if (!languageId || languageId.length > 128 || /[\0\r\n]/.test(languageId)) {
      throw new Error("invalid editor recovery language id")
    }
    return languageId
  }

  private mapEditorRecoverySummary(
    row: Omit<EditorRecoveryRow, "content">,
  ): EditorRecoveryBufferSummary {
    return {
      sessionId: row.session_id,
      uri: row.uri,
      baseVersion: row.base_disk_version,
      languageId: row.language_id,
      contentBytes: row.content_bytes,
      updatedAt: row.updated_at,
    }
  }

  private normalizePayload(payload: ProjectSessionPayload): ProjectSessionPayload {
    const sessions = payload.sessions.map(leaf => ({
      ...leaf,
      cwdRootUri: this.canonicalizeCwdUri(leaf.cwdRootUri),
      ...(leaf.liveCwdUri
        ? { liveCwdUri: this.canonicalizeCwdUri(leaf.liveCwdUri) }
        : {}),
    }))
    return {
      version: 2,
      layout: payload.layout,
      sessions,
      ...(payload.gitRoots ? { gitRoots: payload.gitRoots } : {}),
      ...(payload.editorFiles ? { editorFiles: payload.editorFiles } : {}),
      ...(payload.editorViewStates
        ? { editorViewStates: payload.editorViewStates }
        : {}),
    }
  }

  private mapProjectSessionSummary(row: {
    id: string
    machine: string
    project_path: string
    cwd_path: string
    title: string
    worktree_branch: string | null
    worktree_path: string | null
    created_at: string
    updated_at: string
    archived_at: string | null
  }): ProjectSessionSummary {
    return {
      id: row.id,
      machine: row.machine,
      projectPath: row.project_path,
      cwdPath: row.cwd_path,
      title: row.title,
      worktreeBranch: row.worktree_branch,
      worktreePath: row.worktree_path,
      checkoutKey: this.checkoutKey(row.project_path, row.cwd_path),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at,
    }
  }

  private checkoutKey(projectPath: string, cwdPath: string): string {
    if (projectPath === cwdPath) return "main"
    return `wt-${createHash("sha256").update(cwdPath).digest("base64url").slice(0, 22)}`
  }

  private mapProjectSession(row: {
    id: string
    machine: string
    project_path: string
    cwd_path: string
    title: string
    worktree_branch: string | null
    worktree_path: string | null
    payload_json: string
    created_at: string
    updated_at: string
    archived_at: string | null
  }): ProjectSession {
    let payload = emptyProjectSessionPayload()
    try {
      const decoded = tryDecodeProjectSessionPayload(JSON.parse(row.payload_json))
      if (decoded) payload = decoded
    } catch {
      /* corrupt payload */
    }
    return {
      ...this.mapProjectSessionSummary(row),
      payload,
    }
  }

  close(): void {
    this.owner.close()
  }

  private canonicalizeCwdUri(cwdRootUri: string): string {
    try {
      const abs = path.resolve(fileUriToPath(cwdRootUri))
      const real = fs.realpathSync(abs)
      return pathToFileUri(real)
    } catch {
      return cwdRootUri
    }
  }

  private projectIdByRootPath(): Map<string, string> {
    const map = new Map<string, string>()
    for (const project of this.projects()) {
      map.set(path.resolve(project.rootPath), project.id)
      try {
        map.set(fs.realpathSync(project.rootPath), project.id)
      } catch {
        /* keep resolved */
      }
    }
    return map
  }

  private resolveProjectId(
    cwdRootUri: string,
    projectIdByPath: Map<string, string>,
  ): string | null {
    const abs = path.resolve(fileUriToPath(cwdRootUri))
    const direct = projectIdByPath.get(abs)
    if (direct) return direct
    try {
      return projectIdByPath.get(fs.realpathSync(abs)) ?? null
    } catch {
      return null
    }
  }
}
