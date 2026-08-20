import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import {
  clearTerminalCwdCaches,
  cwdOfPid,
  cwdOfPidSync,
  deepestDescendantPid,
  foregroundProcessOf,
} from "./terminal-cwd.js"

test("cwdOfPid rejects invalid pids", async () => {
  assert.equal(await cwdOfPid(0), null)
  assert.equal(await cwdOfPid(-1), null)
  assert.equal(await cwdOfPid(Number.NaN), null)
})

test("cwdOfPid resolves this process cwd on supported platforms", async () => {
  clearTerminalCwdCaches()
  if (process.platform !== "darwin" && process.platform !== "linux") {
    assert.equal(await cwdOfPid(process.pid), null)
    return
  }
  const cwd = await cwdOfPid(process.pid)
  assert.ok(cwd, "expected a cwd path")
  assert.equal(cwd, process.cwd())
})

test("cwdOfPid caches within TTL", async () => {
  clearTerminalCwdCaches()
  if (process.platform !== "darwin" && process.platform !== "linux") return
  const a = await cwdOfPid(process.pid)
  const b = await cwdOfPid(process.pid)
  assert.equal(a, b)
})

test("cwdOfPid still works when PATH hides lsof (Electron-like)", async () => {
  clearTerminalCwdCaches()
  if (process.platform !== "darwin") return
  const previous = process.env.PATH
  try {
    // Mimic GUI/Electron PATH: system bins only, no /usr/sbin → bare `lsof` ENOENT.
    process.env.PATH = "/usr/bin:/bin:/Applications/Yaade.app/Contents/MacOS"
    const cwd = await cwdOfPid(process.pid)
    assert.ok(cwd, "expected absolute lsof lookup to succeed")
    assert.equal(cwd, process.cwd())
  } finally {
    if (previous === undefined) delete process.env.PATH
    else process.env.PATH = previous
  }
})

test("cwdOfPidSync matches async on supported platforms", () => {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    assert.equal(cwdOfPidSync(process.pid), null)
    return
  }
  assert.equal(cwdOfPidSync(process.pid), process.cwd())
})

test("deepestDescendantPid walks to leaf child", () => {
  const rows = [
    { pid: 1, ppid: 0, comm: "init" },
    { pid: 10, ppid: 1, comm: "zsh" },
    { pid: 20, ppid: 10, comm: "nvim" },
    { pid: 30, ppid: 20, comm: "node" },
  ]
  assert.equal(deepestDescendantPid(10, rows), 30)
  assert.equal(deepestDescendantPid(20, rows), 30)
  assert.equal(deepestDescendantPid(1, rows), 30)
})

test("deepestDescendantPid returns root when alone", () => {
  assert.equal(deepestDescendantPid(42, [{ pid: 42, ppid: 1, comm: "zsh" }]), 42)
})

test("foregroundProcessOf resolves this process", async () => {
  clearTerminalCwdCaches()
  if (process.platform !== "darwin" && process.platform !== "linux") {
    assert.equal(await foregroundProcessOf(process.pid), null)
    return
  }
  const fg = await foregroundProcessOf(process.pid)
  assert.ok(fg)
  assert.ok(fg!.name.length > 0)
  assert.ok(fg!.pid > 0)
})
