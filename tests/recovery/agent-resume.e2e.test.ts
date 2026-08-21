import { expect, test } from "@playwright/test"
import fs from "node:fs"
import path from "node:path"
import { enqueueFailedHook, hookQueueDir } from "../../packages/yaade-host-server/src/agents/hook-queue.js"
import {
  attachTerminal,
  createDurableRuntimeHarness,
  createTerminalInstance,
  getAgentSnapshot,
  ingestNative,
  listProjects,
  listTerminalInstances,
  MOCK_AGENT_PATH,
  notificationCounts,
  restartTerminalInstance,
  waitForMockAgent,
  writeTerminal,
} from "../runtime/harness/index.js"
import { waitUntil } from "../runtime/harness/wait.js"

async function withHarness(
  testInfo: { outputDir: string },
  run: (harness: Awaited<ReturnType<typeof createDurableRuntimeHarness>>) => Promise<void>,
  env?: Record<string, string>,
): Promise<void> {
  const harness = await createDurableRuntimeHarness({ env })
  try {
    await run(harness)
  } catch (error) {
    await harness.retainDiagnostics(path.join(testInfo.outputDir, "runtime")).catch(() => undefined)
    throw error
  } finally {
    await harness.close()
  }
}

async function launchProvider(
  origin: string,
  project: { id: string; rootPath: string },
  controlFile: string,
  options: {
    provider: "claude" | "grok"
    title: string
    extraArgs?: string[]
    restartPolicy?: "never" | "manual" | "resume-on-daemon-start"
    executable?: string
    agentScript?: string
    nativeSessionRef?: {
      provider: "claude" | "grok"
      kind: string
      value: string
      capturedAt: string
      driverVersion: number
    }
  },
) {
  const instance = await createTerminalInstance(origin, {
    projectId: project.id,
    checkoutPath: project.rootPath,
    checkoutKey: "main",
    title: options.title,
    provider: options.provider,
    executable: options.executable ?? process.execPath,
    args: [
      options.agentScript ?? MOCK_AGENT_PATH,
      "--mode",
      "idle",
      "--control-file",
      controlFile,
      ...(options.extraArgs ?? []),
    ],
    restartPolicy: options.restartPolicy ?? "manual",
    ...(options.nativeSessionRef ? { nativeSessionRef: options.nativeSessionRef } : {}),
    launchRequestId: `resume-${path.basename(controlFile)}`,
  })
  const agent = await waitForMockAgent(controlFile)
  const ptyId = instance.ptyId
  if (!ptyId) throw new Error(`${options.title} launched without a PTY`)
  return { instance, agent, ptyId }
}

async function instanceById(
  origin: string,
  projectId: string,
  id: string,
) {
  const listed = await listTerminalInstances(origin, projectId)
  return listed.find(item => item.id === id) ?? null
}

async function restartDaemon(
  harness: Awaited<ReturnType<typeof createDurableRuntimeHarness>>,
) {
  await harness.killApi("SIGKILL")
  await harness.killSupervisor("SIGKILL")
  return harness.startApi()
}

