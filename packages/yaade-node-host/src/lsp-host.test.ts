import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { Effect } from "effect"
import { LspResolveRequest } from "@yaade/rpc"
import { pathToFileUri } from "@yaade/shared"
import { LspHost, makeLspHostScoped } from "./lsp-host.js"

type Fixture = {
  readonly home: string
  readonly workspace: string
  readonly project: string
  readonly file: string
  readonly configPath: string
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-lsp-host-"))
  const home = path.join(root, "home")
  const workspace = path.join(root, "workspace")
  const project = path.join(workspace, "packages", "core")
  const file = path.join(project, "src", "main.acme")
  const configPath = path.join(home, ".yaade", "yaaderc.json")
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, "main")
  fs.writeFileSync(path.join(project, "acme.json"), "{}")
  return { home, workspace, project, file, configPath }
}

function writeConfig(
  target: Fixture,
  options: {
    readonly args?: readonly string[]
    readonly settings?: unknown
    readonly rootMarkers?: readonly string[]
  } = {},
): void {
  fs.writeFileSync(target.configPath, JSON.stringify({
    languageServers: [{
      id: "acme-lsp",
      languages: ["acme"],
      commandCandidates: [process.execPath],
      args: options.args ?? ["--version"],
      environment: { ACME_SECRET: "not-for-the-browser" },
      rootMarkers: options.rootMarkers ?? ["acme.workspace", "acme.json"],
      priority: 100,
      settings: options.settings ?? { acme: { lint: true } },
    }],
  }))
}

function resolveRequest(target: Fixture, processCwdPath?: string): LspResolveRequest {
  return LspResolveRequest.make({
    languageId: "acme",
    fileUri: pathToFileUri(target.file),
    workspaceRootUri: pathToFileUri(target.workspace),
    ...(processCwdPath ? { processCwdUri: pathToFileUri(processCwdPath) } : {}),
  })
}

