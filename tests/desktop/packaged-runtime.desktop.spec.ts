import { expect, test } from "@playwright/test"
import { Schema } from "effect"
import {
  CreateToolUse,
  MainCheckout,
  ProjectTarget,
  SessionId,
  TerminalToolInput,
} from "../../packages/yaade-rpc/src/tool-session.js"
import { isProcessAlive } from "../../packages/yaade-node-host/src/process-identity.js"
import {
  createProject,
  createSession,
  createToolUse,
  listProjects,
  waitForAttach,
} from "../runtime/harness/index.js"
import {
  closePackagedDesktop,
  desktopDisplayAvailable,
  findPackagedExecutable,
  launchPackagedDesktop,
  processCommandLine,
  stopOwnedRuntime,
} from "./_launch.js"

test.describe("D06 — packaged Electron uses the detached supervisor", { tag: "@p0" }, () => {
  test.skip(!desktopDisplayAvailable(), "Electron desktop E2E needs a display")
  const packaged = findPackagedExecutable()
  test.skip(
    packaged == null,
    "packaged smoke artifact is missing; run vp run build:desktop && package first",
  )

  test("packaged mode does not disable the supervisor or kill PTYs on exit", async () => {
    const desktop = await launchPackagedDesktop(packaged!)
    try {
      let projects = await listProjects(desktop.origin)
      if (projects.length === 0) {
        await createProject(desktop.origin, desktop.workspace)
        projects = await listProjects(desktop.origin)
      }
      const project = projects[0]
      if (!project) throw new Error("packaged host has no project")
      const session = await createSession(desktop.origin, "D06")
      const created = await createToolUse(
        desktop.origin,
        CreateToolUse.make({
          sessionId: Schema.decodeUnknownSync(SessionId)(session.id),
          kind: "terminal",
          title: "D06",
          project: ProjectTarget.make({
            projectId: project.id,
            projectPath: project.rootPath,
            projectName: project.name,
          }),
          checkout: MainCheckout.make({ kind: "main" }),
          input: TerminalToolInput.make({
            kind: "terminal",
            executable: process.execPath,
            shellArgs: ["-e", "setInterval(() => undefined, 1e9)"],
          }),
        }),
      )
      const ptyId = created.output.ptyId
      if (!ptyId) throw new Error("packaged host created a terminal without a PTY")
      const attached = await waitForAttach(desktop.origin, ptyId)
      expect(attached.status).toBe("running")
      const args = processCommandLine(desktop.daemonPid)
      expect(args).not.toMatch(/--pty-supervisor(?:\s+|=)0\b/)
      expect(args).not.toMatch(/--kill-ptys-on-exit(?:\s+|=)1\b/)
      const daemonPid = desktop.daemonPid
      await closePackagedDesktop(desktop, { keepDaemon: true })
      expect(isProcessAlive(daemonPid)).toBe(true)
      const recovered = await waitForAttach(desktop.origin, ptyId)
      expect(recovered.status).toBe("running")
    } finally {
      await stopOwnedRuntime(desktop.userDataDir)
    }
  })
})
