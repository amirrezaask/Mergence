import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import WebSocket from "ws"
import type { HostConfig } from "../config.js"
import { loadConfig } from "../config.js"
import { startHostServer } from "../server.js"

export type HostHarnessOptions = {
  readonly root?: string
  readonly token?: string
  readonly ptySupervisor?: boolean
}

export type HostHarness = {
  readonly root: string
  readonly dataDir: string
  readonly config: HostConfig
  readonly server: Awaited<ReturnType<typeof startHostServer>>
  readonly baseUrl: string
  fetch(pathname: string, init?: RequestInit): Promise<Response>
  connect(pathname?: string, options?: { readonly token?: string }): WebSocket
  close(options?: { readonly killPtys?: boolean }): Promise<void>
}

export async function startHostHarness(
  options: HostHarnessOptions = {},
): Promise<HostHarness> {
  const root = await fs.promises.mkdtemp(
    path.join(options.root ?? os.tmpdir(), "yaade-host-harness-"),
  )
  const dataDir = path.join(root, "data")
  const argv = [
    root,
    "--host",
    "127.0.0.1",
    "--port",
    "0",
    "--data-dir",
    dataDir,
    "--allowed-roots",
    root,
  ]
  if (options.token) argv.push("--token", options.token)
  if (options.ptySupervisor !== undefined) {
    argv.push("--pty-supervisor", options.ptySupervisor ? "1" : "0")
  }
  const config = await loadConfig(argv)
  const server = await startHostServer(config)
  const baseUrl = `http://127.0.0.1:${server.port}`
  return {
    root,
    dataDir,
    config,
    server,
    baseUrl,
    fetch: (pathname, init) => fetch(new URL(pathname, baseUrl), init),
    connect: (pathname = "/ws?protocol=2", connectionOptions = {}) => {
      const socket = new WebSocket(new URL(pathname, baseUrl.replace(/^http/u, "ws")))
      if (connectionOptions.token) {
        socket.once("open", () => {
          socket.send(JSON.stringify({ type: "protocol:auth", token: connectionOptions.token }))
        })
      }
      return socket
    },
    close: async closeOptions => {
      await server.close(closeOptions)
      await fs.promises.rm(root, { recursive: true, force: true })
    },
  }
}
