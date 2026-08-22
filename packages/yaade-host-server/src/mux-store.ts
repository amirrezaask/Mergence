import { randomUUID } from "node:crypto";
import { Data, Schema } from "effect";
import {
  AppSession,
  SessionTab,
  SessionTabConflict,
  SessionTabId,
  TerminalOutput,
  SessionId,
  TerminalInput,
  MuxTerminal,
  TerminalConflict,
  MuxTerminalId,
  type TerminalStatus,
  TerminalKind,
} from "@yaade/rpc";
import type { SQLInputValue } from "node:sqlite";
import type { DatabaseSession } from "./database.js";

export class MuxSessionStorageError extends Data.TaggedError(
  "MuxSessionStorageError",
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
  active_terminal_id: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

type SessionTabRow = {
  id: string;
  session_id: string;
  title: string;
  position: number;
  active_terminal_id: string | null;
  layout_json: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

type MuxTerminalRow = {
  id: string;
  session_id: string;
  tab_id: string | null;
  kind: string;
  title: string;
  position: number;
  status: string;
  null: string | null;
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

const now = (): string => new Date().toISOString();
const sessionId = (): string => `ses-${randomUUID()}`;
const tabId = (): string => `tab-${randomUUID()}`;
const muxTerminalId = (): string => `term-${randomUUID()}`;
const TerminalInputSchema = TerminalInput;
const TerminalOutputSchema = TerminalOutput;

function assertPermutation(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  const expectedSet = new Set(expected);
  if (
    actual.length !== expected.length ||
    new Set(actual).size !== actual.length ||
    actual.some(id => !expectedSet.has(id))
  ) {
    throw new MuxSessionStorageError({
      message: `invalid ${label} order`,
    });
  }
}

function decodeJson<A>(
  schema: Schema.Schema<A>,
  value: string,
  label: string,
): A {
  try {
    return Schema.decodeUnknownSync(schema)(JSON.parse(value) as unknown);
  } catch (cause) {
    throw new MuxSessionStorageError({
      message: `invalid persisted ${label}`,
      cause,
    });
  }
}

function decodeMuxTerminal(value: string): MuxTerminal {
  try {
    return Schema.decodeUnknownSync(MuxTerminal)(JSON.parse(value) as unknown);
  } catch (cause) {
    throw new MuxSessionStorageError({
      message: "invalid persisted terminal",
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
function validMuxTerminalId(value: string): MuxTerminalId {
  return Schema.decodeUnknownSync(MuxTerminalId)(value);
}
function validSessionTabId(value: string): SessionTabId {
  return Schema.decodeUnknownSync(SessionTabId)(value);
}


export type CreateTerminalRecord = {
  sessionId: SessionId;
  tabId?: SessionTabId;
  kind: TerminalKind;
  title: string;
  position: number;
  input: TerminalInput;
  output: TerminalOutput;
};

/**
 * Transactional owner for the v1 Session/MuxTerminal tables.
 * The class accepts the domain DatabaseSession rather than the database owner;
 * tests can still provide a fresh native SQLite connection through that port.
 */
export class MuxSessionStore {
  constructor(
    private readonly db: DatabaseSession,
    private readonly machine = "default",
  ) {
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY)")
    const current = this.db.prepare("SELECT version FROM schema_migrations WHERE version=20").get()
    if (!current) {
      this.db.exec("DROP TABLE IF EXISTS mux_terminals; DROP TABLE IF EXISTS app_tabs; DROP TABLE IF EXISTS app_sessions;")
      this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES(20)").run()
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_sessions(
        id TEXT PRIMARY KEY,
        machine TEXT NOT NULL,
        title TEXT NOT NULL,
        position INTEGER NOT NULL,
        active_tab_id TEXT,
        active_terminal_id TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );
      CREATE TABLE IF NOT EXISTS app_tabs(
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES app_sessions(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        position INTEGER NOT NULL,
        active_terminal_id TEXT,
        layout_json TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );
      CREATE TABLE IF NOT EXISTS mux_terminals(
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES app_sessions(id) ON DELETE CASCADE,
        tab_id TEXT REFERENCES app_tabs(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        position INTEGER NOT NULL,
        status TEXT NOT NULL,
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
      CREATE INDEX IF NOT EXISTS app_sessions_visible
        ON app_sessions(machine, archived_at, position);
      CREATE INDEX IF NOT EXISTS app_tabs_visible
        ON app_tabs(session_id, archived_at, position);
      CREATE INDEX IF NOT EXISTS mux_terminals_session_visible
        ON mux_terminals(session_id, archived_at, position);
      CREATE INDEX IF NOT EXISTS mux_terminals_status
        ON mux_terminals(status, archived_at);
    `);
    this.ensureVisibleSession();
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
      throw new MuxSessionStorageError({
        message: `session not found: ${sessionId}`,
      });
    const active = session.activeTabId
      ? this.getTab(session.activeTabId)
      : null;
    if (active && !active.archivedAt) return active;
    const existing = this.listTabs(sessionId).find((tab) => !tab.archivedAt);
    const tab = existing ?? this.insertDefaultTab(sessionId);
    this.db
      .prepare("UPDATE app_sessions SET active_tab_id=?,updated_at=?,revision=revision+1 WHERE id=?")
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
      .prepare("UPDATE app_sessions SET active_tab_id=?,updated_at=?,revision=revision+1 WHERE id=?")
      .run(tab.id, timestamp, session.id);
  }

  reset(): void {
    this.db.exec(`
      DELETE FROM mux_terminals;
      DELETE FROM app_tabs;
      DELETE FROM app_sessions;
    `);
    this.ensureVisibleSession();
  }

  private nextTerminalPosition(sessionIdValue: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(position),-1)+1 AS position FROM mux_terminals WHERE session_id=?",
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
      ...(row.active_terminal_id
        ? { activeMuxTerminalId: validMuxTerminalId(row.active_terminal_id) }
        : {}),
      revision: row.revision,
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
      ...(row.active_terminal_id
        ? { activeMuxTerminalId: validMuxTerminalId(row.active_terminal_id) }
        : {}),
      ...(row.layout_json ? { layoutJson: row.layout_json } : {}),
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
    });
  }

  private toMuxTerminal(row: MuxTerminalRow): MuxTerminal {
    const input = decodeJson(TerminalInputSchema, row.input_json, "terminal input");
    const output = decodeJson(
      TerminalOutputSchema,
      row.output_json,
      "terminal output",
    );
    return decodeMuxTerminal(
      JSON.stringify({
        id: validMuxTerminalId(row.id),
        sessionId: validSessionId(row.session_id),
        ...(row.tab_id ? { tabId: validSessionTabId(row.tab_id) } : {}),
        kind: row.kind,
        title: row.title,
        position: row.position,
        status: row.status,
        input,
        inputRevision: row.input_revision,
        output,
        ...(row.error_json
          ? { error: decodeJson(Schema.String, row.error_json, "terminal error") }
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
      throw new MuxSessionStorageError({
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
      throw new MuxSessionStorageError({ message: `tab disappeared: ${id}` });
    const session = this.getSession(sessionId);
    if (session && !session.activeTabId) {
      this.db
        .prepare("UPDATE app_sessions SET active_tab_id=?,updated_at=?,revision=revision+1 WHERE id=?")
        .run(tab.id, timestamp, sessionId);
    }
    return tab;
  }

  renameTab(id: SessionTabId, title: string): SessionTab {
    const current = this.getTab(id);
    if (!current)
      throw new MuxSessionStorageError({ message: `tab not found: ${id}` });
    this.db
      .prepare("UPDATE app_tabs SET title=?,updated_at=?,revision=revision+1 WHERE id=?")
      .run(title.trim().slice(0, 160) || current.title, now(), id);
    return this.getTab(id) as SessionTab;
  }

  saveTabLayout(
    id: SessionTabId,
    layoutJson: string,
    expectedRevision?: number,
  ): SessionTab {
    const current = this.getTab(id);
    if (!current)
      throw new MuxSessionStorageError({ message: `tab not found: ${id}` });
    if (current.archivedAt)
      throw new MuxSessionStorageError({ message: `tab is archived: ${id}` });
    if (
      expectedRevision !== undefined &&
      current.revision !== expectedRevision
    ) {
      throw new SessionTabConflict({
        tabId: id,
        expectedRevision,
        actualRevision: current.revision ?? 1,
        message: `tab revision conflict: ${id}`,
      });
    }
    const result = this.db
      .prepare(
        `UPDATE app_tabs SET layout_json=?,updated_at=?,revision=revision+1
         WHERE id=?${expectedRevision === undefined ? "" : " AND revision=?"}`,
      )
      .run(
        ...(expectedRevision === undefined
          ? [layoutJson, now(), id]
          : [layoutJson, now(), id, expectedRevision]),
      );
    if (Number(result.changes) !== 1) {
      const latest = this.getTab(id);
      throw new SessionTabConflict({
        tabId: id,
        expectedRevision: expectedRevision ?? current.revision ?? 1,
        actualRevision: latest?.revision ?? current.revision ?? 1,
        message: `tab revision conflict: ${id}`,
      });
    }
    return this.getTab(id) as SessionTab;
  }

  reorderTabs(sessionId: SessionId, ids: readonly SessionTabId[]): SessionTab[] {
    const session = this.getSession(sessionId);
    if (!session || session.archivedAt)
      throw new MuxSessionStorageError({ message: `session not found: ${sessionId}` });
    const current = this.listTabs(sessionId);
    assertPermutation(ids, current.map(tab => tab.id), `tabs for ${sessionId}`);
    const update = this.db.prepare(
      "UPDATE app_tabs SET position=?,updated_at=?,revision=revision+1 WHERE id=? AND session_id=?",
    );
    const timestamp = now();
    for (const [position, id] of ids.entries())
      update.run(position, timestamp, id, sessionId);
    return this.listTabs(sessionId);
  }

  archiveTab(id: SessionTabId): SessionTab {
    const current = this.getTab(id);
    if (!current)
      throw new MuxSessionStorageError({ message: `tab not found: ${id}` });
    if (current.archivedAt) return current;
    const timestamp = now();
    this.db
      .prepare("UPDATE app_tabs SET archived_at=?,updated_at=?,revision=revision+1 WHERE id=?")
      .run(timestamp, timestamp, id);
    const remaining = this.listTabs(current.sessionId);
    if (remaining.length === 0) this.createTab(current.sessionId, "Window 1");
    const session = this.getSession(current.sessionId);
    if (session?.activeTabId === id) {
      const next = this.listTabs(current.sessionId)[0];
      this.db
        .prepare("UPDATE app_sessions SET active_tab_id=?,active_terminal_id=?,updated_at=?,revision=revision+1 WHERE id=?")
        .run(next?.id ?? null, next?.activeMuxTerminalId ?? null, timestamp, current.sessionId);
    }
    return this.getTab(id) as SessionTab;
  }

  setActiveTab(sessionId: SessionId, tabId: SessionTabId | null): AppSession {
    if (tabId) {
      const tab = this.getTab(tabId);
      if (!tab || tab.sessionId !== sessionId || tab.archivedAt)
        throw new MuxSessionStorageError({ message: "active tab does not belong to session" });
    }
    const activeMuxTerminalId = tabId ? this.getTab(tabId)?.activeMuxTerminalId ?? null : null;
    this.db
      .prepare("UPDATE app_sessions SET active_tab_id=?,active_terminal_id=?,updated_at=?,revision=revision+1 WHERE id=? AND machine=?")
      .run(tabId, activeMuxTerminalId, now(), sessionId, this.machine);
    const result = this.getSession(sessionId);
    if (!result)
      throw new MuxSessionStorageError({ message: `session not found: ${sessionId}` });
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
        "UPDATE app_sessions SET title=?,updated_at=?,revision=revision+1 WHERE id=? AND machine=?",
      )
      .run(title, now(), id, this.machine);
    const result = this.getSession(id);
    if (!result)
      throw new MuxSessionStorageError({
        message: `session not found: ${id}`,
      });
    return result;
  }

  reorderSessions(ids: readonly SessionId[]): AppSession[] {
    const current = this.listSessions();
    assertPermutation(ids, current.map(session => session.id), "sessions");
    const update = this.db.prepare(
      "UPDATE app_sessions SET position=?,updated_at=?,revision=revision+1 WHERE id=? AND machine=?",
    );
    const timestamp = now();
    for (const [position, id] of ids.entries())
      update.run(position, timestamp, id, this.machine);
    return this.listSessions();
  }

  archiveSession(id: SessionId): AppSession {
    const current = this.getSession(id);
    if (!current)
      throw new MuxSessionStorageError({ message: `session not found: ${id}` });
    if (current.archivedAt) return current;
    const timestamp = now();
    this.db
      .prepare(
        "UPDATE app_sessions SET archived_at=?,updated_at=?,revision=revision+1 WHERE id=? AND machine=?",
      )
      .run(timestamp, timestamp, id, this.machine);
    this.ensureVisibleSession();
    const row = this.db
      .prepare("SELECT * FROM app_sessions WHERE id=? AND machine=?")
      .get(id, this.machine) as SessionRow | undefined;
    if (!row)
      throw new MuxSessionStorageError({
        message: `session not found: ${id}`,
      });
    return this.toSession(row);
  }

  restoreSession(id: SessionId): AppSession {
    this.db
      .prepare(
        "UPDATE app_sessions SET archived_at=NULL,updated_at=?,revision=revision+1 WHERE id=? AND machine=?",
      )
      .run(now(), id, this.machine);
    const result = this.getSession(id);
    if (!result)
      throw new MuxSessionStorageError({
        message: `session not found: ${id}`,
      });
    return result;
  }

  setActiveMuxTerminal(session: SessionId, terminal: MuxTerminalId | null): AppSession {
    const currentSession = this.getSession(session);
    if (!currentSession)
      throw new MuxSessionStorageError({
        message: `session not found: ${session}`,
      });

    let activeTabId = currentSession.activeTabId ?? null;
    if (terminal) {
      const row = this.db
        .prepare(
          "SELECT id,tab_id FROM mux_terminals WHERE id=? AND session_id=? AND archived_at IS NULL",
        )
        .get(terminal, session) as { id: string; tab_id: string | null } | undefined;
      if (!row)
        throw new MuxSessionStorageError({
          message: "active terminal does not belong to session",
        });
      activeTabId = row.tab_id
        ? validSessionTabId(row.tab_id)
        : this.ensureActiveTab(session).id;
    }

    const timestamp = now();
    if (activeTabId) {
      this.db
        .prepare(
          "UPDATE app_tabs SET active_terminal_id=?,updated_at=?,revision=revision+1 WHERE id=? AND archived_at IS NULL",
        )
        .run(terminal, timestamp, activeTabId);
    }
    this.db
      .prepare(
        "UPDATE app_sessions SET active_tab_id=?,active_terminal_id=?,updated_at=?,revision=revision+1 WHERE id=? AND machine=?",
      )
      .run(activeTabId, terminal, timestamp, session, this.machine);
    const result = this.getSession(session);
    if (!result)
      throw new MuxSessionStorageError({
        message: `session not found: ${session}`,
      });
    return result;
  }

  setActiveTabMuxTerminal(tabId: SessionTabId, terminal: MuxTerminalId | null): SessionTab {
    const tab = this.getTab(tabId);
    if (!tab) throw new MuxSessionStorageError({ message: `tab not found: ${tabId}` });
    if (terminal) {
      const belongs = this.db
        .prepare("SELECT id FROM mux_terminals WHERE id=? AND tab_id=? AND archived_at IS NULL")
        .get(terminal, tabId);
      if (!belongs)
        throw new MuxSessionStorageError({ message: "active terminal does not belong to tab" });
    }
    this.db
      .prepare("UPDATE app_tabs SET active_terminal_id=?,updated_at=?,revision=revision+1 WHERE id=?")
      .run(terminal, now(), tabId);
    return this.getTab(tabId) as SessionTab;
  }

  createMuxTerminal(record: CreateTerminalRecord): MuxTerminal {
    if (!this.getSession(record.sessionId))
      throw new MuxSessionStorageError({
        message: `session not found: ${record.sessionId}`,
      });
    const tab = record.tabId ? this.getTab(record.tabId) : this.ensureActiveTab(record.sessionId);
    if (!tab || tab.sessionId !== record.sessionId || tab.archivedAt)
      throw new MuxSessionStorageError({ message: "terminal tab does not belong to session" });
    const id = muxTerminalId();
    const timestamp = now();
    const output = record.output;
    const position = this.db
      .prepare("SELECT COALESCE(MAX(position),-1)+1 AS position FROM mux_terminals WHERE tab_id=? AND archived_at IS NULL")
      .get(tab.id) as { position: number };
    this.db
      .prepare(
        `INSERT INTO mux_terminals(id,session_id,tab_id,kind,title,position,status,input_json,input_revision,output_json,
       revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
          encodeJson(TerminalInputSchema, record.input),
          1,
          encodeJson(TerminalOutputSchema, output),
          1,
          timestamp,
          timestamp,
        ] satisfies SQLInputValue[]),
      );
    return this.getMuxTerminal(validMuxTerminalId(id)) as MuxTerminal;
  }

  reorderMuxTerminals(session: SessionId, ids: readonly MuxTerminalId[], tabId?: SessionTabId): MuxTerminal[] {
    const sessionRow = this.getSession(session);
    if (!sessionRow || sessionRow.archivedAt)
      throw new MuxSessionStorageError({ message: `session not found: ${session}` });
    const tab = tabId ? this.getTab(tabId) : this.ensureActiveTab(session);
    if (!tab || tab.sessionId !== session || tab.archivedAt)
      throw new MuxSessionStorageError({
        message: `tab does not belong to session: ${tabId ?? "active"}`,
      });
    const current = this.listMuxTerminalsByTab(tab.id);
    assertPermutation(ids, current.map(terminal => terminal.id), `terminals for ${tab.id}`);
    const update = this.db.prepare(
      "UPDATE mux_terminals SET position=?,updated_at=?,revision=revision+1 WHERE id=? AND session_id=? AND tab_id=?",
    );
    const timestamp = now();
    for (const [position, id] of ids.entries())
      update.run(position, timestamp, id, session, tab.id);
    return this.listMuxTerminalsByTab(tab.id);
  }

  archiveMuxTerminal(id: MuxTerminalId): MuxTerminal {
    const current = this.getMuxTerminal(id);
    if (!current)
      throw new MuxSessionStorageError({
        message: `terminal not found: ${id}`,
      });
    if (current.archivedAt) return current;

    const session = this.getSession(current.sessionId);
    const tab = current.tabId ? this.getTab(current.tabId) : null;
    const tabWasFocused = tab?.activeMuxTerminalId === id;
    const sessionWasFocused = session?.activeMuxTerminalId === id;
    const timestamp = now();
    this.db
      .prepare(
        "UPDATE mux_terminals SET archived_at=?,updated_at=?,revision=revision+1 WHERE id=? AND archived_at IS NULL",
      )
      .run(timestamp, timestamp, id);

    // Keep focus durable and valid after a close. The browser still applies its
    // normal first-visible fallback, but snapshots and reconnects should agree
    // on the same next terminal instead of pointing at an archived id or at null.
    const nextTerminals = tab
      ? this.listMuxTerminalsByTab(tab.id)
      : this.listMuxTerminals(current.sessionId);
    const nextId = nextTerminals[0]?.id ?? null;
    this.db
      .prepare(
        "UPDATE app_tabs SET active_terminal_id=NULL,updated_at=?,revision=revision+1 WHERE active_terminal_id=?",
      )
      .run(timestamp, id);
    if (tabWasFocused && tab && !tab.archivedAt) {
      this.db
        .prepare(
          "UPDATE app_tabs SET active_terminal_id=?,updated_at=?,revision=revision+1 WHERE id=? AND archived_at IS NULL",
        )
        .run(nextId, timestamp, tab.id);
    }
    if (sessionWasFocused) {
      this.db
        .prepare(
          "UPDATE app_sessions SET active_terminal_id=?,updated_at=?,revision=revision+1 WHERE id=? AND machine=?",
        )
        .run(nextId, timestamp, current.sessionId, this.machine);
    }
    const result = this.getMuxTerminal(id);
    if (!result)
      throw new MuxSessionStorageError({
        message: `terminal not found: ${id}`,
      });
    return result;
  }

  renameMuxTerminal(id: MuxTerminalId, title: string): MuxTerminal {
    const current = this.getMuxTerminal(id);
    if (!current)
      throw new MuxSessionStorageError({
        message: `terminal not found: ${id}`,
      });
    return this.compareAndSetMuxTerminal(id, current.revision, {
      title: title.trim().slice(0, 160) || current.title,
    });
  }

  getMuxTerminal(id: MuxTerminalId): MuxTerminal | null {
    const row = this.db
      .prepare("SELECT * FROM mux_terminals WHERE id=?")
      .get(id) as MuxTerminalRow | undefined;
    return row ? this.toMuxTerminal(row) : null;
  }

  listMuxTerminals(session: SessionId, includeArchived = false): MuxTerminal[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM mux_terminals WHERE session_id=? ${includeArchived ? "" : "AND archived_at IS NULL"} ORDER BY position,created_at`,
      )
      .all(session) as MuxTerminalRow[];
    return rows.map((row) => this.toMuxTerminal(row));
  }

  listMuxTerminalsByTab(tabId: SessionTabId, includeArchived = false): MuxTerminal[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM mux_terminals WHERE tab_id=? ${includeArchived ? "" : "AND archived_at IS NULL"} ORDER BY position,created_at`,
      )
      .all(tabId) as MuxTerminalRow[];
    return rows.map((row) => this.toMuxTerminal(row));
  }


  compareAndSetMuxTerminal(
    id: MuxTerminalId,
    expectedRevision: number,
    patch: {
      status?: TerminalStatus;
      input?: TerminalInput;
      output?: TerminalOutput;
      error?: string | null;
      title?: string;
    },
  ): MuxTerminal {
    const current = this.db
      .prepare("SELECT revision FROM mux_terminals WHERE id=?")
      .get(id) as { revision: number } | undefined;
    if (!current)
      throw new MuxSessionStorageError({
        message: `terminal not found: ${id}`,
      });
    if (current.revision !== expectedRevision) {
      throw new TerminalConflict({
        muxTerminalId: id,
        expectedRevision,
        actualRevision: current.revision,
        message: `terminal revision conflict: ${id}`,
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
        `UPDATE mux_terminals SET ${fields.join(",")} WHERE id=? AND revision=?`,
      )
      .run(...values);
    const result = this.getMuxTerminal(id);
    if (!result)
      throw new MuxSessionStorageError({
        message: `terminal disappeared: ${id}`,
      });
    return result;
  }

}
