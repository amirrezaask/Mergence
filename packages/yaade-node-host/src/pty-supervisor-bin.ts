#!/usr/bin/env node
import fs from "node:fs"
import { listenTerminalSupervisor } from "./terminal-supervisor.js"

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag)
  if (index < 0) return null
  return process.argv[index + 1] ?? null
}

const socketPath =
  argValue("--socket") ?? process.env.YAADE_PTY_SUPERVISOR_SOCKET
const pidPath = argValue("--pid-file")
const manifestPath = argValue("--manifest")
if (!socketPath) {
  console.error("pty-supervisor: --socket is required")
  process.exit(1)
}

if (pidPath) {
  fs.writeFileSync(pidPath, String(process.pid), "utf8")
}

const { close } = await listenTerminalSupervisor(socketPath, {
  onShutdown: () => process.exit(0),
  dataDir: process.env.YAADE_PTY_SUPERVISOR_DATA_DIR,
  ...(manifestPath ? { manifestPath } : {}),
})

const shutdown = () => {
  void close().finally(() => process.exit(0))
}

process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
