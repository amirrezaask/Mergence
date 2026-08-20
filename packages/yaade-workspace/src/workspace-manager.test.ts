import { describe, it } from "vite-plus/test"
import assert from "node:assert/strict"
import { pathToFileUri } from "@yaade/shared"
import type { FileSystemProvider, WorkspaceEntry } from "./types.js"
import { WorkspaceManager, isPathUnderRoot, normalizeAbsPath } from "./workspace-manager.js"
import { WorkspaceService } from "./workspace.js"

function mockFs(entries: Record<string, WorkspaceEntry[]> = {}): FileSystemProvider {
  return {
    readFile: async () => "",
    writeFile: async () => {},
    readDir: async uri => entries[uri] ?? [],
    stat: async uri => ({ uri, isDirectory: false, size: 0 }),
  }
}

describe("WorkspaceManager", () => {
  it("addFolder dedupes by path and sets active", async () => {
    const mgr = new WorkspaceManager(mockFs())
    const a = await mgr.addFolder("/proj/a")
    const b = await mgr.addFolder("/proj/a")
    assert.equal(a.id, b.id)
    assert.equal(mgr.folders.length, 1)
    assert.equal(mgr.activeFolder?.id, a.id)
  })

  it("addFolder allows multiple roots", async () => {
    const mgr = new WorkspaceManager(mockFs())
    await mgr.addFolder("/proj/a")
    await mgr.addFolder("/proj/b")
    assert.equal(mgr.folders.length, 2)
  })

  it("folderStateForUri resolves nested files", async () => {
    const rootUri = pathToFileUri("/proj/a")
    const fileUri = pathToFileUri("/proj/a/src/index.ts")
    const mgr = new WorkspaceManager(mockFs())
    await mgr.addFolder("/proj/a")
    const state = mgr.folderStateForUri(fileUri)
    assert.ok(state)
    assert.equal(state.root.uri, rootUri)
  })

  it("folderStateForUri prefers deepest root when folders nest", async () => {
    const mgr = new WorkspaceManager(mockFs())
    await mgr.addFolder("/proj")
    await mgr.addFolder("/proj/child")
    const state = mgr.folderStateForUri(pathToFileUri("/proj/child/src/a.ts"))
    assert.ok(state)
    assert.equal(state.root.path, "/proj/child")
  })

  it("removeFolder rejects when dirty files exist", async () => {
    const mgr = new WorkspaceManager(mockFs())
    const folder = await mgr.addFolder("/proj/a")
    const state = mgr.folderStateForId(folder.id)!
    const uri = pathToFileUri("/proj/a/foo.ts")
    state.registerFile({
      uri,
      path: "/proj/a/foo.ts",
      name: "foo.ts",
      languageId: "typescript",
      isDirty: true,
    })
    assert.equal(mgr.removeFolder(folder.id), false)
    assert.equal(mgr.folders.length, 1)
  })

  it("replaceAllFolders clears previous roots", async () => {
    const mgr = new WorkspaceManager(mockFs())
    await mgr.addFolder("/proj/a")
    await mgr.addFolder("/proj/b")
    await mgr.replaceAllFolders("/proj/c")
    assert.equal(mgr.folders.length, 1)
    assert.equal(mgr.activeFolder?.root.path, "/proj/c")
  })
})

describe("WorkspaceService facade", () => {
  it("openWorkspace replaces folders and clears buffers", async () => {
    const mgr = new WorkspaceManager(mockFs())
    const ws = new WorkspaceService(mgr)
    await ws.addFolder("/proj/a")
    ws.touchBuffer(pathToFileUri("/proj/a/x.ts"))
    await ws.openWorkspace("/proj/b")
    assert.equal(ws.folders.length, 1)
    assert.equal(ws.openBuffers.length, 0)
    assert.equal(ws.root?.path, "/proj/b")
  })
})

describe("WorkspaceService foreign URI contract", () => {
  it("writeFile rejects URIs outside open folders", async () => {
    const mgr = new WorkspaceManager(mockFs())
    const ws = new WorkspaceService(mgr)
    await ws.addFolder("/proj/a")
    const foreign = pathToFileUri("/proj/b/foo.ts")
    await assert.rejects(() => ws.writeFile(foreign, "x"), /No workspace folder/)
  })

  it("createWorkspaceFile allows URIs outside open folders as external buffers", async () => {
    const mgr = new WorkspaceManager(mockFs())
    const ws = new WorkspaceService(mgr)
    await ws.addFolder("/proj/a")
    const foreign = pathToFileUri("/proj/b/foo.ts")
    const file = ws.createWorkspaceFile(foreign, "/proj/b/foo.ts")
    assert.equal(file.path, "/proj/b/foo.ts")
    assert.equal(ws.fileForUri(foreign)?.path, "/proj/b/foo.ts")
  })

  it("resolveRootUriForFile returns null for foreign file URIs", async () => {
    const mgr = new WorkspaceManager(mockFs())
    const ws = new WorkspaceService(mgr)
    await ws.addFolder("/proj/a")
    await ws.addFolder("/proj/b")
    ws.setActiveFolder(mgr.folders[1]!.id)
    const foreign = pathToFileUri("/proj/c/foo.ts")
    assert.equal(ws.resolveRootUriForFile(foreign), null)
  })

  it("resolveRootUriForFile uses sole folder for untitled URIs", async () => {
    const mgr = new WorkspaceManager(mockFs())
    const ws = new WorkspaceService(mgr)
    const folder = await ws.addFolder("/proj/a")
    assert.equal(ws.resolveRootUriForFile("untitled:1"), folder.root.uri)
  })

  it("dirty file blocks removal until saved", async () => {
    const mgr = new WorkspaceManager(mockFs())
    const ws = new WorkspaceService(mgr)
    const folder = await ws.addFolder("/proj/a")
    const uri = pathToFileUri("/proj/a/foo.ts")
    ws.createWorkspaceFile(uri, "/proj/a/foo.ts")
    ws.markDirty(uri, true)
    assert.equal(ws.removeFolder(folder.id), false)
    ws.clearDirtyState(uri)
    assert.equal(ws.removeFolder(folder.id), true)
  })
})

describe("path helpers", () => {
  it("isPathUnderRoot matches children", () => {
    assert.equal(isPathUnderRoot("/proj/a/src/x.ts", "/proj/a"), true)
    assert.equal(isPathUnderRoot("/proj/b/x.ts", "/proj/a"), false)
  })

  it("normalizeAbsPath strips trailing slash", () => {
    assert.equal(normalizeAbsPath("/proj/a/"), "/proj/a")
  })
})
