#!/usr/bin/env node
class ChunkQueue {
  chunks = []
  head = 0
  waiters = []
  closed = false
  push(chunk) {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value: chunk, done: false })
    else this.chunks.push(chunk)
  }
  close() {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true })
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      const chunk = this.chunks[this.head]
      if (chunk) {
        this.head += 1
        if (this.head >= 64 && this.head * 2 >= this.chunks.length) {
          this.chunks.splice(0, this.head)
          this.head = 0
        }
        yield chunk
        continue
      }
      if (this.closed) return
      const next = await new Promise(resolve => this.waiters.push(resolve))
      if (next.done) return
      yield next.value
    }
  }
}

import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import { Decoder, Encoder } from "@msgpack/msgpack"

const binary = process.env.YAADE_NVIM_BIN?.trim() || "nvim"
const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-nvim-compat-"))
const endpoint = path.join(root, "nvim.sock")
const encoder = new Encoder()
const queue = new ChunkQueue()
const decoder = new Decoder({ maxArrayLength: 4096, maxMapLength: 4096, maxStrLength: 2 * 1024 * 1024, maxBinLength: 2 * 1024 * 1024 })
const pending = new Map()
const flushWaiters = []
const flushMessages = []
let stderr = ""
let nextId = 1
let redrawCount = 0
let child
let socket

function fail(message) {
  throw new Error(`[neovim-compat] ${message}`)
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function withTimeout(promise, label, timeoutMs = 5_000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs)),
  ])
}

function isRedrawFlush(message) {
  if (!Array.isArray(message) || message[0] !== 2 || message[1] !== "redraw" || !Array.isArray(message[2])) return false
  return message[2].some(event => Array.isArray(event) && event[0] === "flush")
}

function visibleText(message) {
  if (!Array.isArray(message) || message[0] !== 2 || message[1] !== "redraw" || !Array.isArray(message[2])) return ""
  let result = ""
  for (const event of message[2]) {
    if (!Array.isArray(event) || event[0] !== "grid_line") continue
    for (let groupIndex = 1; groupIndex < event.length; groupIndex += 1) {
      const args = Array.isArray(event[groupIndex]) ? event[groupIndex] : []
      const cells = Array.isArray(args[3]) ? args[3] : []
      for (const cell of cells) {
        if (Array.isArray(cell) && typeof cell[0] === "string") result += cell[0]
      }
    }
  }
  return result
}

async function connect() {
  const started = Date.now()
  while (Date.now() - started < 5_000) {
    try {
      return await new Promise((resolve, reject) => {
        const candidate = net.createConnection({ path: endpoint })
        const timer = setTimeout(() => {
          candidate.destroy()
          reject(new Error("socket connection timed out"))
        }, 500)
        candidate.once("connect", () => {
          clearTimeout(timer)
          candidate.setNoDelay(true)
          resolve(candidate)
        })
        candidate.once("error", error => {
          clearTimeout(timer)
          candidate.destroy()
          reject(error)
        })
      })
    } catch {
      await wait(25)
    }
  }
  fail("Neovim did not open its private socket")
}

function send(message) {
  socket.write(encoder.encode(message))
}

function request(method, args = []) {
  const id = nextId++
  send([0, id, method, args])
  return withTimeout(new Promise((resolve, reject) => pending.set(id, { resolve, reject })), method)
}

async function waitForFlush(predicate = () => true) {
  const queuedIndex = flushMessages.findIndex(predicate)
  if (queuedIndex >= 0) return flushMessages.splice(queuedIndex, 1)[0]
  return withTimeout(new Promise(resolve => flushWaiters.push({ predicate, resolve })), "redraw flush")
}

async function main() {
  fs.chmodSync(root, 0o700)
  child = spawn(binary, ["--headless", "--clean", "--listen", endpoint], {
    cwd: root,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
    },
    stdio: ["ignore", "ignore", "pipe"],
  })
  child.stderr?.on("data", chunk => { stderr = `${stderr}${String(chunk)}`.slice(-4096) })
  child.once("error", error => fail(`could not start ${binary}: ${error.message}`))
  socket = await connect()
  socket.on("data", chunk => queue.push(new Uint8Array(chunk)))
  socket.once("close", () => queue.close())
  void (async () => {
    for await (const message of decoder.decodeStream(queue)) {
      if (Array.isArray(message) && message[0] === 1) {
        const entry = pending.get(message[1])
        if (!entry) continue
        pending.delete(message[1])
        if (message[2] !== null && message[2] !== false && message[2] !== undefined) entry.reject(new Error(String(message[2])))
        else entry.resolve(message[3])
      } else if (isRedrawFlush(message)) {
        redrawCount += 1
        const waiterIndex = flushWaiters.findIndex(waiter => waiter.predicate(message))
        if (waiterIndex >= 0) {
          const waiter = flushWaiters.splice(waiterIndex, 1)[0]
          waiter?.resolve(message)
        } else {
          flushMessages.push(message)
          if (flushMessages.length > 16) flushMessages.shift()
        }
      }
    }
  })().catch(error => {
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
  })

  const api = await request("nvim_get_api_info")
  if (!Array.isArray(api) || !api[1] || typeof api[1] !== "object") fail("malformed nvim_get_api_info response")
  const metadata = api[1]
  const version = metadata.version
  if (!version || version.major !== 0 || version.minor < 10) fail(`unsupported Neovim version ${JSON.stringify(version)}`)
  const functions = new Set((metadata.functions ?? []).map(item => typeof item === "string" ? item : item?.name).filter(Boolean))
  const events = new Set((metadata.ui_events ?? []).map(item => typeof item === "string" ? item : item?.name).filter(Boolean))
  for (const method of ["nvim_ui_attach", "nvim_ui_try_resize", "nvim_input", "nvim_ui_set_focus"]) if (!functions.has(method)) fail(`missing method ${method}`)
  for (const event of ["grid_resize", "grid_line", "grid_cursor_goto", "flush"]) if (!events.has(event)) fail(`missing UI event ${event}`)

  await request("nvim_set_client_info", ["yaade-compat", { major: 0, minor: 2, patch: 0, prerelease: true }, "ui", {}, { website: "local" }])
  const initialRedraw = waitForFlush()
  await request("nvim_ui_attach", [80, 24, { rgb: true, ext_linegrid: true, ext_hlstate: true, ext_multigrid: false }])
  await initialRedraw
  send([2, "nvim_input", ["i界<Esc>"]])
  const inputRedraw = await waitForFlush(message => visibleText(message).includes("界"))
  if (!visibleText(inputRedraw).includes("界")) {
    console.error("[neovim-compat] redraw sample", JSON.stringify(inputRedraw).slice(0, 2_000))
    fail("Unicode input did not appear in linegrid redraw")
  }
  const resizeRedraw = waitForFlush()
  await request("nvim_ui_try_resize", [100, 30])
  await resizeRedraw
  await request("nvim_ui_set_focus", [false])
  await request("nvim_ui_set_focus", [true])
  if (functions.has("nvim_ui_detach")) await request("nvim_ui_detach")
  console.log(JSON.stringify({ binary, version: `${version.major}.${version.minor}.${version.patch ?? 0}`, redraws: redrawCount, unicode: true, resized: true, focused: true }))
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  if (stderr) console.error(stderr)
  process.exitCode = 1
} finally {
  socket?.destroy()
  if (child && child.exitCode === null) child.kill("SIGTERM")
  await new Promise(resolve => setTimeout(resolve, 50))
  fs.rmSync(root, { recursive: true, force: true })
}