describe("LspHost", () => {
  it("resolves nested roots on the host and caches positive directory results", async () => {
    const target = fixture()
    writeConfig(target)
    const host = await LspHost.create({
      homeDir: target.home,
      allowedRoots: [target.workspace],
      watchConfig: false,
    })
    try {
      const first = await host.resolve(resolveRequest(target))
      const second = await host.resolve(resolveRequest(target))
      assert.equal(first?.serverId, "acme-lsp")
      assert.equal(first?.projectRootUri, pathToFileUri(fs.realpathSync(target.project)))
      assert.deepEqual(second, first)
      assert.equal(host.diagnosticsForTests().rootProbeCount, 1)
      assert.equal(host.listDefinitions().find(definition => definition.id === "acme-lsp")?.environment.ACME_SECRET, undefined)
    } finally {
      host.dispose()
      fs.rmSync(path.dirname(target.home), { recursive: true, force: true })
    }
  })

  it("caches marker misses and invalidates when a marker file changes", async () => {
    const target = fixture()
    fs.rmSync(path.join(target.project, "acme.json"))
    writeConfig(target, { rootMarkers: ["acme.json"] })
    const host = await LspHost.create({
      homeDir: target.home,
      allowedRoots: [target.workspace],
      watchConfig: false,
    })
    try {
      assert.equal((await host.resolve(resolveRequest(target)))?.projectRootUri, pathToFileUri(fs.realpathSync(target.workspace)))
      await host.resolve(resolveRequest(target))
      assert.equal(host.diagnosticsForTests().rootProbeCount, 1)
      fs.writeFileSync(path.join(target.project, "acme.json"), "{}")
      host.invalidateForFile(pathToFileUri(path.join(target.project, "acme.json")))
      assert.equal((await host.resolve(resolveRequest(target)))?.projectRootUri, pathToFileUri(fs.realpathSync(target.project)))
      assert.equal(host.diagnosticsForTests().rootProbeCount, 2)
    } finally {
      host.dispose()
      fs.rmSync(path.dirname(target.home), { recursive: true, force: true })
    }
  })

  it("uses the resolved process cwd for the spawned language server", async () => {
    const target = fixture()
    writeConfig(target, { args: ["-e", "setInterval(() => {}, 1_000)"] })
    const host = await LspHost.create({
      homeDir: target.home,
      allowedRoots: [target.workspace],
      watchConfig: false,
    })
    try {
      const resolved = await host.resolve(resolveRequest(target, target.project))
      assert.equal(resolved?.processCwdUri, pathToFileUri(target.project))
      assert.ok(resolved)
      const started = await host.start(resolved)
      assert.equal(host.getSession(started.id)?.rootUri, pathToFileUri(target.project))
      await host.stop(started.id)
    } finally {
      host.dispose()
      fs.rmSync(path.dirname(target.home), { recursive: true, force: true })
    }
  })

  it("retains the last valid catalog and reports invalid hot reloads", async () => {
    const target = fixture()
    writeConfig(target)
    const events: string[] = []
    const host = await LspHost.create({
      homeDir: target.home,
      allowedRoots: [target.workspace],
      watchConfig: false,
      onLifecycle: event => events.push(event.kind),
    })
    try {
      fs.writeFileSync(target.configPath, "{invalid")
      await host.reloadConfig()
      assert.ok(host.listDefinitions().some(definition => definition.id === "acme-lsp"))
      assert.deepEqual(events, ["configuration-invalid"])
    } finally {
      host.dispose()
      fs.rmSync(path.dirname(target.home), { recursive: true, force: true })
    }
  })

  it("keeps built-ins available when the initial global configuration is invalid", async () => {
    const target = fixture()
    fs.writeFileSync(target.configPath, "{invalid")
    const events: string[] = []
    const host = await LspHost.create({
      homeDir: target.home,
      allowedRoots: [target.workspace],
      watchConfig: false,
      onLifecycle: event => events.push(event.kind),
    })
    try {
      assert.ok(host.listDefinitions().some(
        definition => definition.id === "typescript-language-server",
      ))
      assert.deepEqual(events, ["configuration-invalid"])
    } finally {
      host.dispose()
      fs.rmSync(path.dirname(target.home), { recursive: true, force: true })
    }
  })

  it("emits a settings-only change without changing process policy", async () => {
    const target = fixture()
    const keepAlive = ["-e", "setInterval(() => {}, 1_000)"]
    writeConfig(target, { args: keepAlive })
    const events: Array<{ readonly kind: string; readonly settingsOnly?: boolean }> = []
    const host = await LspHost.create({
      homeDir: target.home,
      allowedRoots: [target.workspace],
      watchConfig: false,
      onLifecycle: event => events.push(event),
    })
    try {
      const staleTarget = await host.resolve(resolveRequest(target))
      assert.ok(staleTarget)
      const initial = await host.start(staleTarget)
      writeConfig(target, {
        args: keepAlive,
        settings: { acme: { lint: false } },
      })
      await host.reloadConfig()
      assert.ok(events.some(event => event.kind === "configuration-changed" && event.settingsOnly === true))
      assert.deepEqual((await host.resolve(resolveRequest(target)))?.settings, { acme: { lint: false } })
      const started = await host.start(staleTarget)
      assert.equal(started.id, initial.id)
      assert.deepEqual(started.target.settings, { acme: { lint: false } })
      assert.ok(started.target.catalogVersion > staleTarget.catalogVersion)
      await host.stop(started.id)
    } finally {
      host.dispose()
      fs.rmSync(path.dirname(target.home), { recursive: true, force: true })
    }
  })

  it("stops stale roots and waits for documents to re-resolve after routing changes", async () => {
    const target = fixture()
    const keepAlive = ["-e", "setInterval(() => {}, 1_000)"]
    writeConfig(target, { args: keepAlive, rootMarkers: ["acme.json"] })
    const events: string[] = []
    const host = await LspHost.create({
      homeDir: target.home,
      allowedRoots: [target.workspace],
      watchConfig: false,
      restartBaseDelayMs: 1,
      onLifecycle: event => events.push(event.kind),
    })
    try {
      const resolved = await host.resolve(resolveRequest(target))
      assert.ok(resolved)
      const started = await host.start(resolved)
      assert.ok(host.getSession(started.id))

      fs.writeFileSync(path.join(target.workspace, "acme.workspace"), "{}")
      writeConfig(target, {
        args: keepAlive,
        rootMarkers: ["acme.workspace"],
      })
      await host.reloadConfig()
      await new Promise(resolve => setTimeout(resolve, 20))

      assert.equal(host.getSession(started.id), undefined)
      assert.equal(events.filter(event => event === "ready").length, 1)
      assert.ok(events.includes("configuration-changed"))
      assert.equal(
        (await host.resolve(resolveRequest(target)))?.projectRootUri,
        pathToFileUri(fs.realpathSync(target.workspace)),
      )
    } finally {
      host.dispose()
      fs.rmSync(path.dirname(target.home), { recursive: true, force: true })
    }
  })

  it("Effect scope finalization disposes the host", async () => {
    const target = fixture()
    writeConfig(target)
    const pair = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const host = yield* makeLspHostScoped({
        homeDir: target.home,
        allowedRoots: [target.workspace],
        watchConfig: false,
      })
      const resolved = yield* Effect.promise(() => host.resolve(resolveRequest(target)))
      return { host, resolved }
    })))
    assert.ok(pair.resolved)
    const afterDispose = await pair.host.start(pair.resolved)
    assert.match(afterDispose.error ?? "", /disposed/)
    fs.rmSync(path.dirname(target.home), { recursive: true, force: true })
  })
})
