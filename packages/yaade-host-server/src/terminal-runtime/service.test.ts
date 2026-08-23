import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import { TerminalOutput } from "@yaade/rpc"
import { startHostHarness } from "../test-support/host-harness.js"

test("process exit updates terminals in an archived keep-running Session", async () => {
  const harness = await startHostHarness()
  try {
    const { muxSessions, terminalService } = harness.server.runtime
    const session = muxSessions.listSessions()[0]
    assert.ok(session)
    const created = muxSessions.createMuxTerminal({
      sessionId: session.id,
      kind: "terminal",
      title: "Background command",
      position: 0,
      input: { _tag: "TerminalInput", kind: "terminal" },
      output: TerminalOutput.make({
        kind: "process",
        terminalInstanceId: "instance-archived",
        ptyId: "pty-archived",
        generation: 1,
        processState: "running",
        activityState: "working",
        replayAvailable: true,
        truncated: false,
      }),
    })
    const running = muxSessions.compareAndSetMuxTerminal(
      created.id,
      created.revision,
      { status: "running" },
    )

    await terminalService.archiveSession(session.id, false)
    terminalService.onProcessExit("pty-archived", 17)

    const exited = muxSessions.getMuxTerminal(running.id)
    assert.equal(exited?.status, "failed")
    assert.equal(exited?.output.processState, "exited")
    assert.equal(exited?.output.exitCode, 17)
    assert.equal(exited?.error, "process exited with 17")
  } finally {
    await harness.close()
  }
})
