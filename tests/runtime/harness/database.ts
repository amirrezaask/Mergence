import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import type { DatabaseSnapshot } from "./types.js"

type SqliteStatement = {
  all: (...parameters: unknown[]) => Record<string, unknown>[]
  run: (...parameters: unknown[]) => unknown
}

type DatabaseConnection = {
  prepare: (sql: string) => SqliteStatement
  close: () => void
}

function dbPathFor(dataDir: string): string {
  return path.join(dataDir, "jet.sqlite3")
}

function openSqlite(dbPath: string): DatabaseConnection | null {
  if (!fs.existsSync(dbPath)) return null
  try {
    const loaded = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (
        path: string,
        options?: { timeout?: number },
      ) => DatabaseConnection
    }
    return new loaded.DatabaseSync(dbPath, { timeout: 5_000 })
  } catch {
    return null
  }
}

function tableRows(db: DatabaseConnection, sql: string): Array<Record<string, unknown>> {
  try {
    return db.prepare(sql).all()
  } catch {
    return []
  }
}

export function readDatabaseState(dataDir: string): DatabaseSnapshot {
  const dbPath = dbPathFor(dataDir)
  const db = openSqlite(dbPath)
  if (!db) {
    return {
      path: dbPath,
      terminalInstances: [],
      sessions: [],
      toolUses: [],
    }
  }
  try {
    return {
      path: dbPath,
      terminalInstances: tableRows(
        db,
        "SELECT id, generation, pty_id, process_state, launch_request_id, native_session_id, native_session_ref_json, process_identity_json, tool_use_id FROM terminal_instances WHERE removed_at IS NULL",
      ),
      sessions: tableRows(db, "SELECT id, title, archived_at FROM app_sessions"),
      toolUses: tableRows(
        db,
        "SELECT id, session_id, kind, status, archived_at FROM tool_uses",
      ),
    }
  } finally {
    db.close()
  }
}

export function cloneHostDatabase(
  sourceDataDir: string,
  destDataDir: string,
  serverId: string,
): void {
  const source = dbPathFor(sourceDataDir)
  const dest = dbPathFor(destDataDir)
  fs.mkdirSync(destDataDir, { recursive: true })
  fs.copyFileSync(source, dest)
  for (const suffix of ["-wal", "-shm"]) {
    const extra = `${source}${suffix}`
    if (fs.existsSync(extra)) fs.copyFileSync(extra, `${dest}${suffix}`)
  }
  const db = openSqlite(dest)
  if (!db) throw new Error(`cloned database missing at ${dest}`)
  try {
    db.prepare("UPDATE host_identity SET server_id=?").run(serverId)
  } finally {
    db.close()
  }
}

export function expireUnusedPairingCodes(dataDir: string): void {
  const dbPath = dbPathFor(dataDir)
  const db = openSqlite(dbPath)
  if (!db) throw new Error(`database missing at ${dbPath}`)
  try {
    db.prepare("UPDATE pairing_codes SET expires_at=? WHERE used_at IS NULL").run(
      "2000-01-01T00:00:00.000Z",
    )
  } finally {
    db.close()
  }
}

export function listAuditEvents(dataDir: string): Array<Record<string, unknown>> {
  const dbPath = dbPathFor(dataDir)
  const db = openSqlite(dbPath)
  if (!db) return []
  try {
    return tableRows(
      db,
      "SELECT action,device_id,resource_type,resource_id,details_json FROM audit_events ORDER BY occurred_at ASC",
    )
  } finally {
    db.close()
  }
}

export function patchTerminalInstanceIdentity(
  dataDir: string,
  instanceId: string,
  identityJson: string,
): void {
  const dbPath = dbPathFor(dataDir)
  const db = openSqlite(dbPath)
  if (!db) throw new Error(`database missing at ${dbPath}`)
  try {
    db.prepare(
      "UPDATE terminal_instances SET process_identity_json=?, process_state='running', ended_at=NULL, end_reason=NULL WHERE id=?",
    ).run(identityJson, instanceId)
  } finally {
    db.close()
  }
}
