#!/usr/bin/env node
/**
 * Cross-platform deterministic agent fixture. Launch with `node mock-agent.mjs`
 * so Windows does not depend on a POSIX shebang.
 */
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"

const READY = "YAADE_MOCK_AGENT_READY"
const LINE = (n) => `YAADE_MOCK_N=${String(n).padStart(4, "0")}`

function argValue(flag) {
  const index = process.argv.indexOf(flag)
  if (index < 0) return null
  const value = process.argv[index + 1]
  return value && !value.startsWith("--") ? value : null
}

function hasFlag(flag) {
  return process.argv.includes(flag)
}

function writeJson(filePath, value) {
  if (!filePath) return
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  fs.renameSync(temporary, filePath)
}

const mode = argValue("--mode") ?? "idle"
const controlFile = argValue("--control-file")
const identityFile = argValue("--identity-file")
const exitCode = Number(argValue("--exit-code") ?? "0")
const delayMs = Number(argValue("--delay-ms") ?? "0")
const numberedFrom = Number(argValue("--from") ?? "1")
const numberedTo = Number(argValue("--to") ?? "0")
const numberedIntervalMs = Number(argValue("--interval-ms") ?? "20")

const children = []
let nextEcho = 1
let nextNumber = numberedFrom
let numberedTimer = null
let shuttingDown = false
const ignore = new Set()

if (hasFlag("--ignore-sighup") || mode === "ignore-sighup") ignore.add("SIGHUP")
if (hasFlag("--ignore-sigterm") || mode === "ignore-sigterm") ignore.add("SIGTERM")

