import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"
import { ProjectDatabase } from "../persistence.js"
import { TerminalHost } from "@yaade/node-host"
import { createAgentDriverContext, createAgentDriverDetectionContext } from "./context.js"

function runtime(root: string) {
  return {
    config: { allowedRoots: [root], dataDir: root },
    terminal: {
      create: (
        _cwdUri: string,
        _command: { command: string; args: string[] },
        _owner: string,
      ) => ({ id: "terminal-1" }),
      write: () => undefined,
      dispose: () => undefined,
      readOutput: () => ({ output: "", truncated: false }),
      waitForExit: () => Promise.resolve({ exitCode: 0 }),
    },
    db: new ProjectDatabase(join(root, "agent-context.sqlite")),
  }
}

test("agent context is limited to the thread workspace and explicit roots", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yaade-agent-context-"))
  const workspace = join(dir, "workspace")
  const additional = join(dir, "additional")
  const sibling = join(dir, "sibling")
  await Promise.all([fs.mkdir(workspace), fs.mkdir(additional), fs.mkdir(sibling)])
  const workspaceUri = pathToFileURL(workspace).toString()
  const additionalUri = pathToFileURL(additional).toString()
  const siblingUri = pathToFileURL(sibling).toString()
  const context = createAgentDriverContext(runtime(dir), {
    threadId: "ath-context",
    cwdUri: workspaceUri,
    additionalRootUris: [additionalUri],
    getEditorBuffer: async () => null,
  })
  await context.workspace.assertAllowed(pathToFileURL(join(workspace, "ok.txt")).toString())
  await context.workspace.assertAllowed(pathToFileURL(join(additional, "ok.txt")).toString())
  await assert.rejects(
    context.workspace.assertAllowed(pathToFileURL(join(sibling, "secret.txt")).toString()),
    /Path not allowed/,
  )
  await assert.rejects(
    context.processSpawner.spawn({ command: process.execPath, args: ["-e", ""], cwdUri: siblingUri, env: {} }),
    /Path not allowed/,
  )
  symlinkSync(sibling, join(workspace, "escape"))
  await assert.rejects(
    context.workspace.assertAllowed(pathToFileURL(join(workspace, "escape", "secret.txt")).toString()),
    /Path not allowed/,
  )
  await assert.rejects(context.workspace.assertAllowed("https://example.test/not-a-file"), /Path not allowed/)
  rmSync(dir, { recursive: true, force: true })
})

test("host-owned command discovery resolves and probes without adapter process access", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yaade-agent-discovery-"))
  const host = runtime(dir)
  const cwdUri = pathToFileURL(dir).toString()
  const controller = new AbortController()
  const detection = createAgentDriverDetectionContext(host, { cwdUri, signal: controller.signal })
  assert.equal(await detection.commands.resolveExecutable(["/definitely/missing", process.execPath]), process.execPath)
  const version = await detection.commands.probe(process.execPath, ["--version"])
  assert.equal(version.exitCode, 0)
  assert.match(version.output, /^v\d+/)
  controller.abort()
  await assert.rejects(detection.commands.probe(process.execPath, ["--version"]), /aborted/)
  host.db.close()
  rmSync(dir, { recursive: true, force: true })
})

test("agent terminal contexts cap handles and dispose only their own handles", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yaade-agent-terminal-cap-"))
  const disposed: string[] = []
  let count = 0
  const host = runtime(dir)
  const context = createAgentDriverContext({
    ...host,
    terminal: {
      ...host.terminal,
      create: () => ({ id: `terminal-${++count}` }),
      dispose: id => { disposed.push(id) },
    },
  }, {
    threadId: "ath-terminal-cap",
    cwdUri: pathToFileURL(dir).toString(),
  })
  const handles = []
  for (let index = 0; index < 8; index += 1) {
    handles.push(await context.terminal.open({
      cwdUri: pathToFileURL(dir).toString(), command: "echo", args: [],
    }))
  }
  await assert.rejects(
    context.terminal.open({ cwdUri: pathToFileURL(dir).toString(), command: "echo", args: [] }),
    /terminal limit is 8/,
  )
  await handles[0]!.close()
  await handles[0]!.close()
  assert.deepEqual(disposed, ["terminal-1"])
  await context.terminal.open({ cwdUri: pathToFileURL(dir).toString(), command: "echo", args: [] })
  host.db.close()
  rmSync(dir, { recursive: true, force: true })
})

