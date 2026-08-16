import { randomUUID } from "node:crypto";
import { Data, Schema } from "effect";
import {
  AgentToolInput,
  AppSession,
  SessionTab,
  SessionTabId,
  EditorToolInput,
  EditorToolOutput,
  GitToolInput,
  GitToolOutput,
  ProcessToolOutput,
  ProjectSearchResult,
  type ResolvedToolContext,
  SearchToolInput,
  SearchToolOutput,
  SessionId,
  TerminalToolInput,
  ToolUse,
  ToolUseConflict,
  ToolUseId,
  type ToolUseInput,
  type ToolUseOutput,
  type ToolUseStatus,
  ToolKind,
} from "@yaade/rpc";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

export class ToolSessionStorageError extends Data.TaggedError(
  "ToolSessionStorageError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

type SessionRow = {
  id: string;
  machine: string;
  title: string;
  position: number;
  active_tab_id: string | null;
  active_tool_use_id: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

type SessionTabRow = {
  id: string;
  session_id: string;
  title: string;
  position: number;
  active_tool_use_id: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

type ToolUseRow = {
  id: string;
  session_id: string;
  tab_id: string | null;
  kind: string;
  title: string;
  position: number;
  status: string;
  project_id: string;
  project_path: string;
  project_name: string;
  checkout_key: string;
  checkout_path: string;
  checkout_label: string;
  branch: string | null;
  managed_worktree: number;
  input_json: string;
  input_revision: number;
  output_json: string;
  error_json: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  archived_at: string | null;
};

type SearchResultRow = {
  result_json: string;
};

const now = (): string => new Date().toISOString();
const sessionId = (): string => `ses-${randomUUID()}`;
const tabId = (): string => `tab-${randomUUID()}`;
const toolUseId = (): string => `use-${randomUUID()}`;
const ToolUseInputSchema = Schema.Union(
  AgentToolInput,
  TerminalToolInput,
  SearchToolInput,
  GitToolInput,
  EditorToolInput,
);
const ToolUseOutputSchema = Schema.Union(
  ProcessToolOutput,
  SearchToolOutput,
  GitToolOutput,
  EditorToolOutput,
);

function decodeJson<A>(
  schema: Schema.Schema<A>,
  value: string,
  label: string,
): A {
  try {
    return Schema.decodeUnknownSync(schema)(JSON.parse(value) as unknown);
  } catch (cause) {
    throw new ToolSessionStorageError({
      message: `invalid persisted ${label}`,
      cause,
    });
  }
}

function decodeToolUse(value: string): ToolUse {
  try {
    return Schema.decodeUnknownSync(ToolUse)(JSON.parse(value) as unknown);
  } catch (cause) {
    throw new ToolSessionStorageError({
      message: "invalid persisted tool use",
      cause,
    });
  }
}

function encodeJson<A>(schema: Schema.Schema<A>, value: A): string {
  return JSON.stringify(Schema.encodeSync(schema)(value));
}

function validSessionId(value: string): SessionId {
  return Schema.decodeUnknownSync(SessionId)(value);
}
function validToolUseId(value: string): ToolUseId {
  return Schema.decodeUnknownSync(ToolUseId)(value);
}
function validSessionTabId(value: string): SessionTabId {
  return Schema.decodeUnknownSync(SessionTabId)(value);
}

function checkoutContext(row: ToolUseRow): ResolvedToolContext {
  return {
    project: {
      projectId: row.project_id,
      projectPath: row.project_path,
      projectName: row.project_name,
    },
    checkoutKey: row.checkout_key,
    checkoutPath: row.checkout_path,
    checkoutLabel: row.checkout_label,
    ...(row.branch ? { branch: row.branch } : {}),
    managedWorktree: row.managed_worktree === 1,
  };
}

export type CreateToolUseRecord = {
  sessionId: SessionId;
  tabId?: SessionTabId;
  kind: ToolKind;
  title: string;
  position: number;
  context: ResolvedToolContext;
  input: ToolUseInput;
  output: ToolUseOutput;
};

/**
 * Transactional owner for the v1 Session/ToolUse tables.
 * The class deliberately accepts DatabaseSync rather than ProjectDatabase so the
 * migration and store can be tested against a fresh SQLite database.
 */
export class ToolSessionStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly machine = "default",
  ) {
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_sessions(
        id TEXT PRIMARY KEY,
        machine TEXT NOT NULL,
        title TEXT NOT NULL,
        position INTEGER NOT NULL,
        active_tab_id TEXT,
        active_tool_use_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );
      CREATE TABLE IF NOT EXISTS app_tabs(
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES app_sessions(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        position INTEGER NOT NULL,
        active_tool_use_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );
      CREATE TABLE IF NOT EXISTS tool_uses(
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES app_sessions(id) ON DELETE CASCADE,
        tab_id TEXT REFERENCES app_tabs(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        position INTEGER NOT NULL,
        status TEXT NOT NULL,
        project_id TEXT NOT NULL,
        project_path TEXT NOT NULL,
        project_name TEXT NOT NULL,
        checkout_key TEXT NOT NULL,
        checkout_path TEXT NOT NULL,
        checkout_label TEXT NOT NULL,
        branch TEXT,
        managed_worktree INTEGER NOT NULL DEFAULT 0,
        input_json TEXT NOT NULL,
        input_revision INTEGER NOT NULL DEFAULT 1,
        output_json TEXT NOT NULL,
        error_json TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        archived_at TEXT
      );
      CREATE TABLE IF NOT EXISTS tool_use_search_results(
        tool_use_id TEXT NOT NULL REFERENCES tool_uses(id) ON DELETE CASCADE,
        result_revision INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        result_json TEXT NOT NULL,
        PRIMARY KEY(tool_use_id, result_revision, ordinal)
      );
      CREATE INDEX IF NOT EXISTS app_sessions_visible
        ON app_sessions(machine, archived_at, position);
      CREATE INDEX IF NOT EXISTS app_tabs_visible
        ON app_tabs(session_id, archived_at, position);
      CREATE INDEX IF NOT EXISTS tool_uses_session_visible
        ON tool_uses(session_id, archived_at, position);
      CREATE INDEX IF NOT EXISTS tool_uses_checkout
        ON tool_uses(checkout_path, archived_at);
      CREATE INDEX IF NOT EXISTS tool_uses_status
        ON tool_uses(status, archived_at);
    `);
    this.ensureToolTabColumns();
    this.ensureTerminalCorrelationColumn();
    this.migrateLegacyRows();
  }

  private ensureToolTabColumns(): void {
    const addColumn = (table: string, column: string, definition: string): void => {
      const columns = this.db
        .prepare(`PRAGMA table_info(${table})`)
        .all() as Array<{ name: string }>;
      if (!columns.some((item) => item.name === column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
    };
    addColumn("app_sessions", "active_tab_id", "TEXT");
    addColumn("tool_uses", "tab_id", "TEXT");
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS tool_uses_tab_visible ON tool_uses(tab_id, archived_at, position)",
    );
  }

  private ensureTerminalCorrelationColumn(): void {
    const table = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='terminal_instances'",
      )
      .get();
    if (!table) return;
    const columns = this.db
      .prepare("PRAGMA table_info(terminal_instances)")
      .all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "tool_use_id")) {
      this.db.exec(
        "ALTER TABLE terminal_instances ADD COLUMN tool_use_id TEXT",
      );
    }
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_terminal_instances_tool_use ON terminal_instances(tool_use_id) WHERE tool_use_id IS NOT NULL",
    );
  }

  /** One-time, rollback-safe migration from project sessions and terminal rows. */
  private migrateLegacyRows(): void {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY)",
    );
    const migration = this.db
      .prepare("SELECT version FROM schema_migrations WHERE version=15")
      .get();
    if (!migration) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const legacy = this.hasTable("project_sessions")
          ? (this.db
              .prepare(
                "SELECT id,machine,title,created_at,updated_at,archived_at FROM project_sessions WHERE archived_at IS NULL ORDER BY updated_at DESC, created_at DESC, id DESC",
              )
              .all() as Array<{
              id: string;
              machine: string;
              title: string;
              created_at: string;
              updated_at: string;
              archived_at: string | null;
            }>)
          : [];
        const insertSession = this.db.prepare(
          "INSERT OR IGNORE INTO app_sessions(id,machine,title,position,created_at,updated_at,archived_at) VALUES(?,?,?,?,?,?,?)",
        );
        for (const [position, row] of legacy.entries()) {
          const id = /^ses-[A-Za-z0-9_-]+$/.test(row.id) ? row.id : sessionId();
          insertSession.run(
            id,
            row.machine || this.machine,
            row.title || `Session ${position + 1}`,
            position,
            row.created_at,
            row.updated_at,
            row.archived_at,
          );
        }
        this.migrateTerminalRows();
        this.ensureVisibleSession();
        this.db
          .prepare(
            "INSERT OR IGNORE INTO schema_migrations(version) VALUES(15)",
          )
          .run();
        this.db.exec("COMMIT");
      } catch (cause) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* preserve the original migration failure */
        }
        throw new ToolSessionStorageError({
          message: "Tool session migration failed",
          cause,
        });
      }
    }
    this.migrateSearchSurfaceOnce();
    this.migrateSessionTabsOnce();
  }

  /** Add one tmux-window equivalent to every session and attach legacy tools. */
  private migrateSessionTabsOnce(): void {
    const migration = this.db
      .prepare("SELECT version FROM schema_migrations WHERE version=17")
      .get();
    if (migration) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const session of this.listSessions(true)) {
        const existing = this.listTabs(session.id);
        const tab = existing[0] ?? this.insertDefaultTab(session.id);
        this.db
          .prepare("UPDATE tool_uses SET tab_id=? WHERE session_id=? AND tab_id IS NULL")
          .run(tab.id, session.id);
        const activeTab = session.activeTabId ?? tab.id;
        this.db
          .prepare("UPDATE app_sessions SET active_tab_id=? WHERE id=?")
          .run(activeTab, session.id);
      }
      this.db
        .prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES(17)")
        .run();
      this.db.exec("COMMIT");
    } catch (cause) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* preserve the original migration failure */
      }
      throw new ToolSessionStorageError({
        message: "Session tab migration failed",
        cause,
      });
    }
  }

  /** Idempotent follow-up for hosts that already applied schema 15 without search tabs. */
  private migrateSearchSurfaceOnce(): void {
    const migration = this.db
      .prepare("SELECT version FROM schema_migrations WHERE version=16")
      .get();
    if (migration) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.migrateSearchSurfaceRows();
      this.db
        .prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES(16)")
        .run();
      this.db.exec("COMMIT");
    } catch (cause) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* preserve the original migration failure */
      }
      throw new ToolSessionStorageError({
        message: "Search surface migration failed",
        cause,
      });
    }
  }

  private migrateSearchSurfaceRows(): void {
    if (!this.hasTable("project_surface_state") || !this.hasTable("projects"))
      return;
    const rows = this.db
      .prepare(
        `SELECT p.id AS project_id, p.name AS project_name, p.root_path AS project_path,
              s.state_json
         FROM project_surface_state s
         JOIN projects p ON p.id = s.project_id
        WHERE s.surface='search'`,
      )
      .all() as Array<{
      project_id: string;
      project_name: string;
      project_path: string;
      state_json: string;
    }>;
    if (rows.length === 0) return;
    const session = this.firstSession();
    if (!session) return;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO tool_uses(
        id,session_id,kind,title,position,status,project_id,project_path,project_name,
        checkout_key,checkout_path,checkout_label,managed_worktree,input_json,input_revision,
        output_json,revision,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    let position = this.nextUsePosition(session.id);
    const timestamp = now();
    for (const row of rows) {
      let state: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(row.state_json) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          state = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      const tabs = Array.isArray(state.searchTabs) ? state.searchTabs : [];
      for (const tab of tabs) {
        if (!tab || typeof tab !== "object" || Array.isArray(tab)) continue;
        const record = tab as Record<string, unknown>;
        const query = typeof record.query === "string" ? record.query : "";
        const checkoutPath =
          typeof record.checkoutPath === "string"
            ? record.checkoutPath
            : row.project_path;
        const checkoutKey =
          typeof record.checkoutKey === "string" ? record.checkoutKey : "main";
        const options =
          record.options &&
          typeof record.options === "object" &&
          !Array.isArray(record.options)
            ? record.options
            : {};
        const title = query.trim()
          ? `Search: ${query.trim().slice(0, 48)}`
          : "Search";
        const input = {
          _tag: "SearchToolInput",
          kind: "search",
          query,
          options,
        };
        const output = {
          _tag: "SearchToolOutput",
          kind: "search",
          resultRevision: 1,
          resultCount: 0,
          truncated: false,
          running: false,
        };
        insert.run(
          toolUseId(),
          session.id,
          "search",
          title,
          position++,
          "succeeded",
          row.project_id,
          row.project_path,
          row.project_name,
          checkoutKey,
          checkoutPath,
          checkoutKey === "main" ? "Main" : checkoutKey,
          0,
          JSON.stringify(input),
          1,
          JSON.stringify(output),
          1,
          timestamp,
          timestamp,
        );
      }
    }
  }

  private migrateTerminalRows(): void {
    if (!this.hasTable("terminal_instances")) return;
    const rows = this.db
      .prepare(
        `SELECT id,generation,project_id,checkout_key,checkout_path,title,pty_id,provider,
              process_state,activity_state,created_at,started_at,ended_at,exit_code,
              transcript_truncated,revision,workspace_id,tool_use_id
         FROM terminal_instances WHERE removed_at IS NULL`,
      )
      .all() as Array<{
      id: string;
      generation: number;
      project_id: string;
      checkout_key: string;
      checkout_path: string;
      title: string;
      pty_id: string | null;
      provider: string | null;
      process_state: string;
      activity_state: string;
      created_at: string;
      started_at: string | null;
      ended_at: string | null;
      exit_code: number | null;
      transcript_truncated: number;
      revision: number;
      workspace_id: string | null;
      tool_use_id: string | null;
    }>;
    const session = this.firstSession();
    if (!session) return;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO tool_uses(
        id,session_id,kind,title,position,status,project_id,project_path,project_name,
        checkout_key,checkout_path,checkout_label,managed_worktree,input_json,input_revision,
        output_json,revision,created_at,updated_at,started_at,finished_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const bind = this.db.prepare(
      "UPDATE terminal_instances SET tool_use_id=? WHERE id=? AND tool_use_id IS NULL",
    );
    let position = this.nextUsePosition(session.id);
    for (const row of rows) {
      const id =
        row.tool_use_id && /^use-[A-Za-z0-9_-]+$/.test(row.tool_use_id)
          ? row.tool_use_id
          : toolUseId();
      const kind = row.provider ? "agent" : "terminal";
      const input = row.provider
        ? { _tag: "AgentToolInput", kind: "agent", provider: row.provider }
        : { _tag: "TerminalToolInput", kind: "terminal" };
      const output = {
        _tag: "ProcessToolOutput",
        kind: "process",
        terminalInstanceId: row.id,
        ...(row.pty_id ? { ptyId: row.pty_id } : {}),
        generation: row.generation,
        processState:
          row.process_state === "reserved" ? "starting" : row.process_state,
        activityState: row.activity_state,
        replayAvailable: Boolean(row.pty_id),
        ...(row.exit_code == null ? {} : { exitCode: row.exit_code }),
        truncated: row.transcript_truncated === 1,
      };
      const context = {
        project: {
          projectId: row.project_id,
          projectPath: row.checkout_path,
          projectName: row.project_id,
        },
        checkoutKey: row.checkout_key,
        checkoutPath: row.checkout_path,
        checkoutLabel: row.checkout_key === "main" ? "Main" : row.checkout_key,
        managedWorktree: false,
      };
      insert.run(
        id,
        session.id,
        kind,
        row.title,
        position++,
        row.process_state === "running" ? "running" : "disconnected",
        row.project_id,
        row.checkout_path,
        row.project_id,
        row.checkout_key,
        row.checkout_path,
        context.checkoutLabel,
        0,
        JSON.stringify(input),
        1,
        JSON.stringify(output),
        row.revision || 1,
        row.created_at,
        now(),
        row.started_at,
        row.ended_at,
      );
      bind.run(id, row.id);
    }
  }

  private hasTable(name: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(name),
    );
  }

  private firstSession(): AppSession | null {
    const row = this.db
      .prepare(
        "SELECT * FROM app_sessions WHERE machine=? AND archived_at IS NULL ORDER BY position, updated_at DESC LIMIT 1",
      )
      .get(this.machine) as SessionRow | undefined;
    return row ? this.toSession(row) : null;
  }

  private insertDefaultTab(sessionId: string): SessionTab {
    const timestamp = now();
    const id = tabId();
    const position = this.db
      .prepare(
        "SELECT COALESCE(MAX(position),-1)+1 AS position FROM app_tabs WHERE session_id=?",
      )
      .get(sessionId) as { position: number };
    this.db
      .prepare(
        "INSERT INTO app_tabs(id,session_id,title,position,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      )
      .run(id, sessionId, "Window 1", position.position, timestamp, timestamp);
    return this.getTab(validSessionTabId(id)) as SessionTab;
  }

  private ensureActiveTab(sessionId: SessionId): SessionTab {
    const session = this.getSession(sessionId);
    if (!session)
      throw new ToolSessionStorageError({
        message: `session not found: ${sessionId}`,
      });
    const active = session.activeTabId
      ? this.getTab(session.activeTabId)
      : null;
    if (active && !active.archivedAt) return active;
    const existing = this.listTabs(sessionId).find((tab) => !tab.archivedAt);
    const tab = existing ?? this.insertDefaultTab(sessionId);
    this.db
      .prepare("UPDATE app_sessions SET active_tab_id=?,updated_at=? WHERE id=?")
      .run(tab.id, now(), sessionId);
    return tab;
  }

  private ensureVisibleSession(): void {
    if (this.firstSession()) return;
    const timestamp = now();
    const id = sessionId();
    this.db
      .prepare(
        "INSERT OR IGNORE INTO app_sessions(id,machine,title,position,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      )
      .run(id, this.machine, "Session 1", 0, timestamp, timestamp);
    const session = this.getSession(validSessionId(id));
    if (!session) return;
    const tab = this.insertDefaultTab(session.id);
    this.db
      .prepare("UPDATE app_sessions SET active_tab_id=?,updated_at=? WHERE id=?")
      .run(tab.id, timestamp, session.id);
  }

  private nextUsePosition(sessionIdValue: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(position),-1)+1 AS position FROM tool_uses WHERE session_id=?",
      )
      .get(sessionIdValue) as { position: number };
    return row.position;
  }

  private toSession(row: SessionRow): AppSession {
    return AppSession.make({
      id: validSessionId(row.id),
      title: row.title,
      position: row.position,
      ...(row.active_tab_id
        ? { activeTabId: validSessionTabId(row.active_tab_id) }
        : {}),
      ...(row.active_tool_use_id
        ? { activeToolUseId: validToolUseId(row.active_tool_use_id) }
        : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
    });
  }

  private toTab(row: SessionTabRow): SessionTab {
    return SessionTab.make({
      id: validSessionTabId(row.id),
      sessionId: validSessionId(row.session_id),
      title: row.title,
      position: row.position,
      ...(row.active_tool_use_id
        ? { activeToolUseId: validToolUseId(row.active_tool_use_id) }
        : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
    });
  }

  private toToolUse(row: ToolUseRow): ToolUse {
    const input = decodeJson(ToolUseInputSchema, row.input_json, "tool input");
    const output = decodeJson(
      ToolUseOutputSchema,
      row.output_json,
      "tool output",
    );
    return decodeToolUse(
      JSON.stringify({
        id: validToolUseId(row.id),
        sessionId: validSessionId(row.session_id),
        ...(row.tab_id ? { tabId: validSessionTabId(row.tab_id) } : {}),
        kind: row.kind,
        title: row.title,
        position: row.position,
        status: row.status,
        context: checkoutContext(row),
        input,
        inputRevision: row.input_revision,
        output,
        ...(row.error_json
          ? { error: decodeJson(Schema.String, row.error_json, "tool error") }
          : {}),
        revision: row.revision,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        ...(row.started_at ? { startedAt: row.started_at } : {}),
        ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
        ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
      }),
    );
  }

  listSessions(includeArchived = false): AppSession[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM app_sessions WHERE machine=? ${includeArchived ? "" : "AND archived_at IS NULL"} ORDER BY position, updated_at DESC`,
      )
      .all(this.machine) as SessionRow[];
    return rows.map((row) => this.toSession(row));
  }

  getSession(id: SessionId): AppSession | null {
    const row = this.db
      .prepare("SELECT * FROM app_sessions WHERE id=? AND machine=?")
      .get(id, this.machine) as SessionRow | undefined;
    return row ? this.toSession(row) : null;
  }

  listTabs(sessionId: SessionId, includeArchived = false): SessionTab[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM app_tabs WHERE session_id=? ${includeArchived ? "" : "AND archived_at IS NULL"} ORDER BY position, created_at`,
      )
      .all(sessionId) as SessionTabRow[];
    return rows.map((row) => this.toTab(row));
  }

  getTab(id: SessionTabId): SessionTab | null {
    const row = this.db
      .prepare("SELECT * FROM app_tabs WHERE id=?")
      .get(id) as SessionTabRow | undefined;
    return row ? this.toTab(row) : null;
  }

  createTab(sessionId: SessionId, title = "New tab"): SessionTab {
    if (!this.getSession(sessionId))
      throw new ToolSessionStorageError({
        message: `session not found: ${sessionId}`,
      });
    const timestamp = now();
    const id = tabId();
    const position = this.db
      .prepare(
        "SELECT COALESCE(MAX(position),-1)+1 AS position FROM app_tabs WHERE session_id=? AND archived_at IS NULL",
      )
      .get(sessionId) as { position: number };
    this.db
      .prepare(
        "INSERT INTO app_tabs(id,session_id,title,position,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      )
      .run(id, sessionId, title.trim() || "New tab", position.position, timestamp, timestamp);
    const tab = this.getTab(validSessionTabId(id));
    if (!tab)
      throw new ToolSessionStorageError({ message: `tab disappeared: ${id}` });
    const session = this.getSession(sessionId);
    if (session && !session.activeTabId) {
      this.db
        .prepare("UPDATE app_sessions SET active_tab_id=?,updated_at=? WHERE id=?")
        .run(tab.id, timestamp, sessionId);
    }
    return tab;
  }

  renameTab(id: SessionTabId, title: string): SessionTab {
    const current = this.getTab(id);
    if (!current)
      throw new ToolSessionStorageError({ message: `tab not found: ${id}` });
    this.db
      .prepare("UPDATE app_tabs SET title=?,updated_at=? WHERE id=?")
      .run(title.trim().slice(0, 160) || current.title, now(), id);
    return this.getTab(id) as SessionTab;
  }

  reorderTabs(sessionId: SessionId, ids: readonly SessionTabId[]): SessionTab[] {
    const update = this.db.prepare(
      "UPDATE app_tabs SET position=?,updated_at=? WHERE id=? AND session_id=?",
    );
    const timestamp = now();
    for (const [position, id] of ids.entries())
      update.run(position, timestamp, id, sessionId);
    return this.listTabs(sessionId);
  }

  archiveTab(id: SessionTabId): SessionTab {
    const current = this.getTab(id);
    if (!current)
      throw new ToolSessionStorageError({ message: `tab not found: ${id}` });
    const timestamp = now();
    this.db
      .prepare("UPDATE app_tabs SET archived_at=?,updated_at=? WHERE id=?")
      .run(timestamp, timestamp, id);
    const remaining = this.listTabs(current.sessionId);
    if (remaining.length === 0) this.createTab(current.sessionId, "Window 1");
    const session = this.getSession(current.sessionId);
    if (session?.activeTabId === id) {
      const next = this.listTabs(current.sessionId)[0];
      this.db
        .prepare("UPDATE app_sessions SET active_tab_id=?,active_tool_use_id=?,updated_at=? WHERE id=?")
        .run(next?.id ?? null, next?.activeToolUseId ?? null, timestamp, current.sessionId);
    }
    return this.getTab(id) as SessionTab;
  }

  setActiveTab(sessionId: SessionId, tabId: SessionTabId | null): AppSession {
    if (tabId) {
      const tab = this.getTab(tabId);
      if (!tab || tab.sessionId !== sessionId || tab.archivedAt)
        throw new ToolSessionStorageError({ message: "active tab does not belong to session" });
    }
    const activeToolUseId = tabId ? this.getTab(tabId)?.activeToolUseId ?? null : null;
    this.db
      .prepare("UPDATE app_sessions SET active_tab_id=?,active_tool_use_id=?,updated_at=? WHERE id=? AND machine=?")
      .run(tabId, activeToolUseId, now(), sessionId, this.machine);
    const result = this.getSession(sessionId);
    if (!result)
      throw new ToolSessionStorageError({ message: `session not found: ${sessionId}` });
    return result;
  }

  createSession(title = "New session"): AppSession {
    const timestamp = now();
    const id = sessionId();
    const position = this.db
      .prepare(
        "SELECT COALESCE(MAX(position),-1)+1 AS position FROM app_sessions WHERE machine=? AND archived_at IS NULL",
      )
      .get(this.machine) as { position: number };
    this.db
      .prepare(
        "INSERT INTO app_sessions(id,machine,title,position,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      )
      .run(id, this.machine, title, position.position, timestamp, timestamp);
    const session = this.getSession(validSessionId(id)) as AppSession;
    this.createTab(session.id, "Window 1");
    return this.getSession(session.id) as AppSession;
  }

  renameSession(id: SessionId, title: string): AppSession {
    this.db
      .prepare(
        "UPDATE app_sessions SET title=?,updated_at=? WHERE id=? AND machine=?",
      )
      .run(title, now(), id, this.machine);
    const result = this.getSession(id);
    if (!result)
      throw new ToolSessionStorageError({
        message: `session not found: ${id}`,
      });
    return result;
  }

  reorderSessions(ids: readonly SessionId[]): AppSession[] {
    const update = this.db.prepare(
      "UPDATE app_sessions SET position=?,updated_at=? WHERE id=? AND machine=?",
    );
    const timestamp = now();
    for (const [position, id] of ids.entries())
      update.run(position, timestamp, id, this.machine);
    return this.listSessions();
  }

  archiveSession(id: SessionId): AppSession {
    const timestamp = now();
    this.db
      .prepare(
        "UPDATE app_sessions SET archived_at=?,updated_at=? WHERE id=? AND machine=?",
      )
      .run(timestamp, timestamp, id, this.machine);
    this.ensureVisibleSession();
    const row = this.db
      .prepare("SELECT * FROM app_sessions WHERE id=? AND machine=?")
      .get(id, this.machine) as SessionRow | undefined;
    if (!row)
      throw new ToolSessionStorageError({
        message: `session not found: ${id}`,
      });
    return this.toSession(row);
  }

  restoreSession(id: SessionId): AppSession {
    this.db
      .prepare(
        "UPDATE app_sessions SET archived_at=NULL,updated_at=? WHERE id=? AND machine=?",
      )
      .run(now(), id, this.machine);
    const result = this.getSession(id);
    if (!result)
      throw new ToolSessionStorageError({
        message: `session not found: ${id}`,
      });
    return result;
  }

  setActiveToolUse(session: SessionId, use: ToolUseId | null): AppSession {
    if (use) {
      const row = this.db
        .prepare(
          "SELECT id,tab_id FROM tool_uses WHERE id=? AND session_id=? AND archived_at IS NULL",
        )
        .get(use, session) as { id: string; tab_id: string | null } | undefined;
      if (!row)
        throw new ToolSessionStorageError({
          message: "active tool use does not belong to session",
        });
      const tab = row.tab_id ? validSessionTabId(row.tab_id) : this.ensureActiveTab(session).id;
      this.setActiveTab(session, tab);
      this.db
        .prepare("UPDATE app_tabs SET active_tool_use_id=?,updated_at=? WHERE id=?")
        .run(use, now(), tab);
    }
    this.db
      .prepare(
        "UPDATE app_sessions SET active_tool_use_id=?,updated_at=? WHERE id=? AND machine=?",
      )
      .run(use, now(), session, this.machine);
    const result = this.getSession(session);
    if (!result)
      throw new ToolSessionStorageError({
        message: `session not found: ${session}`,
      });
    return result;
  }

  setActiveTabToolUse(tabId: SessionTabId, use: ToolUseId | null): SessionTab {
    const tab = this.getTab(tabId);
    if (!tab) throw new ToolSessionStorageError({ message: `tab not found: ${tabId}` });
    if (use) {
      const belongs = this.db
        .prepare("SELECT id FROM tool_uses WHERE id=? AND tab_id=? AND archived_at IS NULL")
        .get(use, tabId);
      if (!belongs)
        throw new ToolSessionStorageError({ message: "active tool use does not belong to tab" });
    }
    this.db
      .prepare("UPDATE app_tabs SET active_tool_use_id=?,updated_at=? WHERE id=?")
      .run(use, now(), tabId);
    return this.getTab(tabId) as SessionTab;
  }

  createToolUse(record: CreateToolUseRecord): ToolUse {
    if (!this.getSession(record.sessionId))
      throw new ToolSessionStorageError({
        message: `session not found: ${record.sessionId}`,
      });
    const tab = record.tabId ? this.getTab(record.tabId) : this.ensureActiveTab(record.sessionId);
    if (!tab || tab.sessionId !== record.sessionId || tab.archivedAt)
      throw new ToolSessionStorageError({ message: "tool use tab does not belong to session" });
    const id = toolUseId();
    const timestamp = now();
    const branch = record.context.branch ?? null;
    const output = record.output;
    const position = this.db
      .prepare("SELECT COALESCE(MAX(position),-1)+1 AS position FROM tool_uses WHERE tab_id=? AND archived_at IS NULL")
      .get(tab.id) as { position: number };
    this.db
      .prepare(
        `INSERT INTO tool_uses(id,session_id,tab_id,kind,title,position,status,project_id,project_path,project_name,
       checkout_key,checkout_path,checkout_label,branch,managed_worktree,input_json,input_revision,output_json,
       revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        ...([
          id,
          String(record.sessionId),
          String(tab.id),
          record.kind,
          record.title,
          position.position,
          "created",
          record.context.project.projectId,
          record.context.project.projectPath,
          record.context.project.projectName,
          record.context.checkoutKey,
          record.context.checkoutPath,
          record.context.checkoutLabel,
          branch,
          record.context.managedWorktree ? 1 : 0,
          encodeJson(ToolUseInputSchema, record.input),
          1,
          encodeJson(ToolUseOutputSchema, output),
          1,
          timestamp,
          timestamp,
        ] satisfies SQLInputValue[]),
      );
    return this.getToolUse(validToolUseId(id)) as ToolUse;
  }

  reorderToolUses(session: SessionId, ids: readonly ToolUseId[], tabId?: SessionTabId): ToolUse[] {
    const tab = tabId ?? this.ensureActiveTab(session).id;
    const update = this.db.prepare(
      "UPDATE tool_uses SET position=?,updated_at=? WHERE id=? AND session_id=? AND tab_id=?",
    );
    const timestamp = now();
    for (const [position, id] of ids.entries())
      update.run(position, timestamp, id, session, tab);
    return this.listToolUsesByTab(tab);
  }

  archiveToolUse(id: ToolUseId): ToolUse {
    const timestamp = now();
    this.db
      .prepare(
        "UPDATE tool_uses SET archived_at=?,updated_at=?,revision=revision+1 WHERE id=? AND archived_at IS NULL",
      )
      .run(timestamp, timestamp, id);
    const result = this.getToolUse(id);
    if (!result)
      throw new ToolSessionStorageError({
        message: `tool use not found: ${id}`,
      });
    return result;
  }

  renameToolUse(id: ToolUseId, title: string): ToolUse {
    const current = this.getToolUse(id);
    if (!current)
      throw new ToolSessionStorageError({
        message: `tool use not found: ${id}`,
      });
    return this.compareAndSetToolUse(id, current.revision, {
      title: title.trim().slice(0, 160) || current.title,
    });
  }

  getToolUse(id: ToolUseId): ToolUse | null {
    const row = this.db
      .prepare("SELECT * FROM tool_uses WHERE id=?")
      .get(id) as ToolUseRow | undefined;
    return row ? this.toToolUse(row) : null;
  }

  listLiveToolUsesByCheckout(checkoutPath: string): ToolUse[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tool_uses
       WHERE checkout_path=? AND archived_at IS NULL
         AND status IN ('created','starting','running','waiting')
       ORDER BY position,created_at`,
      )
      .all(checkoutPath) as ToolUseRow[];
    return rows.map((row) => this.toToolUse(row));
  }

  listToolUses(session: SessionId, includeArchived = false): ToolUse[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tool_uses WHERE session_id=? ${includeArchived ? "" : "AND archived_at IS NULL"} ORDER BY position,created_at`,
      )
      .all(session) as ToolUseRow[];
    return rows.map((row) => this.toToolUse(row));
  }

  listToolUsesByTab(tabId: SessionTabId, includeArchived = false): ToolUse[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tool_uses WHERE tab_id=? ${includeArchived ? "" : "AND archived_at IS NULL"} ORDER BY position,created_at`,
      )
      .all(tabId) as ToolUseRow[];
    return rows.map((row) => this.toToolUse(row));
  }

  updateToolUseContext(
    id: ToolUseId,
    expectedRevision: number,
    context: ResolvedToolContext,
  ): ToolUse {
    const current = this.getToolUse(id);
    if (!current)
      throw new ToolSessionStorageError({
        message: `tool use not found: ${id}`,
      });
    if (current.revision !== expectedRevision) {
      throw new ToolUseConflict({
        toolUseId: id,
        expectedRevision,
        actualRevision: current.revision,
        message: `tool use revision conflict: ${id}`,
      });
    }
    const timestamp = now();
    const result = this.db
      .prepare(
        `UPDATE tool_uses SET project_id=?,project_path=?,project_name=?,checkout_key=?,checkout_path=?,checkout_label=?,
       branch=?,managed_worktree=?,updated_at=?,revision=revision+1 WHERE id=? AND revision=?`,
      )
      .run(
        context.project.projectId,
        context.project.projectPath,
        context.project.projectName,
        context.checkoutKey,
        context.checkoutPath,
        context.checkoutLabel,
        context.branch ?? null,
        context.managedWorktree ? 1 : 0,
        timestamp,
        id,
        expectedRevision,
      );
    if (result.changes !== 1)
      throw new ToolSessionStorageError({
        message: `tool use context update failed: ${id}`,
      });
    const updated = this.getToolUse(id);
    if (!updated)
      throw new ToolSessionStorageError({
        message: `tool use disappeared: ${id}`,
      });
    return updated;
  }

  updateSearchInput(
    id: ToolUseId,
    expectedInputRevision: number,
    input: Extract<ToolUseInput, { readonly kind: "search" }>,
  ): ToolUse {
    const current = this.getToolUse(id);
    if (!current || current.input.kind !== "search")
      throw new ToolSessionStorageError({
        message: `search tool use not found: ${id}`,
      });
    if (current.inputRevision !== expectedInputRevision) {
      throw new ToolUseConflict({
        toolUseId: id,
        expectedRevision: expectedInputRevision,
        actualRevision: current.inputRevision,
        message: `tool input revision conflict: ${id}`,
      });
    }
    return this.compareAndSetToolUse(id, current.revision, { input });
  }

  compareAndSetToolUse(
    id: ToolUseId,
    expectedRevision: number,
    patch: {
      status?: ToolUseStatus;
      input?: ToolUseInput;
      output?: ToolUseOutput;
      error?: string | null;
      title?: string;
    },
  ): ToolUse {
    const current = this.db
      .prepare("SELECT revision FROM tool_uses WHERE id=?")
      .get(id) as { revision: number } | undefined;
    if (!current)
      throw new ToolSessionStorageError({
        message: `tool use not found: ${id}`,
      });
    if (current.revision !== expectedRevision) {
      throw new ToolUseConflict({
        toolUseId: id,
        expectedRevision,
        actualRevision: current.revision,
        message: `tool use revision conflict: ${id}`,
      });
    }
    const timestamp = now();
    const fields: string[] = ["updated_at=?", "revision=revision+1"];
    const values: SQLInputValue[] = [timestamp];
    if (patch.status) {
      fields.push("status=?");
      values.push(patch.status);
      if (
        patch.status === "starting" ||
        patch.status === "running" ||
        patch.status === "waiting"
      ) {
        fields.push("started_at=COALESCE(started_at, ?)");
        values.push(timestamp);
      }
      if (
        patch.status === "succeeded" ||
        patch.status === "failed" ||
        patch.status === "cancelled" ||
        patch.status === "disconnected"
      ) {
        fields.push("finished_at=COALESCE(finished_at, ?)");
        values.push(timestamp);
      }
    }
    if (patch.input) {
      fields.push("input_json=?", "input_revision=input_revision+1");
      values.push(JSON.stringify(patch.input));
    }
    if (patch.output) {
      fields.push("output_json=?");
      values.push(JSON.stringify(patch.output));
    }
    if (patch.error !== undefined) {
      fields.push("error_json=?");
      values.push(patch.error == null ? null : JSON.stringify(patch.error));
    }
    if (patch.title !== undefined) {
      fields.push("title=?");
      values.push(patch.title);
    }
    values.push(id, expectedRevision);
    this.db
      .prepare(
        `UPDATE tool_uses SET ${fields.join(",")} WHERE id=? AND revision=?`,
      )
      .run(...values);
    const result = this.getToolUse(id);
    if (!result)
      throw new ToolSessionStorageError({
        message: `tool use disappeared: ${id}`,
      });
    return result;
  }

  replaceSearchResults(
    id: ToolUseId,
    resultRevision: number,
    results: readonly ProjectSearchResult[],
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "DELETE FROM tool_use_search_results WHERE tool_use_id=? AND result_revision=?",
        )
        .run(id, resultRevision);
      const insert = this.db.prepare(
        "INSERT INTO tool_use_search_results(tool_use_id,result_revision,ordinal,result_json) VALUES(?,?,?,?)",
      );
      for (const [ordinal, result] of results.entries())
        insert.run(id, resultRevision, ordinal, JSON.stringify(result));
      this.db.exec("COMMIT");
    } catch (cause) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* preserve original */
      }
      throw new ToolSessionStorageError({
        message: "could not replace search results",
        cause,
      });
    }
  }

  appendSearchResults(
    id: ToolUseId,
    resultRevision: number,
    results: readonly ProjectSearchResult[],
  ): void {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(ordinal),-1)+1 AS ordinal FROM tool_use_search_results WHERE tool_use_id=? AND result_revision=?",
      )
      .get(id, resultRevision) as { ordinal: number };
    const insert = this.db.prepare(
      "INSERT INTO tool_use_search_results(tool_use_id,result_revision,ordinal,result_json) VALUES(?,?,?,?)",
    );
    for (const [offset, result] of results.entries())
      insert.run(
        id,
        resultRevision,
        row.ordinal + offset,
        JSON.stringify(result),
      );
  }

  listSearchResults(
    id: ToolUseId,
    resultRevision: number,
    cursor = 0,
    limit = 100,
  ): ProjectSearchResult[] {
    const rows = this.db
      .prepare(
        "SELECT result_json FROM tool_use_search_results WHERE tool_use_id=? AND result_revision=? AND ordinal>=? ORDER BY ordinal LIMIT ?",
      )
      .all(id, resultRevision, cursor, limit) as SearchResultRow[];
    return rows.map((row) =>
      decodeJson(
        Schema.Struct({
          path: Schema.String,
          line: Schema.Number,
          column: Schema.Number,
          preview: Schema.String,
          ranges: Schema.Array(
            Schema.Struct({
              startLine: Schema.Number,
              startColumn: Schema.Number,
              endLine: Schema.Number,
              endColumn: Schema.Number,
            }),
          ),
        }),
        row.result_json,
        "search result",
      ),
    );
  }
}
