import { expect, test } from "@playwright/test"
import fs from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import {
  CreateToolUse,
  MainCheckout,
  ProjectTarget,
  SessionId,
  TerminalToolInput,
} from "../../packages/yaade-rpc/src/tool-session.js"
import {
  attachTerminal,
  acquireLease,
  createDurableRuntimeHarness,
  createSession,
  createToolUse,
  forceSupervisorCheckpoint,
  injectSupervisorCheckpoint,
  listProjects,
  MOCK_AGENT_PATH,
  numberedLine,
  numberedLinesPresentOnce,
  pingSupervisor,
  reconstructAttachScreen,
  resizeTerminal,
  waitForAttach,
  waitForMockAgent,
  writeTerminal,
} from "../runtime/harness/index.js"
import { waitUntil } from "../runtime/harness/wait.js"

async function withHarness(
  testInfo: { outputDir: string },
  run: (harness: Awaited<ReturnType<typeof createDurableRuntimeHarness>>) => Promise<void>,
  env?: Record<string, string>,
): Promise<void> {
  const harness = await createDurableRuntimeHarness({
    env: { YAADE_TERMINAL_RUNTIME_GENERATION: "legacy", ...env },
  })
  try {
    await run(harness)
  } catch (error) {
    await harness.retainDiagnostics(path.join(testInfo.outputDir, "runtime")).catch(() => undefined)
    throw error
  } finally {
    await harness.close()
  }
}

async function launchMock(
  origin: string,
  project: { id: string; rootPath: string; name: string },
  controlFile: string,
  title: string,
  extraArgs: string[] = [],
) {
  const session = await createSession(origin, title)
  const created = await createToolUse(
    origin,
    CreateToolUse.make({
      sessionId: Schema.decodeUnknownSync(SessionId)(session.id),
      kind: "terminal",
      title,
      project: ProjectTarget.make({
        projectId: project.id,
        projectPath: project.rootPath,
        projectName: project.name,
      }),
      checkout: MainCheckout.make({ kind: "main" }),
      input: TerminalToolInput.make({
        kind: "terminal",
        executable: process.execPath,
        shellArgs: [MOCK_AGENT_PATH, "--mode", "idle", "--control-file", controlFile, ...extraArgs],
      }),
    }),
  )
  const agent = await waitForMockAgent(controlFile)
  const ptyId = created.output.ptyId
  if (!ptyId) throw new Error(`${title} launched without a PTY`)
  return { session, created, agent, ptyId }
}

const smallReplayEnv = {
  JET_TERMINAL_REPLAY_BYTES: "2048",
  JET_CHECKPOINT_BYTES: "256",
  JET_CHECKPOINT_INTERVAL_MS: "40",
}

