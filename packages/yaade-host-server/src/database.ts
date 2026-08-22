import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

type DatabaseInputValue = null | number | bigint | string | NodeJS.ArrayBufferView;
type DatabaseOutputValue = null | number | bigint | string | NodeJS.NonSharedUint8Array;

type DatabaseStatement = {
  all(...parameters: DatabaseInputValue[]): Record<string, DatabaseOutputValue>[];
  get(...parameters: DatabaseInputValue[]): Record<string, DatabaseOutputValue> | undefined;
  run(...parameters: DatabaseInputValue[]): {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  };
};

type DatabaseConnection = {
  exec(sql: string): void;
  prepare(sql: string): DatabaseStatement;
  close(): void;
};

type DatabaseConstructor = new (
  path: string,
  options?: { timeout?: number },
) => DatabaseConnection;

const SQLITE_BUSY_TIMEOUT_MS = 8_000;
export const STORAGE_FAILURE_FILE = "storage-failure.json";

export function writeStorageFailureRecord(dataDir: string, error: unknown): void {
  const payload = {
    generatedAt: new Date().toISOString(),
    message: error instanceof Error ? error.message : String(error),
    recovery:
      "Restore yaade.sqlite3 from a backup. The daemon refused to open or migrate a corrupt database.",
  };
  try {
    fs.writeFileSync(
      path.join(dataDir, STORAGE_FAILURE_FILE),
      `${JSON.stringify(payload, null, 2)}\n`,
      { mode: 0o600 },
    );
  } catch {
    /* the original SQLite error is more important */
  }
}

type DatabaseModule = {
  readonly Database: DatabaseConstructor;
  readonly DatabaseSync: DatabaseConstructor;
};

function isSqliteBusy(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /SQLITE_BUSY|database is locked/i.test(text);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function retrySqliteBusy<T>(operation: () => T, attempts = 40): T {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
      if (!isSqliteBusy(error) || attempt === attempts - 1) throw error;
      sleepSync(Math.min(200, 25 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function openSqliteConnection(dbPath: string): DatabaseConnection {
  const Database = loadDatabaseConstructor();
  try {
    return new Database(dbPath, { timeout: SQLITE_BUSY_TIMEOUT_MS });
  } catch {
    return new Database(dbPath);
  }
}

/** Bun exposes SQLite as `bun:sqlite`; Node terminals the built-in `node:sqlite`. */
function loadDatabaseConstructor(): DatabaseConstructor {
  const moduleName = process.versions.bun ? "bun:sqlite" : "node:sqlite";
  const exportName = process.versions.bun ? "Database" : "DatabaseSync";
  const loaded: DatabaseModule = createRequire(import.meta.url)(moduleName);
  const constructor = loaded[exportName];
  if (!constructor) {
    throw new Error(`SQLite module ${moduleName} does not export ${exportName}`);
  }
  return constructor;
}

/**
 * A domain-facing SQLite session. It deliberately omits connection lifecycle
 * methods (`close`, pragmas, and file paths); only the database owner can own
 * those concerns.
 */
export type DatabaseSession = {
  exec(sql: string): void;
  prepare(sql: string): DatabaseStatement;
};

export type DatabaseMigration = {
  readonly id: string;
  readonly apply: (db: DatabaseSession) => void;
};

/**
 * The sole owner of a host SQLite connection.
 *
 * Repositories receive `session`, while boot and shutdown stay here. Named
 * migrations terminal a separate table so domains cannot accidentally claim one
 * another's numeric entry in the old compatibility table.
 */
export class DatabaseOwner {
  private readonly connection: DatabaseConnection;
  private closed = false;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    try {
      this.connection = retrySqliteBusy(() => {
        const connection = openSqliteConnection(dbPath);
        try {
          connection.exec(`
            PRAGMA journal_mode=WAL;
            PRAGMA foreign_keys=ON;
            PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS};
          `);
          return connection;
        } catch (error) {
          connection.close();
          throw error;
        }
      });
      const integrity = this.connection.prepare("PRAGMA quick_check").get();
      const integrityText = String(
        (integrity as { quick_check?: unknown } | undefined)?.quick_check ?? "",
      );
      if (integrityText && integrityText !== "ok") {
        this.connection.close();
        throw new Error(`sqlite integrity check failed: ${integrityText}`);
      }
    } catch (error) {
      if (dbPath !== ":memory:") {
        writeStorageFailureRecord(path.dirname(dbPath), error);
      }
      throw error;
    }
  }

  get session(): DatabaseSession {
    return this.connection;
  }

  transaction<T>(operation: () => T): T {
    retrySqliteBusy(() => {
      this.connection.exec("BEGIN IMMEDIATE");
    });
    try {
      const result = operation();
      this.connection.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.connection.exec("ROLLBACK");
      } catch {
        /* preserve the original failure */
      }
      throw error;
    }
  }

  migrate(migrations: readonly DatabaseMigration[]): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS host_schema_migrations(
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);
    for (const migration of migrations) {
      const applied = this.connection
        .prepare("SELECT id FROM host_schema_migrations WHERE id=?")
        .get(migration.id);
      if (applied) continue;
      this.transaction(() => {
        migration.apply(this.session);
        this.connection
          .prepare("INSERT INTO host_schema_migrations(id, applied_at) VALUES(?, datetime('now'))")
          .run(migration.id);
      });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.connection.close();
    } catch {
      /* already closed */
    }
  }
}
