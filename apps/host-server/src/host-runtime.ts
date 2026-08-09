import os from "node:os"
import {
  type LspHost,
  PerfHost,
  type TerminalHost,
} from "@yaade/node-host"
import type { NotificationStreamEvent } from "@yaade/shared"
import type { AgentProvider } from "@yaade/agents"
import type { HostConfig } from "./config.js"
import type { EventHub } from "./events.js"
import {
  NotificationService,
  parseOscStreamChunk,
} from "./notifications/index.js"
import {
  AgentTelemetryService,
  AgentRunService,
  listQueuedHooks,
  markQueuedHookRetry,
  consumeHookQueueDiscardCount,
  removeQueuedHook,
  type AgentSnapshotStreamEvent,
} from "./agents/index.js"
import type { ProjectDatabase } from "./persistence.js"
import { WorkspaceHost } from "./workspace.js"

export type HostRuntime = {
  config: HostConfig
  events: EventHub
  db: ProjectDatabase
  terminal: TerminalHost
  workspace: WorkspaceHost
  perf: PerfHost
  lsp: LspHost
  homeDir: string
  /** `os.hostname()` — workspace session identity with root path. */
  machineHostname: string
  notifications: NotificationService
  agents: AgentTelemetryService
  agentRuns: AgentRunService
  hookQueueTimer: ReturnType<typeof setInterval>
}

function asAgentProvider(value: string | null | undefined): AgentProvider | null {
  if (
    value === "claude" ||
    value === "codex" ||
    value === "cursor" ||
    value === "opencode" ||
    value === "grok"
  ) {
    return value
  }
  return null
}

export function createRuntime(
  config: HostConfig,
  events: EventHub,
  db: ProjectDatabase,
  terminal: TerminalHost,
  lsp: LspHost,
  options?: {
    /** When set, notification stream events go here (e.g. PubSub → EventHub bridge). */
    emitNotification?: (event: NotificationStreamEvent) => void
  },
): HostRuntime {
  const terminalOscBuffers = new Map<string, string>()
  const emitNotification =
    options?.emitNotification ??
    ((streamEvent: NotificationStreamEvent) => {
      events.emit("notifications:event", [streamEvent])
    })
  const notifications = new NotificationService(db.raw(), emitNotification)

  const emitAgent = (streamEvent: AgentSnapshotStreamEvent) => {
    events.emit("agents:event", [streamEvent])
  }
  let agentRuns: AgentRunService | null = null
  const agents = new AgentTelemetryService(
    db.raw(),
    notifications,
    emitAgent,
    event => {
      const run = agentRuns?.onTelemetry(event)
      return !run || run.processState === "starting" || run.processState === "running"
    },
  )
  const runService = new AgentRunService(db.raw(), streamEvent => {
    events.emit("agents:event", [streamEvent])
  })
  agentRuns = runService

  terminal.setEmit((channel, args) => {
    events.emit(channel, args)
    if (channel === "terminal:data") {
      const ptyId = String(args[0] ?? "")
      const data = String(args[1] ?? "")
      handleTerminalOsc(notifications, agents, terminalOscBuffers, ptyId, data)
    } else if (channel === "terminal:exit") {
      const ptyId = String(args[0] ?? "")
      terminalOscBuffers.delete(ptyId)
      const exitCode = typeof args[1] === "number" ? args[1] : Number(args[1] ?? 0)
      handleTerminalExit(notifications, agents, agentRuns, ptyId, exitCode)
    }
  })

  const workspace = new WorkspaceHost()
  const homeDir = process.env.HOME ?? config.allowedRoots[0] ?? ""
  const hookQueueTimer = setInterval(
    () => drainHookQueue(agents, notifications, config.dataDir),
    5_000,
  )
  hookQueueTimer.unref?.()
  const runtime: HostRuntime = {
    config,
    events,
    db,
    terminal,
    workspace,
    perf: new PerfHost(homeDir, Date.now()),
    lsp,
    homeDir,
    machineHostname: os.hostname(),
    notifications,
    agents,
    agentRuns: runService,
    hookQueueTimer,
  }
  try {
    db.addProject(config.launchConfig.workspacePath)
  } catch {
    /* Launch target validation remains authoritative; HQ can still load. */
  }
  // Drain offline hook queue from previous host downtime.
  drainHookQueue(agents, notifications, config.dataDir)

  return runtime
}

