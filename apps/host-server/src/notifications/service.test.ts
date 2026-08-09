import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, it, beforeEach, afterEach } from "node:test"
import { NotificationService } from "./service.js"
import {
  parseOscNotifications,
  parseOscStreamChunk,
  normalizeHookEventName,
} from "./osc.js"
import { normalizeProviderHookRequest } from "./provider-hooks.js"
import {
  evaluateDesktopDelivery,
  shouldCreateInAppNotification,
  mergeNotificationPreferences,
} from "./policy.js"
import { contentHashFor } from "./schema.js"

function tempDb(): { db: DatabaseSync; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-notif-"))
  const db = new DatabaseSync(path.join(dir, "t.sqlite3"))
  return { db, dir }
}

describe("NotificationService", () => {
  let db: DatabaseSync
  let dir: string
  let service: NotificationService
  const events: unknown[] = []

  beforeEach(() => {
    events.length = 0
    ;({ db, dir } = tempDb())
    service = new NotificationService(db, e => events.push(e))
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("creates turn-completed and counts unread", () => {
    service.bindSession({
      sessionId: "sess-1",
      projectId: "proj-1",
      projectName: "jet",
      sessionTitle: "Refactor auth",
      provider: "claude",
      ptyId: "term-1",
    })
    const result = service.ingest({
      source: "provider-hook",
      type: "turn-completed",
      title: "Claude completed the turn",
      sessionId: "sess-1",
      eventId: "turn-42",
    })
    assert.equal(result.created, true)
    assert.equal(result.notification?.status, "unread")
    assert.equal(result.notification?.projectName, "jet")
    assert.equal(service.counts().totalUnread, 1)
  })

  it("dedupes hook + osc for same turn", () => {
    service.bindSession({
      sessionId: "sess-1",
      projectId: "p",
      projectName: "p",
      sessionTitle: "s",
      provider: "codex",
      ptyId: "t1",
    })
    const a = service.ingest({
      source: "osc",
      type: "turn-completed",
      title: "Turn complete",
      sessionId: "sess-1",
      providerTurnId: "turn-9",
      eventId: "ev-9",
    })
    const b = service.ingest({
      source: "provider-hook",
      type: "turn-completed",
      title: "Codex completed the turn",
      sessionId: "sess-1",
      providerTurnId: "turn-9",
      eventId: "ev-9",
    })
    assert.equal(a.created, true)
    assert.equal(b.deduped, true)
    assert.equal(b.notification?.source, "provider-hook")
    assert.equal(service.list().items.length, 1)
  })

  it("dedupes provider events before an app session binding is known", () => {
    const first = service.ingest({
      source: "osc",
      type: "turn-completed",
      title: "Done",
      provider: "codex",
      providerSessionId: "provider-session",
      providerTurnId: "provider-turn",
      eventId: "provider-event",
    })
    const second = service.ingest({
      source: "provider-hook",
      type: "turn-completed",
      title: "Codex completed the turn",
      provider: "codex",
      providerSessionId: "provider-session",
      providerTurnId: "provider-turn",
      eventId: "provider-event",
    })
    assert.equal(first.created, true)
    assert.equal(second.deduped, true)
    assert.equal(second.updated, true)
    assert.equal(service.list().items.length, 1)
  })

  for (const order of ["interactive-first", "telemetry-first"] as const) {
    it(`correlates interactive and telemetry notifications by native turn (${order})`, () => {
      const interactive = {
        source: "interactive-runtime" as const,
        type: "turn-completed" as const,
        title: "Agent finished",
        sessionId: "project-session",
        provider: "codex" as const,
        providerSessionId: "native-session-1",
        providerTurnId: "native-turn-1",
        eventId: "runtime-event-1",
      }
      const telemetry = {
        source: "provider-hook" as const,
        type: "turn-completed" as const,
        title: "Codex completed the turn",
        sessionId: "telemetry-session",
        provider: "codex" as const,
        providerSessionId: "native-session-1",
        providerTurnId: "native-turn-1",
        eventId: "hook-event-1",
      }
      const [first, second] = order === "interactive-first"
        ? [service.ingest(interactive), service.ingest(telemetry)]
        : [service.ingest(telemetry), service.ingest(interactive)]
      assert.equal(first.created, true)
      assert.equal(second.deduped, true)
      assert.equal(service.list().items.length, 1)
      assert.equal(service.list().items[0]?.providerSessionId, "native-session-1")
      assert.equal(service.list().items[0]?.providerTurnId, "native-turn-1")
    })
  }

  it("keeps separate native turns and resolves only the matching interactive permission", () => {
    const permission = service.ingest({
      source: "interactive-runtime",
      type: "permission-required",
      title: "Approve command",
      sessionId: "project-session",
      provider: "codex",
      providerSessionId: "native-session-2",
      providerTurnId: "permission-1",
      eventId: "runtime-permission-1",
      requiresAction: true,
    })
    const unrelated = service.ingest({
      source: "provider-hook",
      type: "permission-required",
      title: "Approve another command",
      sessionId: "telemetry-session",
      provider: "codex",
      providerSessionId: "native-session-2",
      providerTurnId: "permission-2",
      eventId: "hook-permission-2",
      requiresAction: true,
    })
    assert.equal(permission.created, true)
    assert.equal(unrelated.created, true)
    const resolved = service.ingest({
      source: "provider-hook",
      type: "permission-required",
      title: "Permission answered",
      sessionId: "telemetry-session",
      provider: "codex",
      providerSessionId: "native-session-2",
      providerTurnId: "permission-1",
      eventId: "hook-permission-resolved-1",
      requiresAction: false,
      resolveOf: {
        type: "permission-required",
        providerSessionId: "native-session-2",
        providerTurnId: "permission-1",
      },
    })
    assert.equal(resolved.updated, true)
    assert.equal(service.get(permission.notification!.id)?.actionResolvedAt == null, false)
    assert.equal(service.get(unrelated.notification!.id)?.actionResolvedAt, null)
    assert.equal(service.list().items.length, 2)
  })

  it("dedupes immediate Claude Stop repeats without collapsing later turns", () => {
    const firstRequest = normalizeProviderHookRequest(
      {
        hook_event_name: "Stop",
        session_id: "claude-session",
        last_assistant_message: "Finished the first task",
      },
      { provider: "claude" },
    )
    assert.equal(firstRequest.eventId, null)

    const first = service.ingest(firstRequest)
    const immediateRepeat = service.ingest(firstRequest)
    assert.equal(first.created, true)
    assert.equal(immediateRepeat.deduped, true)
    assert.equal(service.list().items.length, 1)

    const differentTurn = service.ingest(
      normalizeProviderHookRequest(
        {
          hook_event_name: "Stop",
          session_id: "claude-session",
          last_assistant_message: "Finished a different task",
        },
        { provider: "claude" },
      ),
    )
    assert.equal(differentTurn.created, true)
    assert.equal(service.list().items.length, 2)

    db.prepare(`UPDATE app_notifications SET created_at=? WHERE id=?`).run(
      "2000-01-01T00:00:00.000Z",
      first.notification!.id,
    )
    const laterSameContent = service.ingest(firstRequest)
    assert.equal(laterSameContent.created, true)
    assert.equal(service.list().items.length, 3)
  })

  it("permission resolve updates same record; completion is separate", () => {
    service.bindSession({
      sessionId: "sess-1",
      projectId: "p",
      projectName: "p",
      sessionTitle: "s",
      provider: "claude",
      ptyId: "t1",
    })
    const perm = service.ingest({
      source: "provider-hook",
      type: "permission-required",
      title: "Claude requested permission",
      sessionId: "sess-1",
      eventId: "perm-1",
    })
    assert.equal(perm.notification?.requiresAction, true)
    const resolved = service.ingest({
      source: "provider-hook",
      type: "permission-required",
      title: "Permission answered",
      sessionId: "sess-1",
      resolveOf: { type: "permission-required", eventId: "perm-1" },
    })
    assert.equal(resolved.updated, true)
    assert.ok(resolved.notification?.actionResolvedAt)
    assert.equal(resolved.notification?.status, "unread")

    const done = service.ingest({
      source: "provider-hook",
      type: "turn-completed",
      title: "Claude completed the turn",
      sessionId: "sess-1",
      eventId: "turn-1",
    })
    assert.equal(done.created, true)
    assert.equal(service.list({ filter: "all" }).items.length, 2)
  })

  it("read / resolve / dismiss stay independent", () => {
    const created = service.ingest({
      source: "system",
      type: "system",
      title: "Hello",
      sessionId: "s",
    })
    const id = created.notification!.id
    service.markRead(id)
    assert.equal(service.get(id)?.status, "read")
    service.markUnread(id)
    assert.equal(service.get(id)?.status, "unread")
    service.acknowledge(id)
    assert.equal(service.get(id)?.status, "resolved")
    assert.ok(service.get(id)?.actionResolvedAt)
    service.dismiss(id)
    assert.equal(service.get(id)?.status, "dismissed")
    assert.equal(service.list({ filter: "all" }).items.length, 0)
    service.restore(id)
    assert.notEqual(service.get(id)?.status, "dismissed")
  })

  it("mark all read does not resolve action-required", () => {
    service.ingest({
      source: "provider-hook",
      type: "permission-required",
      title: "Need permission",
      sessionId: "s1",
    })
    service.ingest({
      source: "provider-hook",
      type: "turn-completed",
      title: "Done",
      sessionId: "s1",
    })
    const counts = service.markAllRead()
    assert.equal(counts.totalUnread, 0)
    const action = service.list({ filter: "action-needed" }).items
    assert.equal(action.length, 1)
    assert.equal(action[0]?.actionResolvedAt, null)
    assert.equal(action[0]?.status, "read")
  })

  it("unreadBySession aggregates per session", () => {
    service.ingest({
      source: "provider-hook",
      type: "turn-completed",
      title: "A",
      sessionId: "s1",
      eventId: "e-a",
    })
    service.ingest({
      source: "provider-hook",
      type: "turn-completed",
      title: "B",
      sessionId: "s1",
      eventId: "e-b",
    })
    service.ingest({
      source: "provider-hook",
      type: "input-required",
      title: "C",
      sessionId: "s2",
      eventId: "e-c",
    })
    const bySession = service.unreadBySession()
    assert.equal(bySession.s1, 2)
    assert.equal(bySession.s2, 1)
    service.markAllRead({ sessionId: "s1" })
    const after = service.unreadBySession()
    assert.equal(after.s1 ?? 0, 0)
    assert.equal(after.s2, 1)
  })

  it("binding enriches older notifications and project health indexes", () => {
    const created = service.ingest({
      source: "provider-hook",
      type: "permission-required",
      title: "Needs permission",
      sessionId: "late-session",
      provider: "codex",
    })
    assert.equal(created.notification?.projectId, null)
    service.bindSession({
      sessionId: "late-session",
      projectId: "late-project",
      projectName: "yaade",
      sessionTitle: "Build HQ",
      provider: "codex",
      ptyId: "pty-late",
    })
    const enriched = service.get(created.notification!.id)
    assert.equal(enriched?.projectId, "late-project")
    assert.equal(enriched?.projectName, "yaade")
    assert.equal(enriched?.sessionTitle, "Build HQ")
    assert.equal(service.unreadByProject()["late-project"], 1)
    assert.equal(service.attentionByProject()["late-project"], 1)
    assert.equal(service.attentionBySession()["late-session"], 1)
  })

  it("markSessionUnread flips latest notification", () => {
    service.ingest({
      source: "provider-hook",
      type: "turn-completed",
      title: "Done",
      sessionId: "s9",
    })
    service.markAllRead({ sessionId: "s9" })
    assert.equal(service.unreadBySession().s9, undefined)
    const n = service.markSessionUnread("s9")
    assert.ok(n)
    assert.equal(n?.status, "unread")
    assert.equal(service.unreadBySession().s9, 1)
  })

  it("filters and search", () => {
    service.ingest({
      source: "provider-hook",
      type: "failed",
      title: "Codex failed",
      message: "exit 1",
      sessionId: "s1",
      projectId: "p1",
      projectName: "alpha",
      sessionTitle: "Auth rewrite",
      provider: "codex",
    })
    service.ingest({
      source: "provider-hook",
      type: "turn-completed",
      title: "Claude completed",
      sessionId: "s2",
      projectId: "p2",
      projectName: "beta",
      provider: "claude",
    })
    assert.equal(service.list({ filter: "errors" }).items.length, 1)
    assert.equal(service.list({ filter: "completed" }).items.length, 1)
    assert.equal(service.list({ query: "auth" }).items.length, 1)
    assert.equal(service.list({ provider: "claude" }).items.length, 1)
    assert.equal(service.list({ projectId: "p1" }).items.length, 1)
  })

  it("retention preserves unread errors and unresolved actions", () => {
    service.setPreferences({ retentionDays: 0, maxRetained: 5_000 })
    const fail = service.ingest({
      source: "process",
      type: "failed",
      title: "fail",
      sessionId: "s",
    })
    const perm = service.ingest({
      source: "provider-hook",
      type: "permission-required",
      title: "perm",
      sessionId: "s",
    })
    const old = service.ingest({
      source: "system",
      type: "system",
      title: "old",
      sessionId: "s",
    })
    service.markRead(old.notification!.id)
    // Force old created_at into the past
    db.prepare(`UPDATE app_notifications SET created_at=? WHERE id=?`).run(
      "2000-01-01T00:00:00.000Z",
      old.notification!.id,
    )
    db.prepare(`UPDATE app_notifications SET created_at=? WHERE id=?`).run(
      "2000-01-01T00:00:00.000Z",
      fail.notification!.id,
    )
    db.prepare(`UPDATE app_notifications SET created_at=? WHERE id=?`).run(
      "2000-01-01T00:00:00.000Z",
      perm.notification!.id,
    )
    const { deleted } = service.runRetention(new Date("2026-07-28T00:00:00.000Z"))
    assert.ok(deleted >= 1)
    assert.ok(service.get(fail.notification!.id))
    assert.ok(service.get(perm.notification!.id))
    assert.equal(service.get(old.notification!.id), null)
  })

  it("bounds large retention batches to 500 rows per pass", () => {
    const insert = db.prepare(
      `INSERT INTO app_notifications(
        id, type, severity, status, title, source,
        created_at, updated_at, metadata_json
      ) VALUES(?,?,?,?,?,?,?,?,?)`,
    )
    db.exec("BEGIN")
    for (let index = 0; index < 1_200; index += 1) {
      insert.run(
        `old-${index}`,
        "turn-completed",
        "info",
        "dismissed",
        "done",
        "system",
        "2000-01-01T00:00:00.000Z",
        "2000-01-01T00:00:00.000Z",
        "{}",
      )
    }
    db.exec("COMMIT")

    const result = service.runRetention(new Date("2026-07-28T00:00:00.000Z"))
    const remaining = db
      .prepare("SELECT COUNT(*) AS n FROM app_notifications")
      .get() as { n: number }
    assert.equal(result.deleted, 500)
    assert.equal(remaining.n, 700)
  })

  it("coalesces retention scheduled by a synchronous notification burst", async () => {
    class CountingNotificationService extends NotificationService {
      retentionRuns = 0

      override runRetention(now = new Date()): { deleted: number } {
        this.retentionRuns += 1
        return super.runRetention(now)
      }
    }

    const counted = new CountingNotificationService(db)
    for (let index = 0; index < 20; index += 1) {
      counted.ingest({
        source: "system",
        type: "system",
        title: `event ${index}`,
        sessionId: "burst",
        eventId: `burst-${index}`,
      })
    }
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(counted.retentionRuns, 1)
  })

  it("skips background-output when preference disabled", () => {
    const result = service.ingest({
      source: "aggregated-pty",
      type: "background-output",
      title: "Codex produced new output",
      sessionId: "s",
    })
    assert.equal(result.skipped, true)
  })

  it("survives reopen of sqlite file", () => {
    const file = path.join(dir, "t.sqlite3")
    service.ingest({
      source: "system",
      type: "system",
      title: "persist me",
      sessionId: "s",
    })
    db.close()
    const db2 = new DatabaseSync(file)
    const service2 = new NotificationService(db2)
    assert.equal(service2.counts().totalUnread, 1)
    db2.close()
    db = new DatabaseSync(file)
  })
})

describe("OSC + hook normalize", () => {
  it("parses yaade notify OSC", () => {
    const chunk =
      "\x1b]1337;Yaade=notify;" +
      JSON.stringify({
        type: "turn-completed",
        title: "Done",
        eventId: "e1",
        providerTurnId: "t1",
      }) +
      "\x07"
    const parsed = parseOscNotifications(chunk)
    assert.equal(parsed.length, 1)
    assert.equal(parsed[0]?.type, "turn-completed")
    assert.equal(parsed[0]?.eventId, "e1")
  })

  it("parses OSC 777 notify", () => {
    const parsed = parseOscNotifications("\x1b]777;notify;Hello;World\x07")
    assert.equal(parsed[0]?.title, "Hello")
    assert.equal(parsed[0]?.message, "World")
  })

  it("parses the compact YaadeNotify form and rejects invalid enums", () => {
    const parsed = parseOscNotifications(
      "\x1b]1337;YaadeNotify=not-a-type|Hello|World\x07",
    )
    assert.equal(parsed.length, 1)
    assert.equal(parsed[0]?.type, "provider-notification")
    assert.equal(parsed[0]?.title, "Hello")
  })

  it("parses notifications split across PTY chunks", () => {
    const first = parseOscStreamChunk("", "\x1b]777;notify;Build")
    assert.equal(first.notifications.length, 0)
    const second = parseOscStreamChunk(first.buffered, ";Finished\x07")
    assert.equal(second.notifications[0]?.title, "Build")
    assert.equal(second.notifications[0]?.message, "Finished")
    assert.equal(second.buffered, "")
  })

  it("normalizes hook event names", () => {
    assert.equal(normalizeHookEventName("Stop"), "turn-completed")
    assert.equal(normalizeHookEventName("agent-turn-complete"), "turn-completed")
    assert.equal(normalizeHookEventName("permission_request"), "permission-required")
  })

  it("normalizes native Claude hook input with authoritative URL context", () => {
    const normalized = normalizeProviderHookRequest(
      {
        hook_event_name: "Notification",
        notification_type: "permission_prompt",
        session_id: "claude-session",
        prompt_id: "prompt-1",
        title: "Permission\u0000 needed",
        message: "Allow Bash?",
        sessionId: "forged-app-session",
      },
      {
        provider: "claude",
        sessionId: "app-session",
        projectId: "project-1",
      },
    )
    assert.equal(normalized.type, "permission-required")
    assert.equal(normalized.sessionId, "app-session")
    assert.equal(normalized.providerSessionId, "claude-session")
    assert.equal(normalized.providerTurnId, "prompt-1")
    assert.equal(normalized.title, "Permission needed")
    assert.equal(normalized.source, "provider-hook")
  })

  it("normalizes Codex notify argv payload", () => {
    const normalized = normalizeProviderHookRequest(
      {
        type: "agent-turn-complete",
        "thread-id": "b5f6c1c2-1111-4111-8111-444455556666",
        "turn-id": "turn-7",
        "last-assistant-message": "Finished the refactor",
      },
      { provider: "codex", sessionId: "app-session" },
    )
    assert.equal(normalized.type, "turn-completed")
    assert.equal(normalized.sessionId, "app-session")
    assert.equal(
      normalized.providerSessionId,
      "b5f6c1c2-1111-4111-8111-444455556666",
    )
    assert.equal(normalized.providerTurnId, "turn-7")
    assert.equal(normalized.message, "Finished the refactor")
  })

  it("maps Codex snake_case thread_id to providerSessionId", () => {
    const normalized = normalizeProviderHookRequest(
      {
        type: "agent-turn-complete",
        thread_id: "aaaaaaaa-1111-4111-8111-bbbbbbbbbbbb",
        turn_id: "t1",
      },
      { provider: "codex", sessionId: "app-session" },
    )
    assert.equal(
      normalized.providerSessionId,
      "aaaaaaaa-1111-4111-8111-bbbbbbbbbbbb",
    )
  })

  it("normalizes OpenCode v1 and v2 permission events", () => {
    for (const version of ["permission", "permission.v2"]) {
      const asked = normalizeProviderHookRequest(
        {
          event: {
            type: `${version}.asked`,
            properties: { sessionID: "opencode-session" },
          },
        },
        { provider: "opencode", sessionId: "app-session" },
      )
      assert.equal(asked.type, "permission-required")
      assert.equal(asked.requiresAction, true)
      assert.equal(asked.resolveOf, undefined)

      const replied = normalizeProviderHookRequest(
        {
          event: {
            type: `${version}.replied`,
            properties: { sessionID: "opencode-session" },
          },
        },
        { provider: "opencode", sessionId: "app-session" },
      )
      assert.equal(replied.type, "permission-required")
      assert.equal(replied.requiresAction, false)
      assert.equal(replied.resolveOf?.type, "permission-required")
      assert.equal(replied.resolveOf?.providerSessionId, "opencode-session")
    }
  })
})

describe("policy", () => {
  it("maps severity preferences", () => {
    const prefs = mergeNotificationPreferences({ notifyOnCompleted: false })
    assert.equal(shouldCreateInAppNotification(prefs, "turn-completed"), false)
    assert.equal(shouldCreateInAppNotification(prefs, "failed"), true)
  })

  it("bounds malformed numeric preference input", () => {
    const prefs = mergeNotificationPreferences({
      retentionDays: -100,
      maxRetained: Number.POSITIVE_INFINITY,
      backgroundOutputSettleMs: 999_999,
    })
    assert.equal(prefs.retentionDays, 1)
    assert.equal(prefs.maxRetained, 5_000)
    assert.equal(prefs.backgroundOutputSettleMs, 60_000)
  })

  it("suppresses desktop when viewing session", () => {
    const result = evaluateDesktopDelivery({
      prefs: mergeNotificationPreferences(),
      type: "turn-completed",
      viewingSessionId: "s1",
      notificationSessionId: "s1",
      permission: "granted",
      wasDeduped: false,
      recentlyDelivered: false,
    })
    assert.equal(result.deliver, false)
    assert.equal(result.reason, "viewing-session")
  })
})

describe("content hash", () => {
  it("stable for same semantic content", () => {
    const a = contentHashFor({
      type: "turn-completed",
      title: "Done",
      message: null,
      providerTurnId: "t",
    })
    const b = contentHashFor({
      type: "turn-completed",
      title: "Done",
      message: null,
      providerTurnId: "t",
    })
    assert.equal(a, b)
  })
})
