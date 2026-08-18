import fs from "node:fs"
import path from "node:path"
import {
  getCliAgentDriver,
  type AgentProvider,
} from "@yaade/agent-telemetry"
import { fileUriToPath } from "@yaade/shared"
import type { TerminalInspectSnapshot } from "@yaade/node-host"
import { inferAgentProvider } from "./hq.js"
import type { HostRuntime } from "./host-runtime.js"
import type {
  TerminalInstance,
  TerminalInstanceTelemetryState,
} from "./terminal-instances.js"

export type TerminalAgentDiscoveryRuntime = {
  db: Pick<HostRuntime["db"], "projects" | "listAllProjectSessions">
  machineHostname: string
  terminal: Pick<
    HostRuntime["terminal"],
    "listRunning" | "getForegroundProcess" | "getCwd"
  >
  terminalInstances: Pick<
    HostRuntime["terminalInstances"],
    | "byPtyId"
    | "promoteToAgent"
    | "reserve"
    | "bindPty"
    | "demoteToTerminal"
    | "close"
  >
  notifications: Pick<HostRuntime["notifications"], "bindSession">
  agents: {
    onProcessStarted: (
      ...args: Parameters<HostRuntime["agents"]["onProcessStarted"]>
    ) => void
    onProcessExited: (
      ...args: Parameters<HostRuntime["agents"]["onProcessExited"]>
    ) => void
  }
}

const SHELL_PROCESSES = new Set([
  "bash",
  "cmd",
  "csh",
  "dash",
  "elvish",
  "fish",
  "ksh",
  "login",
  "nu",
  "nushell",
  "powershell",
  "pwsh",
  "sh",
  "tcsh",
  "zsh",
])

function canonicalPath(value: string): string {
  try {
    return fs.realpathSync(path.resolve(value))
  } catch {
    return path.resolve(value)
  }
}

function providerTitle(provider: AgentProvider): string {
  switch (provider) {
    case "opencode":
      return "OpenCode"
    default:
      return `${provider.charAt(0).toUpperCase()}${provider.slice(1)}`
  }
}

function telemetryStateFor(provider: AgentProvider): TerminalInstanceTelemetryState {
  const capabilities = getCliAgentDriver(provider).getCapabilities()
  return capabilities.sessionLifecycle ||
    capabilities.promptLifecycle ||
    capabilities.toolLifecycle ||
    capabilities.permissions
    ? "connecting"
    : "process_only"
}

function projectForCwd(
  cwd: string,
  projects: readonly { rootPath: string; id: string; name: string }[],
): { rootPath: string; id: string; name: string } | null {
  const target = canonicalPath(cwd)
  let match: { rootPath: string; id: string; name: string } | null = null
  let matchLength = -1
  for (const project of projects) {
    const rootPath = canonicalPath(project.rootPath)
    if (
      target !== rootPath &&
      !target.startsWith(`${rootPath}${path.sep}`)
    ) {
      continue
    }
    if (rootPath.length <= matchLength) continue
    match = { ...project, rootPath }
    matchLength = rootPath.length
  }
  return match
}

function isShellProcess(processName: string | null): boolean {
  if (!processName) return false
  const basename = path
    .basename(processName)
    .replace(/\.exe$/i, "")
    .toLowerCase()
  return SHELL_PROCESSES.has(basename)
}

function cwdFromInspect(
  runtime: TerminalAgentDiscoveryRuntime,
  inspected: TerminalInspectSnapshot,
): Promise<string> {
  return runtime.terminal.getCwd(inspected.id).then(uri => {
    if (uri) {
      try {
        return fileUriToPath(uri)
      } catch {
        /* use the spawn cwd below */
      }
    }
    return inspected.spawnCwd
  })
}

function workspaceForProject(
  sessions: readonly { archivedAt: string | null; projectPath: string; id: string }[],
  projectPath: string,
) {
  return sessions.find(
    session => !session.archivedAt && session.projectPath === projectPath,
  )
}