function drainHookQueue(
  agents: AgentTelemetryService,
  notifications: NotificationService,
  dataDir: string,
): void {
  for (const item of listQueuedHooks(dataDir)) {
    const provider = asAgentProvider(item.meta.provider)
    if (!provider || !item.meta.sessionId) {
      removeQueuedHook(item.file)
      continue
    }
    try {
      agents.ingestNative(item.payload, {
        provider,
        sessionId: item.meta.sessionId,
      })
      removeQueuedHook(item.file)
    } catch (error) {
      markQueuedHookRetry(item.file, error)
    }
  }
  const discarded = consumeHookQueueDiscardCount()
  if (discarded > 0) {
    notifications.ingest({
      source: "system",
      type: "failed",
      severity: "warning",
      title: "Discarded invalid agent hook events",
      message: `${discarded} corrupt, expired, or over-limit queued event${discarded === 1 ? " was" : "s were"} removed.`,
      eventId: `hook-queue-discard:${new Date().toISOString().slice(0, 10)}`,
    })
  }
}

function handleTerminalOsc(
  notifications: NotificationService,
  agents: AgentTelemetryService,
  buffers: Map<string, string>,
  ptyId: string,
  data: string,
): void {
  const buffered = buffers.get(ptyId) ?? ""
  // Hot path: almost all PTY frames are screen paint with no OSC. Skip the
  // stream parser entirely when nothing is buffered and this chunk cannot start
  // an OSC sequence.
  if (buffered.length === 0 && !data.includes("\x1b]")) return
  const result = parseOscStreamChunk(buffered, data)
  if (result.buffered) buffers.set(ptyId, result.buffered)
  else buffers.delete(ptyId)
  const parsed = result.notifications
  if (parsed.length === 0) return
  const binding = notifications.bindingForPty(ptyId)
  for (const item of parsed) {
    const provider = asAgentProvider(binding?.provider ?? item.provider ?? null)
    if (provider && binding?.sessionId) {
      agents.ingestNative(
        {
          type: item.type,
          title: item.title,
          message: item.message,
          providerEvent: item.type,
          providerSessionId: item.providerSessionId,
        },
        {
          provider,
          sessionId: binding.sessionId,
          processId: ptyId,
          projectId: binding.projectId ?? undefined,
          projectName: binding.projectName ?? undefined,
          sessionTitle: binding.sessionTitle ?? undefined,
        },
      )
      continue
    }
    notifications.ingest({
      ...item,
      sessionId: binding?.sessionId ?? null,
      projectId: binding?.projectId ?? null,
      projectName: binding?.projectName ?? null,
      sessionTitle: binding?.sessionTitle ?? null,
      provider: binding?.provider ?? item.provider ?? null,
    })
  }
}

function handleTerminalExit(
  notifications: NotificationService,
  agents: AgentTelemetryService,
  agentRuns: AgentRunService | null,
  ptyId: string,
  exitCode: number,
): void {
  const durableRun = agentRuns?.onPtyExit(ptyId, exitCode, exitCode === 0)
  if (durableRun) {
    agents.onProcessExited({
      provider: durableRun.provider,
      sessionId: durableRun.runId,
      processId: ptyId,
      exitCode,
      expectedExit: exitCode === 0,
      projectId: durableRun.projectId,
    })
    return
  }
  const binding = notifications.bindingForPty(ptyId)
  const provider = asAgentProvider(binding?.provider ?? null)
  if (provider && binding?.sessionId) {
    agents.onProcessExited({
      provider,
      sessionId: binding.sessionId,
      processId: ptyId,
      exitCode,
      expectedExit: exitCode === 0,
      projectId: binding.projectId ?? undefined,
    })
    return
  }
  if (exitCode === 0) return
  const providerLabel = binding?.provider
    ? binding.provider.charAt(0).toUpperCase() + binding.provider.slice(1)
    : "Process"
  notifications.ingest({
    source: "process",
    type: exitCode > 0 ? "failed" : "process-exited",
    title: `${providerLabel} exited with code ${exitCode}`,
    message: binding?.sessionTitle
      ? `Session “${binding.sessionTitle}” ended unexpectedly.`
      : "Session process ended unexpectedly.",
    sessionId: binding?.sessionId ?? null,
    projectId: binding?.projectId ?? null,
    projectName: binding?.projectName ?? null,
    sessionTitle: binding?.sessionTitle ?? null,
    provider: binding?.provider ?? null,
    eventId: `exit:${ptyId}:${exitCode}`,
    metadata: { exitCode, ptyId },
  })
}

export function shutdownRuntime(runtime: HostRuntime): void {
  runtime.events.emit("server:shuttingDown", [])
  runtime.workspace.stopAll()
  clearInterval(runtime.hookQueueTimer)
  runtime.terminal.stopAll()
}
