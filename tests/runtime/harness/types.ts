import type { BrowserContext, Page } from "@playwright/test"
import type { ChildProcess } from "node:child_process"
import type { ProcessIdentity } from "../../../packages/yaade-node-host/src/process-identity.js"

export type NetworkTarget = "api" | "browser"

export type MockAgentOptions = {
  mode?: string
  from?: number
  to?: number
  intervalMs?: number
  extraArgs?: string[]
}

export type ServerOptions = {
  dataDir?: string
  port?: number
  extraArgs?: string[]
}

export type ProcessIdentitySnapshot = ProcessIdentity

export type DatabaseSnapshot = {
  path: string
  terminalInstances: Array<Record<string, unknown>>
  sessions: Array<Record<string, unknown>>
  toolUses: Array<Record<string, unknown>>
}

export type RuntimeSnapshot = {
  identity: {
    serverId: string
    serverEpoch: string
  }
  health: {
    status: string
    runningTerminals: number
  }
  port: number
}

export type ResourceMetrics = {
  rssBytes: number
  heapUsedBytes: number
}

export type ApiHandle = {
  pid: number
  port: number
  origin: string
  dataDir: string
  processIdentity: ProcessIdentitySnapshot | null
  logs: () => string
}

export type DaemonHandle = ApiHandle

export type BrowserHandle = {
  page: Page
  context: BrowserContext
  userDataDir: string
  close: () => Promise<void>
}

export type MockAgentHandle = {
  controlPort: number
  pid: number
  controlFile: string
  emitRange: (from: number, to: number) => Promise<void>
  emitText: (text: string) => Promise<void>
  startNumbered: (from: number, to?: number, intervalMs?: number) => Promise<void>
  stopNumbered: () => Promise<void>
  setMode: (mode: string) => Promise<void>
  exit: (code?: number) => Promise<void>
}

export type OwnedProcess = {
  name: string
  child: ChildProcess
  logs: () => string
}