function bindDiscoveredAgent(
  runtime: TerminalAgentDiscoveryRuntime,
  instance: TerminalInstance,
  project: { id: string; name: string },
  ptyId: string,
): void {
  if (!instance.provider) return
  runtime.notifications.bindSession({
    sessionId: instance.id,
    runId: instance.id,
    projectId: project.id,
    projectName: project.name,
    sessionTitle: instance.title,
    provider: instance.provider,
    ptyId,
  })
  runtime.agents.onProcessStarted({
    provider: instance.provider,
    sessionId: instance.id,
    processId: ptyId,
    projectId: project.id,
    cwd: instance.checkoutPath,
  })
}

type DiscoveredAgentInstance = {
  instance: TerminalInstance | null
  started: boolean
}

function discoverAgentInstance(
  runtime: TerminalAgentDiscoveryRuntime,
  inspected: TerminalInspectSnapshot,
  provider: AgentProvider,
  cwd: string,
  project: { id: string; name: string; rootPath: string },
  workspaceId: string | null,
): DiscoveredAgentInstance {
  const existing = runtime.terminalInstances.byPtyId(inspected.id)
  if (existing?.provider === provider) return { instance: existing, started: false }
  if (existing?.provider) return { instance: existing, started: false }

  const title = providerTitle(provider)
  const telemetryState = telemetryStateFor(provider)
  if (existing) {
    const promoted = runtime.terminalInstances.promoteToAgent(
      existing.id,
      existing.generation,
      provider,
      title,
      telemetryState,
    )
    return {
      instance: promoted,
      started: promoted?.provider === provider,
    }
  }

  const reserved = runtime.terminalInstances.reserve({
    projectId: project.id,
    workspaceId,
    checkoutKey: cwd === project.rootPath ? "main" : cwd,
    checkoutPath: cwd,
    title,
    provider,
    launchRequestId: `terminal-agent:${inspected.id}`,
    telemetryState,
  })
  const bound = runtime.terminalInstances.bindPty(
    reserved.id,
    reserved.generation,
    inspected.id,
    title,
    telemetryState,
  )
  return { instance: bound ?? reserved, started: true }
}

function closeAgentAssociation(
  runtime: TerminalAgentDiscoveryRuntime,
  instance: TerminalInstance,
  inspected: TerminalInspectSnapshot,
): void {
  if (!instance.provider) return
  runtime.agents.onProcessExited({
    provider: instance.provider,
    sessionId: instance.id,
    processId: inspected.id,
    exitCode: 0,
    expectedExit: true,
    projectId: instance.projectId,
  })
  if (instance.toolUseId) {
    runtime.terminalInstances.demoteToTerminal(instance.id, instance.generation)
  } else {
    runtime.terminalInstances.close(instance.id, instance.generation, "")
  }
}

/** Discover provider CLIs launched inside ordinary shell terminals. */
export async function discoverTerminalAgents(
  runtime: TerminalAgentDiscoveryRuntime,
  ptyIds?: readonly string[],
): Promise<void> {
  const requestedPtyIds = ptyIds ? new Set(ptyIds) : null
  const inspectedTerminals = (
    await Promise.resolve(runtime.terminal.listRunning())
  ).filter(inspected => !requestedPtyIds || requestedPtyIds.has(inspected.id))
  if (inspectedTerminals.length === 0) return
  const projects = runtime.db.projects()
  const sessions = runtime.db.listAllProjectSessions(runtime.machineHostname)

  for (const inspected of inspectedTerminals) {
    const processName = await runtime.terminal.getForegroundProcess(
      inspected.id,
      false,
    )
    const provider = inferAgentProvider(
      undefined,
      processName ?? inspected.spawnCommand ?? undefined,
    )
    const existing = runtime.terminalInstances.byPtyId(inspected.id)

    if (!provider) {
      if (existing?.provider && isShellProcess(processName)) {
        closeAgentAssociation(runtime, existing, inspected)
      }
      continue
    }

    const cwd = await cwdFromInspect(runtime, inspected)
    const project = projectForCwd(cwd, projects)
    if (!project) continue
    const workspace = workspaceForProject(sessions, project.rootPath)
    const discovered = discoverAgentInstance(
      runtime,
      inspected,
      provider,
      cwd,
      project,
      workspace?.id ?? null,
    )
    if (discovered.instance && discovered.started) {
      bindDiscoveredAgent(runtime, discovered.instance, project, inspected.id)
    }
  }
}
