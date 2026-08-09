import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { ProjectSession, ProjectSessionPayload } from "@yaade/rpc"
import { ProjectSessionPersistWriter } from "./project-session-client.js"

function payload(label: string): ProjectSessionPayload {
  return {
    version: 2,
    layout: {
      tree: { root: null },
      focusedPaneId: null,
      zoomedPaneId: null,
    },
    sessions: [
      {
        ptyTabId: `yaade:terminal:${label}`,
        cwdRootUri: "file:///tmp",
        launchCommand: label,
        agentProvider: label === "codex" ? "codex" : undefined,
        ptyId: `pty-${label}`,
      },
    ],
  }
}

function asSession(id: string, body: ProjectSessionPayload): ProjectSession {
  return {
    id,
    machine: "test",
    projectPath: "/tmp",
    cwdPath: "/tmp",
    title: "Main",
    worktreeBranch: null,
    worktreePath: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    payload: body,
  }
}

async function settle(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
  await new Promise<void>(resolve => setImmediate(resolve))
}

describe("ProjectSessionPersistWriter", () => {
  it("coalesces debounced enqueues to the newest snapshot", async () => {
    const saved: string[] = []
    const writer = new ProjectSessionPersistWriter(async (id, body) => {
      saved.push(body.sessions[0]?.launchCommand ?? id)
      return asSession(id, body)
    }, 20)

    writer.enqueue("ses-1", payload("one"))
    writer.enqueue("ses-1", payload("two"))
    writer.enqueue("ses-1", payload("three"))
    assert.deepEqual(saved, [])
    await new Promise<void>(resolve => setTimeout(resolve, 40))
    await settle()
    assert.deepEqual(saved, ["three"])
    writer.stop()
  })

  it("flush+stop still writes the pending snapshot (unmount race)", async () => {
    const saved: string[] = []
    let release: (() => void) | null = null
    const writer = new ProjectSessionPersistWriter(async (id, body) => {
      saved.push(body.sessions[0]?.launchCommand ?? id)
      if (saved.length === 1) {
        await new Promise<void>(resolve => {
          release = resolve
        })
      }
      return asSession(id, body)
    }, 5)

    writer.enqueue("ses-1", payload("codex"))
    await new Promise<void>(resolve => setTimeout(resolve, 10))
    await settle()
    // In-flight write holds the lock; enqueue a newer closed layout.
    writer.enqueue("ses-1", payload("closed"))
    // Mimic MuxApp unmount: flush then stop before the in-flight write settles.
    const done = writer.flushAndStop()
    release?.()
    await done
    await settle()
    assert.ok(saved.includes("codex"))
    assert.ok(
      saved.includes("closed"),
      `expected closed layout to persist, got ${JSON.stringify(saved)}`,
    )
  })

  it("stop after flush does not drop a debounced pending write", async () => {
    const saved: string[] = []
    const writer = new ProjectSessionPersistWriter(async (id, body) => {
      saved.push(body.sessions[0]?.launchCommand ?? id)
      return asSession(id, body)
    }, 50)

    writer.enqueue("ses-1", payload("agent"))
    // Unmount before debounce fires — previous bug discarded this.
    await writer.flushAndStop()
    await settle()
    assert.deepEqual(saved, ["agent"])
  })
})
