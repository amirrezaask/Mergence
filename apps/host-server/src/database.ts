import { DatabaseSync } from "node:sqlite"
import fs from "node:fs"
import path from "node:path"

/**
 * A domain-facing SQLite session. It deliberately omits connection lifecycle
 * methods (`close`, pragmas, and file paths); only the database owner can own
 * those concerns.
 */
export type DatabaseSession = Pick<DatabaseSync, "exec" | "prepare">

export type DatabaseMigration = {
  readonly id: string
  readonly apply: (db: DatabaseSession) => void
}

/**
 * The sole owner of a host SQLite connection.
 *
 * Repositories receive `session`, while boot and shutdown stay here. Named
 * migrations use a separate table so domains cannot accidentally claim one
 * another's numeric entry in the old compatibility table.
 */
export class DatabaseOwner {
  private readonly connection: DatabaseSync
  private closed = false

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.connection = new DatabaseSync(dbPath)
    this.connection.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
    `)
    const integrity = this.connection.prepare("PRAGMA quick_check").get()
    const integrityText =
      typeof integrity === "string"
        ? integrity
        : integrity &&
            typeof integrity === "object" &&
            "quick_check" in integrity &&
            typeof integrity.quick_check === "string"
          ? integrity.quick_check
          : ""
    if (integrityText && integrityText !== "ok") {
      this.connection.close()
      throw new Error(`sqlite integrity check failed: ${integrityText}`)
    }
  }

  get session(): DatabaseSession {
    return this.connection
  }

  transaction<T>(operation: () => T): T {
    this.connection.exec("BEGIN IMMEDIATE")
    try {
      const result = operation()
      this.connection.exec("COMMIT")
      return result
    } catch (error) {
      try {
        this.connection.exec("ROLLBACK")
      } catch {
        /* preserve the original failure */
      }
      throw error
    }
  }

  migrate(migrations: readonly DatabaseMigration[]): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS host_schema_migrations(
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `)
    for (const migration of migrations) {
      const applied = this.connection
        .prepare("SELECT id FROM host_schema_migrations WHERE id=?")
        .get(migration.id)
      if (applied) continue
      this.transaction(() => {
        migration.apply(this.session)
        this.connection
          .prepare(
            "INSERT INTO host_schema_migrations(id, applied_at) VALUES(?, datetime('now'))",
          )
          .run(migration.id)
      })
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.connection.close()
    } catch {
      /* already closed */
    }
  }

}

