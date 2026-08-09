import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { AgentDriverContext } from "@yaade/agent-driver"
import { AgentCommandEnvelope } from "@yaade/agent-protocol"
import { runAgentDriverConformanceSuite } from "@yaade/agent-testkit"
import { Schema } from "effect"
import { InstantAgentClock, ManualAgentClock } from "./clock.js"
import { MockAgentDriver } from "./driver.js"
import { mockScenarios, permissionRaceScenario, requiredMockScenarioIds, simpleStreamScenario } from "./scenarios.js"

async function* emptyBytes(): AsyncIterable<Uint8Array> {
  return
}

function driverContext(): AgentDriverContext {
  return {
    workspace: {
      rootUri: "file:///workspace",
      additionalRoots: [],
      assertAllowed: () => Promise.resolve(),
    },
    filesystem: {
      readFile: () => Promise.resolve(new Uint8Array()),
      writeFile: () => Promise.resolve(),
      stat: () => Promise.resolve({ size: 0 }),
    },
    terminal: {
      open: () =>
        Promise.resolve({
          id: "terminal-1",
          write: () => Promise.resolve(),
          close: () => Promise.resolve(),
        }),
    },
    processSpawner: {
      spawn: () =>
        Promise.resolve({
          id: "process-1",
          stdout: emptyBytes(),
          stderr: emptyBytes(),
          writeStdin: () => Promise.resolve(),
          wait: () => Promise.resolve({ exitCode: 0 }),
          stop: () => Promise.resolve(),
        }),
    },
    commands: { resolveExecutable: async candidates => candidates[0], probe: async () => ({ exitCode: 0, output: "mock" }) },
    attachments: {
      resolve: () => Promise.reject(new Error("unused mock attachment resolver")),
      read: () => Promise.reject(new Error("unused mock attachment resolver")),
    },
    credentials: { get: () => Promise.resolve(undefined) },
    mcp: { listServers: () => Promise.resolve([]) },
    clock: new InstantAgentClock(),
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    signal: new AbortController().signal,
  }
}

function command(
  commandId: string,
  payload: unknown,
): AgentCommandEnvelope {
  return Schema.decodeUnknownSync(AgentCommandEnvelope)({
    protocolVersion: 1,
    commandId,
    threadId: "thread-1",
    issuedAt: "2026-01-01T00:00:00.000Z",
    command: payload,
  })
}