test.describe("T — terminal checkpoint and replay fidelity", { tag: "@p1" }, () => {
  test("T01 reconnect after raw replay capacity uses checkpoint plus delta", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      await harness.startSupervisor()
      const project = (await listProjects(api.origin))[0]
      expect(project).toBeTruthy()
      const launched = await launchMock(
        api.origin,
        project!,
        path.join(harness.root, "t01.json"),
        "T01",
      )
      await launched.agent.emitRange(1, 220)
      await waitUntil(async () => {
        const attached = await attachTerminal(api.origin, launched.ptyId)
        if (
          attached?.replayTruncated !== true ||
          attached.replayQuality !== "checkpoint" ||
          !attached.checkpoint?.syntheticAnsi
        ) {
          return false
        }
        const screen = reconstructAttachScreen(attached)
        return numberedLinesPresentOnce(screen, 218, 220).missing.length === 0
      }, 15_000, "checkpoint replay after ring overflow")
      const attached = await waitForAttach(api.origin, launched.ptyId)
      expect(attached.replayQuality).toBe("checkpoint")
      expect(attached.checkpoint?.syntheticAnsi).toBeTruthy()
      const screen = reconstructAttachScreen(attached)
      expect(screen.includes(numberedLine(220))).toBe(true)
      const present = numberedLinesPresentOnce(screen, 218, 220)
      expect(present.missing).toEqual([])
      expect(present.duplicated).toEqual([])
    }, smallReplayEnv)
  })

  test("T02 alternate-screen full-screen application restores coherently", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      await harness.startSupervisor()
      const project = (await listProjects(api.origin))[0]
      const launched = await launchMock(
        api.origin,
        project!,
        path.join(harness.root, "t02.json"),
        "T02",
      )
      await launched.agent.emitRange(1, 180)
      await launched.agent.setMode("alt-screen")
      await forceSupervisorCheckpoint(harness.dataDir, launched.ptyId)
      await waitUntil(async () => {
        const attached = await attachTerminal(api.origin, launched.ptyId)
        return Boolean(
          attached?.replayTruncated &&
          attached.checkpoint?.syntheticAnsi?.includes("\u001b[?1049h"),
        )
      }, 15_000, "alternate-screen checkpoint")
      const attached = await waitForAttach(api.origin, launched.ptyId)
      expect(attached.checkpoint?.syntheticAnsi).toContain("\u001b[?1049h")
      expect(attached.output).toContain("YAADE_MOCK_ALT_SCREEN")
    }, smallReplayEnv)
  })

  test("T03 cursor and terminal modes survive checkpoint restoration", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      await harness.startSupervisor()
      const project = (await listProjects(api.origin))[0]
      const launched = await launchMock(
        api.origin,
        project!,
        path.join(harness.root, "t03.json"),
        "T03",
      )
      await launched.agent.setMode("styles")
      await launched.agent.emitRange(1, 220)
      await forceSupervisorCheckpoint(harness.dataDir, launched.ptyId)
      await waitUntil(async () => {
        const snapshot = await attachTerminal(api.origin, launched.ptyId)
        return Boolean(snapshot?.checkpoint?.syntheticAnsi?.includes("\u001b[?25l"))
      }, 10_000, "hidden cursor checkpoint")
      const attached = await waitForAttach(api.origin, launched.ptyId)
      expect(attached.checkpoint?.syntheticAnsi).toContain("\u001b[?25l")
      await writeTerminal(api.origin, launched.ptyId, "ok\r")
      const after = await waitForAttach(api.origin, launched.ptyId)
      expect(after.status).toBe("running")
    }, smallReplayEnv)
  })

  test("T04 output racing checkpoint creation and attach is contiguous", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      await harness.startSupervisor()
      const project = (await listProjects(api.origin))[0]
      const launched = await launchMock(
        api.origin,
        project!,
        path.join(harness.root, "t04.json"),
        "T04",
      )
      await launched.agent.startNumbered(1, 0, 5)
      await forceSupervisorCheckpoint(harness.dataDir, launched.ptyId)
      const first = await attachTerminal(api.origin, launched.ptyId)
      await launched.agent.emitRange(400, 420)
      await waitUntil(async () => {
        const snapshot = await attachTerminal(api.origin, launched.ptyId)
        return numberedLinesPresentOnce(snapshot?.output ?? "", 400, 420).missing.length === 0
      }, 10_000, "post-checkpoint numbered range")
      const second = await waitForAttach(api.origin, launched.ptyId)
      expect(second.lastSequence).toBeGreaterThan(first?.lastSequence ?? 0)
      const present = numberedLinesPresentOnce(second.output, 400, 420)
      expect(present.missing).toEqual([])
    }, smallReplayEnv)
  })

  test("T05 unicode and escape sequences split across chunks remain valid", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      await harness.startSupervisor()
      const project = (await listProjects(api.origin))[0]
      const launched = await launchMock(
        api.origin,
        project!,
        path.join(harness.root, "t05.json"),
        "T05",
      )
      await launched.agent.setMode("unicode")
      await launched.agent.emitText("YAADE_MOCK_OSC \u001b]0;title\u0007done")
      await forceSupervisorCheckpoint(harness.dataDir, launched.ptyId)
      const attached = await waitForAttach(api.origin, launched.ptyId)
      expect(attached.output).toContain("café")
      expect(attached.output).not.toContain("\uFFFD")
    })
  })

  test("T06 writer resize before and after checkpoint restores geometry", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      await harness.startSupervisor()
      const project = (await listProjects(api.origin))[0]
      const launched = await launchMock(
        api.origin,
        project!,
        path.join(harness.root, "t06.json"),
        "T06",
      )
      await acquireLease(api.origin, launched.ptyId, "legacy:runtime-e2e")
      await resizeTerminal(api.origin, launched.ptyId, 60, 18)
      await launched.agent.emitRange(1, 30)
      await waitUntil(async () => {
        const snapshot = await attachTerminal(api.origin, launched.ptyId)
        return snapshot?.cols === 60 && snapshot.rows === 18
      }, 10_000, "writer geometry 60x18")
      const mid = await waitForAttach(api.origin, launched.ptyId)
      expect(mid.cols).toBe(60)
      expect(mid.rows).toBe(18)
      if (mid.checkpoint) {
        expect(mid.checkpoint.cols).toBe(60)
        expect(mid.checkpoint.rows).toBe(18)
      }
      await resizeTerminal(api.origin, launched.ptyId, 100, 30)
      await waitUntil(async () => {
        const snapshot = await attachTerminal(api.origin, launched.ptyId)
        return snapshot?.cols === 100 && snapshot.rows === 30
      }, 10_000, "writer geometry 100x30")
      const attached = await waitForAttach(api.origin, launched.ptyId)
      expect(attached.cols).toBe(100)
      expect(attached.rows).toBe(30)
      expect(attached.status).toBe("running")
    })
  })

  test("T07 corrupt or incompatible checkpoint is ignored safely", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      await harness.startSupervisor()
      const project = (await listProjects(api.origin))[0]
      const launched = await launchMock(
        api.origin,
        project!,
        path.join(harness.root, "t07.json"),
        "T07",
      )
      await launched.agent.emitRange(1, 80)
      await injectSupervisorCheckpoint(harness.dataDir, launched.ptyId, {
        checkpointVersion: 99,
        sequence: 1,
        syntheticAnsi: "\u001b[Hbroken",
      })
      const attached = await waitForAttach(api.origin, launched.ptyId)
      expect(attached.checkpoint).toBeUndefined()
      expect(attached.status).toBe("running")
      expect(attached.output).toContain(numberedLine(80))
    }, smallReplayEnv)
  })

  test("T08 disk-full checkpoint write does not stop live terminals", async ({}, testInfo) => {
    const checkpointPath = path.join(testInfo.outputDir, "not-a-dir")
    fs.mkdirSync(testInfo.outputDir, { recursive: true })
    fs.writeFileSync(checkpointPath, "file\n")
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      await harness.startSupervisor()
      const project = (await listProjects(api.origin))[0]
      const launched = await launchMock(
        api.origin,
        project!,
        path.join(harness.root, "t08.json"),
        "T08",
      )
      await launched.agent.emitRange(1, 40)
      await forceSupervisorCheckpoint(harness.dataDir, launched.ptyId).catch(() => undefined)
      await waitUntil(async () => {
        const ping = await pingSupervisor(harness.dataDir)
        return ping.persistenceDegraded === true
      }, 10_000, "persistence degraded")
      expect(launched.agent.pid).toBeGreaterThan(0)
      const attached = await waitForAttach(api.origin, launched.ptyId)
      expect(attached.status).toBe("running")
      await writeTerminal(api.origin, launched.ptyId, "still-alive\r")
    }, { ...smallReplayEnv, JET_CHECKPOINT_DIR: checkpointPath })
  })

  test("T09 process exit during attach produces a stable final screen", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      await harness.startSupervisor()
      const project = (await listProjects(api.origin))[0]
      const launched = await launchMock(
        api.origin,
        project!,
        path.join(harness.root, "t09.json"),
        "T09",
      )
      await launched.agent.emitRange(1, 12)
      await launched.agent.exit(7)
      await waitUntil(async () => {
        const attached = await attachTerminal(api.origin, launched.ptyId)
        return attached?.status === "exited"
      }, 10_000, "terminal exit")
      const attached = await waitForAttach(api.origin, launched.ptyId)
      expect(attached.status).toBe("exited")
      expect(attached.output).toContain(numberedLine(12))
      const again = await waitForAttach(api.origin, launched.ptyId)
      expect(again.status).toBe("exited")
      expect(again.lastSequence).toBe(attached.lastSequence)
    })
  })
})
