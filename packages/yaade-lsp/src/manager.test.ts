import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { pathToFileUri } from "@yaade/shared"
import type {
  LanguageServerDefinition,
  LspLifecycleEvent,
  LspStartResult,
  ResolvedLanguageServerTarget,
  WorkspaceFile,
} from "@yaade/workspace"
import { LanguageServerManager } from "./manager.js"

const workspaceRootUri = pathToFileUri("/work/project")

function target(
  serverId: string,
  projectRootUri = workspaceRootUri,
  languageIds: readonly string[] = ["typescript"],
): ResolvedLanguageServerTarget {
  return {
    serverId,
    projectRootUri,
    workspaceRootUri,
    languageIds,
    catalogVersion: 1,
  }
}

function definition(serverId: string, languages: readonly string[]): LanguageServerDefinition {
  return {
    id: serverId,
    languages,
    commandCandidates: [serverId],
    args: [],
    environment: {},
    candidateArgs: {},
    rootMarkers: [],
    priority: 0,
    enabled: true,
  }
}

function file(uri: string, languageId: string): WorkspaceFile {
  return {
    uri,
    path: uri,
    languageId,
    name: uri.split("/").at(-1) ?? uri,
    isDirty: false,
  }
}

describe("LanguageServerManager", () => {
  it("deduplicates host resolution by directory and concurrent process starts", async () => {
    let resolves = 0
    let starts = 0
    const resolved = target("gopls", workspaceRootUri, ["go"])
    const manager = new LanguageServerManager({
      async resolve() {
        resolves += 1
        await Promise.resolve()
        return resolved
      },
      async start(value) {
        starts += 1
        return { id: "gopls-1", transportUrl: "/ws/lsp/gopls-1", target: value }
      },
      async stop() {},
      async listDefinitions() { return [definition("gopls", ["go"])] },
    })
    const main = file(pathToFileUri("/work/project/src/main.go"), "go")
    const sibling = file(pathToFileUri("/work/project/src/other.go"), "go")

    const [first, second, third] = await Promise.all([
      manager.ensureServerForFile(main, workspaceRootUri),
      manager.ensureServerForFile(main, workspaceRootUri),
      manager.ensureServerForFile(sibling, workspaceRootUri),
    ])

    assert.equal(resolves, 1)
    assert.equal(starts, 1)
    assert.equal(first, second)
    assert.equal(second, third)
    assert.equal(first?.projectRootUri, workspaceRootUri)
  })

  it("stops every live server and releases host subscriptions", async () => {
    const stopped: string[] = []
    let crashListenerDisposed = false
    let lifecycleListenerDisposed = false
    const manager = new LanguageServerManager({
      async resolve(request) {
        return request.languageId === "go"
          ? target("gopls", workspaceRootUri, ["go"])
          : target("typescript-language-server")
      },
      async start(value) {
        return { id: `${value.serverId}-1`, transportUrl: `/ws/lsp/${value.serverId}-1`, target: value }
      },
      async stop(id) { stopped.push(id) },
      async listDefinitions() {
        return [
          definition("gopls", ["go"]),
          definition("typescript-language-server", ["typescript"]),
        ]
      },
      onCrashed() { return () => { crashListenerDisposed = true } },
      onLifecycle() { return () => { lifecycleListenerDisposed = true } },
    })

    await manager.ensureServerForFile(file(pathToFileUri("/work/project/index.ts"), "typescript"), workspaceRootUri)
    await manager.ensureServerForFile(file(pathToFileUri("/work/project/main.go"), "go"), workspaceRootUri)
    const ids = await manager.stopAll()
    manager.dispose()

    assert.deepEqual([...ids].sort(), ["gopls-1", "typescript-language-server-1"])
    assert.deepEqual([...stopped].sort(), [...ids].sort())
    assert.equal(manager.hasAnyConnection(), false)
    assert.equal(crashListenerDisposed, true)
    assert.equal(lifecycleListenerDisposed, true)
  })

  it("keeps language-server connections separate when the process cwd changes", async () => {
    const processCwds: string[] = []
    let starts = 0
    const manager = new LanguageServerManager({
      async resolve(request) {
        processCwds.push(request.processCwdUri ?? "")
        return {
          ...target("typescript-language-server"),
          processCwdUri: request.processCwdUri,
        }
      },
      async start(value) {
        starts += 1
        return {
          id: `ts-${starts}`,
          transportUrl: `/ws/lsp/ts-${starts}`,
          target: value,
        }
      },
      async stop() {},
      async listDefinitions() {
        return [definition("typescript-language-server", ["typescript"])]
      },
    })
    const document = file(pathToFileUri("/work/project/index.ts"), "typescript")
    const mainCwd = pathToFileUri("/work/project")
    const worktreeCwd = pathToFileUri("/work/worktree")

    const main = await manager.ensureServerForFile(document, workspaceRootUri, mainCwd)
    const worktree = await manager.ensureServerForFile(document, workspaceRootUri, worktreeCwd)

    assert.equal(starts, 2)
    assert.deepEqual(processCwds, [mainCwd, worktreeCwd])
    assert.notEqual(main?.id, worktree?.id)
    assert.equal(main?.projectRootUri, worktree?.projectRootUri)
    await manager.stopAll()
  })

  it("stops a deferred host start that resolves after teardown", async () => {
    const resolved = target("typescript-language-server")
    const deferred: { resolve(value: LspStartResult): void } = {
      resolve() { throw new Error("start was not requested") },
    }
    let announceStart: (() => void) | null = null
    const startCalled = new Promise<void>(resolve => { announceStart = resolve })
    const stopped: string[] = []
    const manager = new LanguageServerManager({
      async resolve() { return resolved },
      start: () => new Promise(resolve => {
        deferred.resolve = resolve
        announceStart?.()
      }),
      async stop(id) { stopped.push(id) },
      async listDefinitions() { return [definition("typescript-language-server", ["typescript"])] },
    })
    const pending = manager.ensureServerForFile(
      file(pathToFileUri("/work/project/src/index.ts"), "typescript"),
      workspaceRootUri,
    )

    await startCalled
    await manager.stopAll()
    manager.dispose()
    deferred.resolve({ id: "late-tsls", transportUrl: "/ws/lsp/late-tsls", target: resolved })

    assert.equal(await pending, null)
    assert.deepEqual(stopped, ["late-tsls"])
    assert.equal(manager.hasAnyConnection(), false)
  })

  it("replaces the exact failed connection when the host retry becomes ready", async () => {
    const listeners = new Set<(event: LspLifecycleEvent) => void>()
    const resolved = target("typescript-language-server", pathToFileUri("/work/project/packages/a"))
    const manager = new LanguageServerManager({
      async resolve() { return resolved },
      async start(value) { return { id: "first", transportUrl: "/ws/lsp/first", target: value } },
      async stop() {},
      async listDefinitions() { return [definition("typescript-language-server", ["typescript"])] },
      onLifecycle(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    })
    await manager.ensureServerForFile(
      file(pathToFileUri("/work/project/packages/a/index.ts"), "typescript"),
      workspaceRootUri,
    )
    for (const listener of listeners) listener({
      kind: "crashed",
      timestamp: 1,
      serverId: resolved.serverId,
      projectRootUri: resolved.projectRootUri,
      sessionId: "first",
    })
    for (const listener of listeners) listener({
      kind: "ready",
      timestamp: 2,
      serverId: resolved.serverId,
      projectRootUri: resolved.projectRootUri,
      sessionId: "second",
      transportUrl: "/ws/lsp/second",
      target: { ...resolved, settings: { lint: false }, catalogVersion: 2 },
    })

    const replacement = manager.getConnection("typescript", resolved.projectRootUri)
    assert.equal(replacement?.id, "second")
    assert.equal(replacement?.catalogVersion, 2)
    assert.deepEqual(replacement?.settings, { lint: false })
  })
})