test("agent context cancellation forcibly disposes leaked terminal handles", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yaade-agent-terminal-cleanup-"))
  const disposed: string[] = []
  const abort = new AbortController()
  const host = runtime(dir)
  const context = createAgentDriverContext({
    ...host,
    terminal: {
      ...host.terminal,
      create: () => ({ id: "leaked-terminal" }),
      dispose: id => { disposed.push(id) },
    },
  }, {
    threadId: "ath-terminal-cleanup",
    cwdUri: pathToFileURL(dir).toString(),
    signal: abort.signal,
  })
  await context.terminal.open({
    cwdUri: pathToFileURL(dir).toString(), command: "echo", args: [],
  })
  abort.abort()
  assert.deepEqual(disposed, ["leaked-terminal"])
  host.db.close()
  rmSync(dir, { recursive: true, force: true })
})

test("agent context cancellation forcibly stops a leaked provider process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yaade-agent-process-cleanup-"))
  const abort = new AbortController()
  const host = runtime(dir)
  const context = createAgentDriverContext(host, {
    threadId: "ath-process-cleanup",
    cwdUri: pathToFileURL(dir).toString(),
    signal: abort.signal,
  })
  const child = await context.processSpawner.spawn({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwdUri: pathToFileURL(dir).toString(),
    env: {},
  })
  abort.abort()
  const exit = await Promise.race([
    child.wait(),
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("agent process cleanup timed out")), 5_000)
      timer.unref()
    }),
  ])
  assert.equal(exit.signal, "SIGKILL")
  await assert.rejects(
    context.processSpawner.spawn({
      command: process.execPath,
      args: ["-e", ""],
      cwdUri: pathToFileURL(dir).toString(),
      env: {},
    }),
    /driver context is closed/,
  )
  host.db.close()
  rmSync(dir, { recursive: true, force: true })
})

test("agent context reads dirty editor buffers and rejects conflicting writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yaade-agent-context-write-"))
  const uri = pathToFileURL(join(dir, "note.txt")).toString()
  await fs.writeFile(join(dir, "note.txt"), "on disk")
  const untracked = createAgentDriverContext(runtime(dir), { threadId: "ath-write", cwdUri: pathToFileURL(dir).toString() })
  await assert.rejects(
    untracked.filesystem.writeFile(uri, new TextEncoder().encode("new")),
    /authoritative editor buffer conflict checks/,
  )
  const dirty = createAgentDriverContext(runtime(dir), {
    threadId: "ath-write",
    cwdUri: pathToFileURL(dir).toString(),
    getEditorBuffer: async () => new TextEncoder().encode("unsaved editor content"),
  })
  assert.equal(
    new TextDecoder().decode(await dirty.filesystem.readFile(uri)),
    "unsaved editor content",
  )
  await assert.rejects(
    dirty.filesystem.writeFile(uri, new TextEncoder().encode("new")),
    /dirty editor buffer/,
  )
  const emptyDirty = createAgentDriverContext(runtime(dir), {
    threadId: "ath-write-empty",
    cwdUri: pathToFileURL(dir).toString(),
    getEditorBuffer: async () => new Uint8Array(),
  })
  assert.equal((await emptyDirty.filesystem.readFile(uri)).byteLength, 0)
  await assert.rejects(
    emptyDirty.filesystem.writeFile(uri, new TextEncoder().encode("new")),
    /dirty editor buffer/,
  )
  const clean = createAgentDriverContext(runtime(dir), {
    threadId: "ath-write",
    cwdUri: pathToFileURL(dir).toString(),
    getEditorBuffer: async () => null,
  })
  await clean.filesystem.writeFile(uri, new TextEncoder().encode("written"))
  assert.equal(await fs.readFile(join(dir, "note.txt"), "utf8"), "written")
  rmSync(dir, { recursive: true, force: true })
})

