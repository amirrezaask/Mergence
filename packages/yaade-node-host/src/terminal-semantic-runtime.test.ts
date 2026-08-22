import assert from "node:assert/strict"
import { pathToFileURL } from "node:url"
import { test } from "vite-plus/test"
import { applyTerminalSemanticPatch, type TerminalSemanticPatch, type TerminalSemanticSnapshot } from "@yaade/rpc"
import { TerminalHost } from "./terminal.js"
import { TerminalSemanticRuntime } from "./terminal-semantic-runtime.js"
import { fixtureLaunch } from "./test-support/runtime-harness.js"

test("semantic realtime updates send an initial snapshot followed by row patches", async () => {
  const updates: Array<TerminalSemanticSnapshot | TerminalSemanticPatch> = []
  let runtime: TerminalSemanticRuntime | undefined
  runtime = TerminalSemanticRuntime.start({
    cols: 40,
    rows: 8,
    terminalEpoch: "epoch-1",
    writeToPty: () => undefined,
    onRevision: () => {
      const update = runtime?.takeUpdate()
      if (update) updates.push(update)
    },
  })
  try {
    await runtime.ready()
    await new Promise(resolve => setTimeout(resolve, 30))
    runtime.feedOutput("first line")
    await new Promise(resolve => setTimeout(resolve, 30))
    runtime.feedOutput(" second")
    await new Promise(resolve => setTimeout(resolve, 30))

    const initial = updates[0]
    assert.ok(initial && !("baseRevision" in initial))
    let applied: TerminalSemanticSnapshot = initial
    const patches = updates.slice(1)
    assert.ok(patches.length >= 2)
    for (const update of patches) {
      assert.ok("baseRevision" in update)
      assert.equal(update.terminalEpoch, "epoch-1")
      assert.equal(update.baseRevision, applied.revision)
      assert.ok(update.changedRows.length < initial.screenRows.length)
      const next = applyTerminalSemanticPatch(applied, "epoch-1", update)
      assert.ok(next)
      applied = next
    }
    assert.match(
      applied.screenRows.map(row => row.cells.map(value => value.text).join("")).join("\n"),
      /first line second/,
    )
  } finally {
    runtime.dispose()
  }
})

test("Ghostty answers DA1 once and exposes alternate-screen snapshots", async () => {
  const terminal = new TerminalHost({ semanticState: true })
  try {
    const created = terminal.create(
      pathToFileURL(process.cwd()).href,
      fixtureLaunch("query-response-probe.mjs"),
      "semantic-client",
    )
    await terminal.waitForSemantic(created.id)
    const deadline = Date.now() + 5_000
    let output = ""
    while (Date.now() < deadline) {
      const attached = terminal.attach(created.id, "semantic-client")
      output = attached?.outputChunks.join("") ?? ""
      if (output.includes("QUERY_RESPONSE_0=")) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    const snapshot = terminal.readSemanticSnapshot(created.id)
    assert.ok(snapshot)
    assert.equal(snapshot.schemaVersion, 1)
    assert.ok(snapshot.revision >= 1)
    const da1Answers = output.match(/QUERY_RESPONSE_0=/g) ?? []
    assert.equal(da1Answers.length, 1, `expected one DA1 answer, got ${JSON.stringify(output)}`)
  } finally {
    terminal.stopAll()
  }
})

test("current semantic owners continue parsing output beyond the legacy replay cap", async () => {
  const terminal = new TerminalHost({ semanticState: true })
  try {
    const created = terminal.create(
      pathToFileURL(process.cwd()).href,
      fixtureLaunch("output-flood.mjs", [
        "--bytes",
        String(11 * 1024 * 1024),
        "--marker",
        "SEMANTIC_LARGE_OUTPUT",
      ]),
      "large-semantic-client",
    )
    await terminal.waitForExit(created.id)
    await terminal.waitForSemantic(created.id)
    const snapshot = terminal.readSemanticSnapshot(created.id)
    assert.ok(snapshot)
    assert.ok(snapshot.revision > 0)
    const attached = terminal.attach(created.id, "large-semantic-client")
    assert.equal(attached?.semanticSnapshot?.revision, snapshot.revision)
  } finally {
    terminal.stopAll()
  }
})

test("semantic terminals restore alternate-screen content without parsing in the host RPC layer", async () => {
  const terminal = new TerminalHost({ semanticState: true })
  try {
    const created = terminal.create(
      pathToFileURL(process.cwd()).href,
      fixtureLaunch("alternate-screen.mjs"),
      "alt-client",
    )
    await terminal.waitForSemantic(created.id)
    const deadline = Date.now() + 3_000
    let snapshot = terminal.readSemanticSnapshot(created.id)
    const screenText = (value: typeof snapshot) =>
      value?.screenRows.map(row => row.cells.map(cell => cell.text).join("")).join("\n") ?? ""
    while (Date.now() < deadline) {
      snapshot = terminal.readSemanticSnapshot(created.id)
      if (snapshot?.activeScreen === "alternate" && /YAADE ALTERNATE SCREEN/.test(screenText(snapshot))) {
        break
      }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(snapshot?.activeScreen, "alternate")
    assert.match(screenText(snapshot), /YAADE ALTERNATE SCREEN/)
    const history = terminal.readSemanticHistory(created.id, 0, 4)
    assert.ok(history)
    assert.ok(history.total >= 0)
  } finally {
    terminal.stopAll()
  }
})