describe("canonical mock driver", () => {
  it("passes the shared driver conformance lifecycle", async () => {
    const report = await runAgentDriverConformanceSuite({
      driver: new MockAgentDriver(simpleStreamScenario),
      context: driverContext(),
      request: { mode: { type: "new" }, cwdUri: "file:///workspace" },
      command: command("conformance-command", {
        type: "turn.submit",
        input: [{ type: "text", text: "hello" }],
      }),
      expectedEventCount: 6,
    })

    assert.equal(report.passed, true, JSON.stringify(report.checks))
    assert.equal(report.eventTypes.at(-1), "turn.completed")
  })

  it("streams a deterministic scenario and deduplicates command ids", async () => {
    const driver = new MockAgentDriver(simpleStreamScenario)
    const connection = await driver.openThread(driverContext(), {
      mode: { type: "new" },
      cwdUri: "file:///workspace",
    })
    const envelope = command("command-1", {
      type: "turn.submit",
      input: [{ type: "text", text: "hello" }],
    })

    assert.deepEqual(await connection.send(envelope), {
      status: "accepted",
      commandId: "command-1",
    })
    assert.deepEqual(await connection.send(envelope), {
      status: "already-applied",
      commandId: "command-1",
    })

    const events = connection.events()[Symbol.asyncIterator]()
    const eventTypes: string[] = []
    for (let index = 0; index < 6; index += 1) {
      const next = await events.next()
      assert.equal(next.done, false)
      if (!next.done) eventTypes.push(next.value.event.type)
    }
    assert.deepEqual(eventTypes, [
      "turn.started",
      "item.started",
      "item.delta",
      "item.delta",
      "item.completed",
      "turn.completed",
    ])
    await connection.close("user")
  })

  it("rejects the wrong native permission option and accepts the advertised one", async () => {
    const driver = new MockAgentDriver(permissionRaceScenario)
    const connection = await driver.openThread(driverContext(), {
      mode: { type: "new" },
      cwdUri: "file:///workspace",
    })
    await connection.send(
      command("submit", {
        type: "turn.submit",
        input: [{ type: "text", text: "edit auth" }],
      }),
    )

    const rejected = await connection.send(
      command("bad-permission", {
        type: "action.respond",
        actionId: "mock-permission-1",
        response: { type: "permission", optionId: "allow-once" },
      }),
    )
    assert.equal(rejected.status, "rejected")

    const accepted = await connection.send(
      command("good-permission", {
        type: "action.respond",
        actionId: "mock-permission-1",
        response: { type: "permission", optionId: "native-allow-once" },
      }),
    )
    assert.equal(accepted.status, "accepted")
    await connection.close("user")
  })

  it("advances manual time without wall-clock sleeps", async () => {
    const clock = new ManualAgentClock(
      new Date("2026-01-01T00:00:00.000Z"),
    )
    let completed = false
    const sleep = clock.sleep(250).then(() => {
      completed = true
    })

    await clock.advanceBy(249)
    assert.equal(completed, false)
    await clock.advanceBy(1)
    await sleep
    assert.equal(completed, true)
    assert.equal(clock.now().toISOString(), "2026-01-01T00:00:00.250Z")
  })

  it("stops a blocked event iterator when its signal aborts", async () => {
    const driver = new MockAgentDriver(simpleStreamScenario)
    const connection = await driver.openThread(driverContext(), {
      mode: { type: "new" },
      cwdUri: "file:///workspace",
    })
    const controller = new AbortController()
    const iterator = connection.events(controller.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    controller.abort()

    assert.deepEqual(await pending, { done: true, value: undefined })
    await connection.close("user")
  })

  it("registers every required deterministic scenario and each one terminates", async () => {
    for (const id of requiredMockScenarioIds) {
      const scenario = mockScenarios[id]
      assert.ok(scenario, `missing ${id}`)
      const connection = await new MockAgentDriver(scenario).openThread(driverContext(), { mode: { type: "new" }, cwdUri: "file:///workspace" })
      if (id === "configuration-change" || id === "configuration-rejection") {
        const configured = await connection.send(command(`config-${id}`, {
          type: "configuration.set",
          optionId: "model",
          value: "mock-deep",
        }))
        assert.equal(configured.status, id === "configuration-change" ? "accepted" : "rejected")
      }
      const input = id === "attachments"
        ? [{ type: "attachment" as const, attachmentId: "mock-attachment", purpose: "context" as const }]
        : [{ type: "text" as const, text: id }]
      assert.equal((await connection.send(command(`scenario-${id}`, { type: "turn.submit", input }))).status, "accepted")
      const iterator = connection.events()[Symbol.asyncIterator]()
      let terminal = false
      for (let eventCount = 0; eventCount < 400 && !terminal; eventCount += 1) {
        const next = await iterator.next()
        assert.equal(next.done, false, `${id} ended before a terminal event`)
        if (next.done) break
        const event = next.value.event
        if (event.type === "action.requested") {
          const response = event.action.type === "elicitation"
            ? { type: "elicitation" as const, values: { name: "release", confirmed: true, region: "eu" } }
            : event.action.type === "authentication"
              ? { type: "authentication" as const, status: "completed" as const }
              : { type: "permission" as const, optionId: event.action.options[0]?.id ?? "" }
          assert.equal((await connection.send(command(`action-${id}`, {
            type: "action.respond",
            actionId: event.action.id,
            response,
          }))).status, "accepted")
        }
        if (id === "interrupt" && event.type === "item.delta") {
          assert.equal((await connection.send(command("interrupt-scenario", {
            type: "turn.interrupt",
            turnId: "mock-turn-1",
          }))).status, "accepted")
        }
        terminal = event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.interrupted"
      }
      assert.equal(terminal, true, `${id} did not reach a terminal event`)
      await connection.close("user")
    }
  })
})
