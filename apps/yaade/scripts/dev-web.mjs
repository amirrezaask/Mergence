#!/usr/bin/env node
import os from "node:os"
import {
  DEFAULT_HOST,
  DEFAULT_HOST_PORT,
  DEFAULT_VITE_PORT,
  findAvailablePort,
  resolveAppDir,
  resolveRepoRoot,
  spawnHostServer,
  spawnVite,
  wireChildLifecycle,
} from "./spawn-backend.mjs"
import {
  ensureLocalHostRegistration,
  LOCAL_HOSTNAME,
} from "./register-local-host.mjs"

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

const appDir = resolveAppDir(import.meta.url)
const repoRoot = resolveRepoRoot(appDir)
if (process.env.JET_SKIP_LOCAL_HOST !== "1") {
  const registration = ensureLocalHostRegistration()
  if (registration.changed) {
    console.log(`[dev-web] registered ${LOCAL_HOSTNAME} → 127.0.0.1`)
  }
}
const host = optionValue("--host") ?? process.env.JET_HOST ?? DEFAULT_HOST
const preferredHostPort = Number(process.env.JET_PORT ?? DEFAULT_HOST_PORT)
const preferredVitePort = Number(process.env.JET_WEB_PORT ?? DEFAULT_VITE_PORT)

const hostPort = await findAvailablePort(host, preferredHostPort)
const vitePort = await findAvailablePort(host, preferredVitePort)

if (hostPort !== preferredHostPort) {
  console.warn(
    `[dev-web] host port ${preferredHostPort} busy → using ${hostPort}`,
  )
}
if (vitePort !== preferredVitePort) {
  console.warn(
    `[dev-web] vite port ${preferredVitePort} busy → using ${vitePort}`,
  )
}

if (!isLoopbackHost(host)) {
  console.warn(
    `[dev-web] WARNING: ${host} exposes the unauthenticated host API on the network`,
  )
  const addresses = host === "0.0.0.0" || host === "::" ? lanAddresses() : [host]
  for (const address of addresses) {
    console.log(`[dev-web] LAN URL: http://${formatUrlHost(address)}:${vitePort}`)
  }
}

const env = {
  ...process.env,
  JET_HOST: host,
  JET_PORT: String(hostPort),
  JET_WEB_PORT: String(vitePort),
}

const children = [
  // Keep host RPC contracts in lockstep with Vite HMR. Without watch mode,
  // client-side channel additions can hot-reload against a stale host process.
  spawnHostServer({ repoRoot, host, port: hostPort, env, watch: true }),
  spawnVite({ appDir, port: vitePort, env }),
]

wireChildLifecycle(children)
