import { randomUUID } from "node:crypto"
import { DatabaseOwner, type DatabaseSession } from "./database.js"

/** SQLite owner for host identity, sessions, and terminal metadata. */
export class RuntimeDatabase {
  private readonly owner: DatabaseOwner
  private readonly db: DatabaseSession

  constructor(dbPath: string) {
    this.owner = new DatabaseOwner(dbPath)
    this.db = this.owner.session
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS host_identity(
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        server_id TEXT NOT NULL,
        created_at TEXT NOT NULL
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
  }

  session(): DatabaseSession {
    return this.db
  }

  serverId(): string {
    const row = this.db
      .prepare("SELECT server_id FROM host_identity WHERE singleton=1")
      .get() as { server_id: string }
    return row.server_id
  }

  close(): void {
    this.owner.close()
  }
}