test.describe("R — agent lifecycle and provider-native recovery", { tag: "@p1" }, () => {
  test("R01 native provider session reference is captured and persisted", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      await harness.startSupervisor()
      const project = (await listProjects(api.origin))[0]
      expect(project).toBeTruthy()
      const launched = await launchProvider(api.origin, project!, path.join(harness.root, "r01.json"), {
        provider: "claude",
        title: "R01",
      })
      const ingested = await ingestNative(api.origin, {
        provider: "claude",
        sessionId: launched.instance.id,
        processId: launched.ptyId,
        payload: {
          hook_event_name: "SessionStart",
          session_id: "claude-native-r01",
          source: "startup",
        },
      })
      expect(ingested.nativeSessionId).toBe("claude-native-r01")
      await harness.killApi("SIGTERM")
      const restarted = await harness.startApi()
      const restored = await instanceById(restarted.origin, project!.id, launched.instance.id)
      expect(restored?.nativeSessionId).toBe("claude-native-r01")
      expect(restored?.generation).toBe(launched.instance.generation)
      const db = await harness.readDatabaseState()
      const row = db.terminalInstances.find(item => item.id === launched.instance.id)
      expect(String(row?.native_session_id ?? "")).toContain("claude-native-r01")
    })
  })

  test("R02 supported provider resumes into a new PTY generation after daemon restart", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      await harness.startSupervisor()
      const project = (await listProjects(api.origin))[0]!
      const launched = await launchProvider(api.origin, project, path.join(harness.root, "r02.json"), {
        provider: "claude",
        title: "R02",
        restartPolicy: "resume-on-daemon-start",
      })
      await ingestNative(api.origin, {
        provider: "claude",
        sessionId: launched.instance.id,
        processId: launched.ptyId,
        payload: {
          hook_event_name: "SessionStart",
          session_id: "claude-native-r02",
          source: "startup",
        },
      })
      const oldPty = launched.ptyId
      const oldPid = launched.agent.pid
      const restarted = await restartDaemon(harness)
      await waitUntil(async () => {
        const current = await instanceById(restarted.origin, project.id, launched.instance.id)
        return Boolean(
          current &&
          current.generation > launched.instance.generation &&
          current.ptyId &&
          current.ptyId !== oldPty &&
          current.processState === "running",
        )
      }, 20_000, "native resume generation")
      const current = await instanceById(restarted.origin, project.id, launched.instance.id)
      expect(current?.nativeSessionId).toBe("claude-native-r02")
      expect(current?.ptyId).not.toBe(oldPty)
      await waitUntil(() => {
        try {
          process.kill(oldPid, 0)
          return false
        } catch {
          return true
        }
      }, 8_000, "old agent exited")
      await waitUntil(async () => {
        const attached = await attachTerminal(restarted.origin, current!.ptyId!)
        return Boolean(attached?.output.includes("YAADE_MOCK_RESUMED"))
      }, 10_000, "resumed mock output")
      const attached = await attachTerminal(restarted.origin, current!.ptyId!)
      expect(attached?.output).toContain("YAADE_MOCK_RESUMED")
    })
  })

  test("R03 unsupported provider returns interrupted with deterministic restart", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      await harness.startSupervisor()
      const project = (await listProjects(api.origin))[0]!
      const launched = await launchProvider(api.origin, project, path.join(harness.root, "r03.json"), {
        provider: "grok",
        title: "R03",
        restartPolicy: "resume-on-daemon-start",
        nativeSessionRef: {
          provider: "grok",
          kind: "session",
          value: "grok-native-r03",
          capturedAt: new Date().toISOString(),
          driverVersion: 1,
        },
      })
      const restarted = await restartDaemon(harness)
      await waitUntil(async () => {
        const current = await instanceById(restarted.origin, project.id, launched.instance.id)
        return current?.processState === "failed" || current?.processState === "interrupted"
      }, 15_000, "unsupported resume failed")
      const current = await instanceById(restarted.origin, project.id, launched.instance.id)
      expect(current?.processState === "failed" || current?.processState === "interrupted").toBe(true)
      expect(current?.generation).toBe(launched.instance.generation)
      expect(current?.ptyId == null || current?.ptyId === launched.ptyId).toBe(true)
    })
  })

  test("R04 failed native resume is honest and retryable", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      await harness.startSupervisor()
      const project = (await listProjects(api.origin))[0]!
      const launched = await launchProvider(api.origin, project, path.join(harness.root, "r04.json"), {
        provider: "claude",
        title: "R04",
        extraArgs: ["--fail-resume"],
        restartPolicy: "resume-on-daemon-start",
      })
      await ingestNative(api.origin, {
        provider: "claude",
        sessionId: launched.instance.id,
        processId: launched.ptyId,
        payload: {
          hook_event_name: "SessionStart",
          session_id: "claude-native-r04",
          source: "startup",
        },
      })
      const restarted = await restartDaemon(harness)
      await waitUntil(async () => {
        const current = await instanceById(restarted.origin, project.id, launched.instance.id)
        return current?.processState === "failed"
      }, 20_000, "resume failed")
      const failed = await instanceById(restarted.origin, project.id, launched.instance.id)
      expect(failed?.nativeSessionId).toBe("claude-native-r04")
      const retried = await restartTerminalInstance(restarted.origin, launched.instance.id, failed!.generation)
      expect(retried.generation).toBe((failed?.generation ?? 1) + 1)
      const again = await instanceById(restarted.origin, project.id, launched.instance.id)
      expect(again?.generation).toBe(retried.generation)
    })
  })

  test("R05 missing provider binary blocks resume without corrupting state", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      await harness.startSupervisor()
      const project = (await listProjects(api.origin))[0]!
      const script = path.join(harness.root, "agent-copy.mjs")
      fs.copyFileSync(MOCK_AGENT_PATH, script)
      const launched = await launchProvider(api.origin, project, path.join(harness.root, "r05.json"), {
        provider: "claude",
        title: "R05",
        extraArgs: [],
        restartPolicy: "resume-on-daemon-start",
        agentScript: script,
      })
      await ingestNative(api.origin, {
        provider: "claude",
        sessionId: launched.instance.id,
        processId: launched.ptyId,
        payload: {
          hook_event_name: "SessionStart",
          session_id: "claude-native-r05",
          source: "startup",
        },
      })
      fs.rmSync(script)
      const restarted = await restartDaemon(harness)
      await waitUntil(async () => {
        const current = await instanceById(restarted.origin, project.id, launched.instance.id)
        return current?.processState === "failed"
      }, 20_000, "missing binary resume failed")
      fs.copyFileSync(MOCK_AGENT_PATH, script)
      const failed = await instanceById(restarted.origin, project.id, launched.instance.id)
      const retried = await restartTerminalInstance(restarted.origin, launched.instance.id, failed!.generation)
      expect(retried.processState === "running" || retried.ptyId).toBeTruthy()
    })
  })

  test("R06 telemetry timeout degrades semantics but not process liveness", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      await harness.startSupervisor()
      const project = (await listProjects(api.origin))[0]!
      const launched = await launchProvider(api.origin, project, path.join(harness.root, "r06.json"), {
        provider: "claude",
        title: "R06",
      })
      await waitUntil(async () => {
        const current = await instanceById(api.origin, project.id, launched.instance.id)
        return current?.telemetryState === "degraded"
      }, 8_000, "telemetry degraded")
      expect(launched.agent.pid).toBeGreaterThan(0)
      await ingestNative(api.origin, {
        provider: "claude",
        sessionId: launched.instance.id,
        processId: launched.ptyId,
        payload: {
          hook_event_name: "SessionStart",
          session_id: "claude-native-r06",
          source: "startup",
        },
      })
      await waitUntil(async () => {
        const current = await instanceById(api.origin, project.id, launched.instance.id)
        return current?.telemetryState === "connected"
      }, 8_000, "telemetry connected")
      const current = await instanceById(api.origin, project.id, launched.instance.id)
      expect(current?.generation).toBe(launched.instance.generation)
      expect(current?.ptyId).toBe(launched.ptyId)
    }, { JET_TELEMETRY_GRACE_MS: "200" })
  })

  test("R07 permission request while no client is connected is visible after reconnect", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      await harness.startSupervisor()
      const project = (await listProjects(api.origin))[0]!
      const launched = await launchProvider(api.origin, project, path.join(harness.root, "r07.json"), {
        provider: "claude",
        title: "R07",
      })
      await ingestNative(api.origin, {
        provider: "claude",
        sessionId: launched.instance.id,
        processId: launched.ptyId,
        payload: {
          hook_event_name: "PermissionRequest",
          session_id: "claude-native-r07",
          permission_id: "perm-r07",
          tool_name: "Bash",
        },
      })
      await waitUntil(async () => {
        const current = await instanceById(api.origin, project.id, launched.instance.id)
        return current?.activityState === "waiting_for_permission"
      }, 8_000, "permission required")
      const browser = await harness.startBrowser()
      const current = await instanceById(api.origin, project.id, launched.instance.id)
      expect(current?.activityState).toBe("waiting_for_permission")
      const counts = await notificationCounts(api.origin)
      expect((counts.actionRequired ?? counts.totalUnread ?? 0) > 0).toBe(true)
      await browser.close()
    })
  })

  test("R08 hook events queued during API outage are ingested exactly once", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      await harness.startSupervisor()
      const project = (await listProjects(api.origin))[0]!
      const launched = await launchProvider(api.origin, project, path.join(harness.root, "r08.json"), {
        provider: "claude",
        title: "R08",
      })
      await harness.killApi("SIGKILL")
      enqueueFailedHook(
        {
          hook_event_name: "PermissionRequest",
          session_id: "claude-native-r08",
          permission_id: "perm-r08",
          tool_name: "Bash",
        },
        {
          provider: "claude",
          sessionId: launched.instance.id,
          ingestUrl: `${api.origin}/api/v1/notifications/ingest`,
        },
        harness.dataDir,
      )
      const restarted = await harness.startApi()
      await waitUntil(async () => {
        const current = await instanceById(restarted.origin, project.id, launched.instance.id)
        const queue = fs.existsSync(hookQueueDir(harness.dataDir))
          ? fs.readdirSync(hookQueueDir(harness.dataDir)).filter(name => name.endsWith(".json"))
          : []
        return current?.activityState === "waiting_for_permission" && queue.length === 0
      }, 15_000, "queued hook drained once")
      const snapshot = await getAgentSnapshot(restarted.origin, launched.instance.id)
      expect(snapshot?.status).toBe("waiting_for_permission")
    })
  })

  test("R09 agent returning to the shell demotes without closing the PTY", async ({}, testInfo) => {
    test.skip(process.platform === "win32", "foreground process discovery for PATH shims is POSIX-only")
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      await harness.startSupervisor()
      const project = (await listProjects(api.origin))[0]!
      const binDir = path.join(harness.root, "bin")
      fs.mkdirSync(binDir, { recursive: true })
      const claudeBin = path.join(binDir, "claude")
      fs.writeFileSync(
        claudeBin,
        `#!/bin/sh\n${JSON.stringify(process.execPath)} "$@"\n`,
      )
      fs.chmodSync(claudeBin, 0o755)
      const controlFile = path.join(harness.root, "r09.json")
      const instance = await createTerminalInstance(api.origin, {
        projectId: project.id,
        checkoutPath: project.rootPath,
        checkoutKey: "main",
        title: "R09-shell",
        executable: "/bin/sh",
        args: ["-i"],
      })
      const ptyId = instance.ptyId
      if (!ptyId) throw new Error("shell PTY missing")
      await writeTerminal(api.origin, ptyId, "echo R09_SHELL_READY\r")
      await waitUntil(async () => {
        const attached = await attachTerminal(api.origin, ptyId)
        return Boolean(attached?.output.includes("R09_SHELL_READY"))
      }, 10_000, "interactive shell accepted input")
      await writeTerminal(api.origin, ptyId, `export PATH="${binDir}:$PATH"\r`)
      await writeTerminal(
        api.origin,
        ptyId,
        `"${claudeBin}" "${MOCK_AGENT_PATH}" --mode delayed-exit --delay-ms 2500 --control-file "${controlFile}"\r`,
      )
      const agent = await waitForMockAgent(controlFile)
      await waitUntil(async () => {
        const current = await instanceById(api.origin, project.id, instance.id)
        return current?.provider === "claude"
      }, 15_000, "shell-launched claude promoted")
      await waitUntil(() => {
        try {
          process.kill(agent.pid, 0)
          return false
        } catch {
          return true
        }
      }, 10_000, "shell agent exited")
      await writeTerminal(api.origin, ptyId, "echo R09_BACK\r")
      await waitUntil(async () => {
        const current = await instanceById(api.origin, project.id, instance.id)
        return current?.provider == null && current?.processState === "running"
      }, 20_000, "agent demoted to terminal")
      const current = await instanceById(api.origin, project.id, instance.id)
      expect(current?.ptyId).toBe(ptyId)
      expect(current?.processState).toBe("running")
    })
  })

  test("R10 stale telemetry from an old generation is ignored", async ({}, testInfo) => {
    await withHarness(testInfo, async harness => {
      const api = await harness.startApi()
      await harness.startSupervisor()
      const project = (await listProjects(api.origin))[0]!
      const launched = await launchProvider(api.origin, project, path.join(harness.root, "r10.json"), {
        provider: "claude",
        title: "R10",
        restartPolicy: "resume-on-daemon-start",
      })
      await ingestNative(api.origin, {
        provider: "claude",
        sessionId: launched.instance.id,
        processId: launched.ptyId,
        payload: {
          hook_event_name: "SessionStart",
          session_id: "claude-native-r10",
          source: "startup",
        },
      })
      const oldPty = launched.ptyId
      const restarted = await restartDaemon(harness)
      await waitUntil(async () => {
        const current = await instanceById(restarted.origin, project.id, launched.instance.id)
        return Boolean(current && current.generation > launched.instance.generation && current.ptyId)
      }, 20_000, "resumed generation")
      await ingestNative(restarted.origin, {
        provider: "claude",
        sessionId: launched.instance.id,
        processId: oldPty,
        payload: {
          hook_event_name: "PermissionRequest",
          session_id: "claude-native-r10",
          permission_id: "stale-perm",
          tool_name: "Bash",
        },
      })
      const current = await instanceById(restarted.origin, project.id, launched.instance.id)
      expect(current?.activityState).not.toBe("waiting_for_permission")
      expect(current?.ptyId).not.toBe(oldPty)
    })
  })
})
