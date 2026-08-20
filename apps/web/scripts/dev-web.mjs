#!/usr/bin/env node
/**
 * Start only the web application.
 *
 * The host is a separate application. Run `vp run @yaade/server#dev` in another
 * terminal and point the Vite proxy at it with JET_PORT when it is not on the
 * default port.
 */
import os from "node:os"
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ensureLocalHostRegistration, LOCAL_HOSTNAME } from "./register-local-host.mjs"

function optionValue(name) {
  const inline = process.argv.find(arg => arg.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  return value && !value.startsWith("--") ? value : undefined
}

function isLoopbackHost(host) {
  return ["localhost", "127.0.0.1", "::1"].includes(
    host.trim().toLowerCase().replace(/^\[|\]$/g, ""),
  )
}

function formatUrlHost(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flatMap(infos => infos ?? [])
    .filter(info => !info.internal && (info.family === "IPv4" || info.family === 4))
    .map(info => info.address)
}

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const host = optionValue("--host") ?? process.env.JET_WEB_HOST ?? process.env.JET_HOST ?? "127.0.0.1"
const port = Number(process.env.JET_WEB_PORT ?? 5174)

if (process.env.JET_SKIP_LOCAL_HOST !== "1") {
  const registration = ensureLocalHostRegistration()
  if (registration.changed) console.log(`[dev-web] registered ${LOCAL_HOSTNAME} → 127.0.0.1`)
}

if (!isLoopbackHost(host)) {
  console.warn(`[dev-web] Vite is listening on ${host}; make sure the host is separately configured.`)
  const addresses = host === "0.0.0.0" || host === "::" ? lanAddresses() : [host]
  for (const address of addresses) {
    console.log(`[dev-web] URL: http://${formatUrlHost(address)}:${port}`)
  }
}

const vpBin = path.join(appDir, "node_modules", ".bin", process.platform === "win32" ? "vp.cmd" : "vp")
const vite = spawn(vpBin, ["dev", ...process.argv.slice(2)], {
  cwd: appDir,
  stdio: "inherit",
  env: {
    ...process.env,
    JET_WEB_HOST: host,
    JET_WEB_PORT: String(port),
  },
})

let stopping = false
function stop(signal) {
  if (stopping) return
  stopping = true
  vite.kill(signal)
}

process.on("SIGINT", () => stop("SIGINT"))
process.on("SIGTERM", () => stop("SIGTERM"))
vite.on("exit", (code, signal) => {
  if (signal && !stopping) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