function stdout(text) {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`)
}

function emitRange(from, to) {
  const start = Math.max(1, from)
  const end = Math.max(start - 1, to)
  for (let n = start; n <= end; n++) stdout(LINE(n))
  nextNumber = end + 1
  return { from: start, to: end }
}

function startNumbered(from, to, intervalMs) {
  stopNumbered()
  nextNumber = from
  const last = to > 0 ? to : Number.POSITIVE_INFINITY
  numberedTimer = setInterval(() => {
    if (nextNumber > last) {
      stopNumbered()
      return
    }
    stdout(LINE(nextNumber))
    nextNumber += 1
  }, Math.max(1, intervalMs))
  numberedTimer.unref?.()
}

function stopNumbered() {
  if (!numberedTimer) return
  clearInterval(numberedTimer)
  numberedTimer = null
}

function spawnChild(label) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], {
    stdio: "ignore",
    detached: false,
  })
  children.push(child)
  stdout(`YAADE_MOCK_CHILD ${label} pid=${child.pid}`)
  return child.pid ?? null
}

function applyMode(next) {
  switch (next) {
    case "numbered":
      startNumbered(numberedFrom, numberedTo, numberedIntervalMs)
      return
    case "flood":
      startNumbered(1, 0, 1)
      return
    case "unicode":
      stdout("YAADE_MOCK_UNICODE café  indéfini 😀")
      stdout("YAADE_MOCK_COMBINING e\u0301")
      return
    case "alt-screen":
      process.stdout.write("\x1b[?1049h\x1b[H\x1b[2J")
      stdout("YAADE_MOCK_ALT_SCREEN")
      process.stdout.write("\x1b[10;20HALT")
      return
    case "styles":
      process.stdout.write("\x1b[1;31mRED\x1b[0m \x1b[?25l")
      process.stdout.write("\x1b]0;yaade-mock\x07")
      process.stdout.write("\x1b]7;file://localhost/tmp/yaade-mock\x07")
      process.stdout.write("\x1b]133;A\x07")
      process.stdout.write("\x1b[6n")
      stdout("YAADE_MOCK_STYLES")
      return
    case "permission-wait":
      stdout("YAADE_MOCK_PERMISSION_REQUIRED id=perm-1")
      return
    case "session-ref":
      stdout(`YAADE_MOCK_NATIVE_SESSION provider=mock ref=${randomUUID()}`)
      return
    case "children":
      spawnChild("child")
      spawnChild("grandchild-parent")
      return
    case "delayed-exit":
      setTimeout(() => {
        process.stdout.write("\x1b]133;A\x07")
        shutdown(exitCode)
      }, Math.max(0, delayMs)).unref?.()
      return
    case "echo":
    case "idle":
    case "ignore-sighup":
    case "ignore-sigterm":
    case "resume":
    case "hooks":
      return
    default:
      stdout(`YAADE_MOCK_UNKNOWN_MODE ${next}`)
  }
}

function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  stopNumbered()
  for (const child of children) {
    try {
      child.kill("SIGKILL")
    } catch {
      /* already gone */
    }
  }
  stdout("YAADE_MOCK_AGENT_SHUTDOWN")
  server.close(() => process.exit(code))
  setTimeout(() => process.exit(code), 250).unref?.()
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1")
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }
  if (req.method === "GET" && url.pathname === "/health") {
    send(200, { ok: true, pid: process.pid, mode })
    return
  }
  if (req.method === "GET" && url.pathname === "/identity") {
    send(200, {
      pid: process.pid,
      mode,
      argv: process.argv,
      ignore: [...ignore],
    })
    return
  }
  const chunks = []
  req.on("data", (chunk) => chunks.push(chunk))
  req.on("end", () => {
    let body = {}
    if (chunks.length > 0) {
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      } catch {
        send(400, { error: "invalid json" })
        return
      }
    }
    if (req.method === "POST" && url.pathname === "/emit") {
      if (body.kind === "text") {
        stdout(String(body.text ?? ""))
        send(200, { ok: true })
        return
      }
      const from = Number(body.from ?? nextNumber)
      const to = Number(body.to ?? from)
      send(200, { ok: true, ...emitRange(from, to) })
      return
    }
    if (req.method === "POST" && url.pathname === "/numbered") {
      startNumbered(
        Number(body.from ?? 1),
        Number(body.to ?? 0),
        Number(body.intervalMs ?? 20),
      )
      send(200, { ok: true })
      return
    }
    if (req.method === "POST" && url.pathname === "/stop-numbered") {
      stopNumbered()
      send(200, { ok: true, nextNumber })
      return
    }
    if (req.method === "POST" && url.pathname === "/mode") {
      applyMode(String(body.mode ?? "idle"))
      send(200, { ok: true })
      return
    }
    if (req.method === "POST" && url.pathname === "/spawn-child") {
      send(200, { ok: true, pid: spawnChild(String(body.label ?? "child")) })
      return
    }
    if (req.method === "POST" && url.pathname === "/exit") {
      const code = Number(body.code ?? 0)
      const wait = Number(body.delayMs ?? 0)
      setTimeout(() => shutdown(code), Math.max(0, wait)).unref?.()
      send(200, { ok: true })
      return
    }
    send(404, { error: "unknown control path" })
  })
})

process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  if (mode !== "echo" && !hasFlag("--echo")) return
  for (const line of String(chunk).split(/\r?\n/)) {
    if (!line) continue
    stdout(`YAADE_MOCK_ECHO ${nextEcho} ${line}`)
    nextEcho += 1
  }
})

for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"]) {
  try {
    process.on(signal, () => {
      if (ignore.has(signal)) {
        stdout(`YAADE_MOCK_IGNORED ${signal}`)
        return
      }
      shutdown(signal === "SIGINT" ? 130 : 143)
    })
  } catch {
    /* Windows does not expose every POSIX signal. */
  }
}

server.listen(0, "127.0.0.1", () => {
  const address = server.address()
  const port = address && typeof address === "object" ? address.port : 0
  const identity = {
    pid: process.pid,
    ppid: process.ppid,
    mode,
    controlPort: port,
    startedAt: new Date().toISOString(),
  }
  writeJson(controlFile, identity)
  writeJson(identityFile, identity)
  stdout(`${READY} pid=${process.pid} control=${port} mode=${mode}`)
  if (hasFlag("--resume")) {
    if (hasFlag("--fail-resume")) {
      stdout("YAADE_MOCK_RESUME_FAILED")
      shutdown(1)
      return
    }
    stdout(`YAADE_MOCK_RESUMED ref=${argValue("--resume") ?? ""}`)
  }
  applyMode(mode)
  if (numberedTo >= numberedFrom && mode === "idle") {
    /* Control-driven tests emit later. */
  }
})