test("agent context uses the durable project-session editor buffer as its live source", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yaade-agent-context-recovery-"))
  const workspace = join(dir, "workspace")
  await fs.mkdir(workspace)
  const host = runtime(dir)
  const session = host.db.createProjectSession({
    machine: "test-host",
    projectPath: workspace,
    cwdPath: workspace,
    title: "Editor integration",
  })
  const filePath = join(workspace, "note.txt")
  const uri = pathToFileURL(filePath).toString()
  await fs.writeFile(filePath, "disk version")
  host.db.upsertEditorRecoveryBuffer({
    sessionId: session.id,
    uri,
    content: "dirty editor version",
    baseVersion: null,
    languageId: "plaintext",
  })
  const context = createAgentDriverContext(host, {
    threadId: "ath-recovery",
    cwdUri: pathToFileURL(workspace).toString(),
    projectRootUri: pathToFileURL(workspace).toString(),
    getEditorBuffer: async target => {
      const buffer = host.db.getEditorRecoveryBuffer(session.id, target)
      return buffer ? new TextEncoder().encode(buffer.content) : null
    },
  })
  assert.equal(
    new TextDecoder().decode(await context.filesystem.readFile(uri)),
    "dirty editor version",
  )
  await assert.rejects(
    context.filesystem.writeFile(uri, new TextEncoder().encode("agent version")),
    /dirty editor buffer/,
  )
  host.db.deleteEditorRecoveryBuffer(session.id, uri)
  await context.filesystem.writeFile(uri, new TextEncoder().encode("agent version"))
  assert.equal(await fs.readFile(filePath, "utf8"), "agent version")
  host.db.close()
  rmSync(dir, { recursive: true, force: true })
})

test("agent credential broker exposes only explicitly mapped environment variables", async () => {
  const original = process.env.JET_AGENT_CREDENTIALS
  const originalToken = process.env.YAADE_TEST_TOKEN
  const originalSecret = process.env.YAADE_TEST_SECRET
  process.env.JET_AGENT_CREDENTIALS = "provider-token=YAADE_TEST_TOKEN"
  process.env.YAADE_TEST_TOKEN = "allowed"
  process.env.YAADE_TEST_SECRET = "hidden"
  try {
    const dir = mkdtempSync(join(tmpdir(), "yaade-agent-context-credential-"))
    const context = createAgentDriverContext(runtime(dir), {
      threadId: "ath-credentials",
      cwdUri: pathToFileURL(dir).toString(),
    })
    assert.equal(await context.credentials.get("provider-token"), "allowed")
    assert.equal(await context.credentials.get("YAADE_TEST_SECRET"), undefined)
    rmSync(dir, { recursive: true, force: true })
  } finally {
    if (original === undefined) delete process.env.JET_AGENT_CREDENTIALS
    else process.env.JET_AGENT_CREDENTIALS = original
    if (originalToken === undefined) delete process.env.YAADE_TEST_TOKEN
    else process.env.YAADE_TEST_TOKEN = originalToken
    if (originalSecret === undefined) delete process.env.YAADE_TEST_SECRET
    else process.env.YAADE_TEST_SECRET = originalSecret
  }
})

test("agent terminal bridge reads bounded output and waits for exit without attaching", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yaade-agent-terminal-"))
  const db = new ProjectDatabase(join(dir, "agent-terminal.sqlite"))
  const terminal = new TerminalHost()
  const context = createAgentDriverContext({ config: { allowedRoots: [dir], dataDir: dir }, terminal, db }, {
    threadId: "ath-terminal", cwdUri: pathToFileURL(dir).toString(),
  })
  const handle = await context.terminal.open({ cwdUri: pathToFileURL(dir).toString(), command: "/bin/echo", args: ["bridge-output"] })
  assert.deepEqual(await handle.waitForExit(), { exitCode: 0 })
  const output = await handle.readOutput()
  assert.equal(output.truncated, false)
  assert.match(output.output, /bridge-output/)
  await handle.close()
  terminal.stopAll(); db.close(); rmSync(dir, { recursive: true, force: true })
})
