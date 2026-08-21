import { expect, test } from "@playwright/test"
import os from "node:os"
import { createRequire } from "node:module"
import fs from "node:fs"
import path from "node:path"
import {
  STORAGE_FAILURE_FILE,
} from "../../packages/yaade-host-server/src/database.js"
import {
  createDurableRuntimeHarness,
  createSession,
  listSessions,
} from "../runtime/harness/index.js"
import { waitUntil } from "../runtime/harness/wait.js"

const DatabaseSync = createRequire(import.meta.url)("node:sqlite").DatabaseSync as new (
  path: string,
  options?: { timeout?: number },
) => {
  exec(sql: string): void
  prepare(sql: string): { run: (...args: unknown[]) => unknown }
  close(): void
}

async function withHarness(
  testInfo: { outputDir: string },
  run: (harness: Awaited<ReturnType<typeof createDurableRuntimeHarness>>) => Promise<void>,
  options?: { env?: Record<string, string> },
): Promise<void> {
  const harness = await createDurableRuntimeHarness(options)
  try {
    await run(harness)
  } catch (error) {
    await harness.retainDiagnostics(testInfo.outputDir).catch(() => undefined)
    throw error
  } finally {
    await harness.close()
  }
}

test.describe("O — storage, diagnostics, and compatibility", { tag: "@p2" }, () => {
  test("O03 database migration preserves sessions", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const dbPath = path.join(harness.dataDir, "jet.sqlite3")
      const db = new DatabaseSync(dbPath)
      db.exec(`
        CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
        CREATE TABLE app_sessions(
          id TEXT PRIMARY KEY,
          machine TEXT NOT NULL,
          title TEXT NOT NULL,
          position INTEGER NOT NULL,
          revision INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          archived_at TEXT
        );
      `)
      db.prepare(
        `INSERT INTO app_sessions(id, machine, title, position, revision, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?)`,
      ).run(
        "ses-legacy-keep",
        os.hostname(),
        "Legacy session",
        0,
        1,
        new Date().toISOString(),
        new Date().toISOString(),
      )
      db.close()
      await harness.startApi()
      const sessions = await listSessions(harness.origin)
      expect(
        sessions.some(row => row.session.id === "ses-legacy-keep" || row.session.title === "Legacy session"),
      ).toBe(true)
    })
  })

  test("O04 corrupt database fails safely with recovery guidance", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const dbPath = path.join(harness.dataDir, "jet.sqlite3")
      const payload = "this is not a sqlite database\n"
      fs.writeFileSync(dbPath, payload)
      await expect(harness.startApi()).rejects.toThrow(/API exited|integrity|malformed|sqlite/i)
      expect(fs.readFileSync(dbPath, "utf8")).toBe(payload)
      const failurePath = path.join(harness.dataDir, STORAGE_FAILURE_FILE)
      expect(fs.existsSync(failurePath)).toBe(true)
      const record = JSON.parse(fs.readFileSync(failurePath, "utf8")) as {
        message?: string
        recovery?: string
      }
      expect(record.recovery).toMatch(/backup/i)
      expect(record.message).toBeTruthy()
    })
  })

  test("O05 database-busy degrades without corrupting live terminals", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      await harness.startSupervisor()
      const launched = await harness.launchMockAgent({ mode: "idle" })
      const locker = new DatabaseSync(path.join(harness.dataDir, "jet.sqlite3"), { timeout: 50 })
      locker.exec("BEGIN EXCLUSIVE")
      const created = createSession(api.origin, "busy-writer")
      await new Promise(resolve => setTimeout(resolve, 400))
      locker.exec("COMMIT")
      locker.close()
      await expect(created).resolves.toMatchObject({ title: "busy-writer" })
      await harness.assertProcessAlive(launched.processIdentity)
    })
  })

  test("O06 diagnostic bundle redacts secrets and rejects incompatible protocols", async ({}, testInfo) => {
    const token = "yaade-diagnostic-secret-token"
    await withHarness(
      testInfo,
      async harness => {
        await harness.startApi()
        const response = await fetch(`${harness.origin}/api/v1/diagnostics`, {
          headers: { authorization: `Bearer ${token}` },
        })
        expect(response.ok).toBe(true)
        const body = await response.text()
        expect(body).not.toContain(token)
        const parsed = JSON.parse(body) as { identity?: { protocolVersion?: number } }
        expect(parsed.identity?.protocolVersion).toBe(2)
        const closeCode = await new Promise<number>((resolve, reject) => {
          const socket = new WebSocket(`${harness.origin.replace(/^http/, "ws")}/ws?protocol=99`)
          const fail = setTimeout(() => reject(new Error("incompatible websocket did not close")), 8_000)
          socket.addEventListener("close", event => {
            clearTimeout(fail)
            resolve(event.code)
          })
          socket.addEventListener("error", () => {
            /* Node may emit error before close; wait for the close event */
          })
        })
        expect(closeCode).toBe(4002)
      },
      { env: { YAADE_HOST_TOKEN: token } },
    )
  })
})
