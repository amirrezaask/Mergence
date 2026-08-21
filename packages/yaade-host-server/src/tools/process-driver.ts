import fs from "node:fs"
import path from "node:path"
import { Effect, Stream } from "effect"
import { getCliAgentDriver } from "@yaade/agent-telemetry"
import { cliProviderDescriptor, isCliProvider, pathToFileUri } from "@yaade/shared"
import type { AgentProvider } from "@yaade/agent-telemetry"
import {
  ProcessToolOutput,
  type ToolUse,
  type ToolUseInput,
} from "@yaade/rpc"
import type { HostConfig } from "../config.js"
import type { AgentTelemetryService, AgentRunService } from "../agents/index.js"
import type { NotificationService } from "../notifications/index.js"
import type { ProjectDatabase } from "../persistence.js"
import type { RuntimeTerminal } from "../host-runtime.js"
import { installProjectHooksForProvider } from "../agents/index.js"
import { pathAllowed } from "../sandbox.js"
import type {
  TerminalInstance,
  TerminalInstanceService,
} from "../terminal-instances.js"
import type { ToolDriver, ToolRuntimeEvent } from "./model.js"
import { ToolDriverFailure } from "./errors.js"

export type ProcessDriverDependencies = {
  readonly config: HostConfig
  readonly db: ProjectDatabase
  readonly terminal: RuntimeTerminal
  readonly terminalInstances: TerminalInstanceService
  readonly agentRuns: AgentRunService
  readonly notifications: NotificationService
  readonly agents: AgentTelemetryService
}

export type ProcessLaunchRequest = {
  readonly projectId: string
  readonly checkoutKey?: string
  readonly checkoutPath: string
  readonly title?: string
  readonly provider?: AgentProvider
  readonly workspaceId?: string
  readonly launchRequestId?: string
  readonly generation?: number
  readonly args?: readonly string[]
  readonly executable?: string
  readonly restartPolicy?: "never" | "manual" | "resume-on-daemon-start"
  readonly nativeSessionRef?: {
    provider: AgentProvider
    kind: string
    value: string
    capturedAt: string
    driverVersion: number
  }
}

function parseAgentProvider(value: string): AgentProvider | null {
  return isCliProvider(value) ? value : null
}

function composeProviderLaunchArgs(
  command: string,
  launchArgs: readonly string[],
  userArgs: readonly string[],
): string[] {
  const basename = command.replace(/\\/g, "/").split("/").pop() ?? command
  const nodeLauncher = /^(?:node|node\.exe)$/i.test(basename)
  const script = userArgs[0]
  if (nodeLauncher && script && /\.[cm]?js$/i.test(script)) {
    return [script, ...launchArgs, ...userArgs.slice(1)]
  }
  return [...launchArgs, ...userArgs]
}

function providerTitle(provider: AgentProvider): string {
  return cliProviderDescriptor(provider).label
}

export function processOutput(instance: TerminalInstance): ProcessToolOutput {
  return ProcessToolOutput.make({
    kind: "process",
    terminalInstanceId: instance.id,
    ...(instance.ptyId ? { ptyId: instance.ptyId } : {}),
    generation: instance.generation,
    processState: instance.processState,
    activityState: instance.activityState,
    replayAvailable: Boolean(instance.ptyId),
    ...(instance.exitCode == null ? {} : { exitCode: instance.exitCode }),
    truncated: false,
  })
}

function driverFailure(toolUse: ToolUse, operation: string, cause: unknown): ToolDriverFailure {
  return new ToolDriverFailure({
    toolUseId: toolUse.id,
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  })
}

function processRequest(input: ToolUseInput): {
  readonly args: readonly string[]
  readonly executable?: string
  readonly provider?: AgentProvider
} {
  if (input._tag === "TerminalToolInput") {
    const provider = input.provider ? parseAgentProvider(input.provider) : null
    return {
      args: input.shellArgs ?? [],
      ...(input.executable ? { executable: input.executable } : {}),
      ...(provider ? { provider } : {}),
    }
  }
  throw new Error("process driver received mismatched input")
}

/** Shared AgentTool/TerminalTool launch path. Terminal bytes stay on TerminalHost. */
export async function createTerminalInstance(
  deps: ProcessDriverDependencies,
  request: ProcessLaunchRequest,
  clientId: string,
): Promise<TerminalInstance> {
  const project = deps.db.project(request.projectId)
  if (!project) throw new Error("project is unavailable")
  const checkoutPath = fs.realpathSync(path.resolve(request.checkoutPath))
  if (!pathAllowed(checkoutPath, deps.config.allowedRoots)) {
    throw new Error("terminal checkout path outside allowed roots")
  }
  const provider = request.provider ?? null
  const checkoutKey = request.checkoutKey?.trim() ||
    (checkoutPath === project.rootPath ? "main" : checkoutPath)
  const title = request.title?.trim().slice(0, 160) ||
    (provider ? providerTitle(provider) : "Terminal")

  if (request.launchRequestId) {
    const existing = deps.terminalInstances.byLaunchRequestId(request.launchRequestId)
    if (existing?.ptyId) return existing
    if (existing) {
      const reopened = deps.terminalInstances.reopenForLaunch(existing.id, existing.generation)
        ?? existing
      try {
        return await launchReservedTerminalInstance(deps, reopened, {
          ...request,
          projectId: project.id,
          checkoutKey,
          checkoutPath,
          title,
          ...(provider ? { provider } : {}),
        }, clientId)
      } catch (error) {
        deps.terminalInstances.fail(
          existing.id,
          existing.generation,
          error instanceof Error ? error.message : String(error),
        )
        throw error
      }
    }
  }

  const instance = deps.terminalInstances.reserve({
    projectId: project.id,
    workspaceId: request.workspaceId ?? null,
    checkoutKey,
    checkoutPath,
    title,
    provider,
    launchRequestId: request.launchRequestId ?? null,
    launchProfile: {
      schemaVersion: 1,
      provider,
      ...(request.executable ? { executable: request.executable } : {}),
      args: [...(request.args ?? [])],
      cwd: checkoutPath,
      projectId: project.id,
      workspaceId: request.workspaceId ?? null,
      restartPolicy: request.restartPolicy ?? "manual",
    },
    restartPolicy: request.restartPolicy ?? "manual",
    ...(request.nativeSessionRef ? { nativeSessionRef: request.nativeSessionRef } : {}),
    ...(request.generation == null ? {} : { generation: request.generation }),
  })
  try {
    return await launchReservedTerminalInstance(deps, instance, {
      ...request,
      projectId: project.id,
      checkoutKey,
      checkoutPath,
      title,
      ...(provider ? { provider } : {}),
    }, clientId)
  } catch (error) {
    deps.terminalInstances.fail(
      instance.id,
      instance.generation,
      error instanceof Error ? error.message : String(error),
    )
    throw error
  }
}

/** Launch a previously reserved instance, used by restart and the Tool runtime. */
export async function launchReservedTerminalInstance(
  deps: ProcessDriverDependencies,
  instance: TerminalInstance,
  request: ProcessLaunchRequest,
  clientId: string,
): Promise<TerminalInstance> {
  const project = deps.db.project(request.projectId)
  if (!project) throw new Error("project is unavailable")
  const provider = request.provider ?? null

  if (!provider) {
    const launch = request.executable
      ? { command: request.executable, args: [...(request.args ?? [])] }
      : request.args && request.args.length > 0
        ? { args: [...request.args] }
        : null
    const created = await Promise.resolve(
      deps.terminal.create(
        pathToFileUri(request.checkoutPath),
        launch,
        clientId,
        request.launchRequestId,
      ),
    )
    return deps.terminalInstances.bindPty(
      instance.id,
      instance.generation,
      created.id,
      created.title,
      undefined,
      created.processIdentity,
      created.terminalEpoch,
      created.ownerId && created.ownerEpoch
        ? {
            ownerId: created.ownerId,
            ownerEpoch: created.ownerEpoch,
            protocolVersion: created.protocolVersion ?? 2,
          }
        : undefined,
    ) ?? instance
  }

  const availability = deps.agentRuns.providerAvailable(provider)
  const command = request.executable?.trim() || availability.binary
  if (!request.executable && !availability.available) {
    throw new Error(availability.error ?? `${availability.binary} is not available`)
  }
  if (request.executable && !fs.existsSync(request.executable)) {
    throw new Error(`${request.executable} is not available`)
  }
  const scriptArg = request.args?.[0]
  if (
    scriptArg &&
    /\.(cjs|mjs|js)$/i.test(scriptArg) &&
    !fs.existsSync(scriptArg)
  ) {
    throw new Error(`${scriptArg} is not available`)
  }
  const capabilities = getCliAgentDriver(provider).getCapabilities()
  const processOnly = !capabilities.sessionLifecycle && !capabilities.promptLifecycle &&
    !capabilities.toolLifecycle && !capabilities.permissions
  let launchArgs: string[] = []
  let launchEnv: Record<string, string> = {}
  let telemetryError: string | null = null
  try {
    installProjectHooksForProvider(provider, project.rootPath, deps.config.dataDir)
    const driver = getCliAgentDriver(provider)
    const origin = `http://${deps.config.host}:${deps.config.port}`
    const ingestUrl = new URL("/api/v1/notifications/ingest", origin)
    ingestUrl.searchParams.set("provider", provider)
    ingestUrl.searchParams.set("sessionId", instance.id)
    const installed = await driver.installHooks({
      sessionId: instance.id,
      projectRoot: request.checkoutPath,
      ingestUrl: ingestUrl.toString(),
      provider,
      origin,
    })
    launchArgs = installed.launchArgs
    launchEnv = installed.env
  } catch (error) {
    telemetryError = error instanceof Error ? error.message : String(error)
  }
  const created = await Promise.resolve(deps.terminal.create(pathToFileUri(request.checkoutPath), {
    command,
    args: composeProviderLaunchArgs(command, launchArgs, request.args ?? []),
    env: launchEnv,
  }, clientId, request.launchRequestId))
  const bound = deps.terminalInstances.bindPty(
    instance.id,
    instance.generation,
    created.id,
    created.title,
    processOnly ? "process_only" : "connecting",
    created.processIdentity,
    created.terminalEpoch,
    created.ownerId && created.ownerEpoch
      ? {
          ownerId: created.ownerId,
          ownerEpoch: created.ownerEpoch,
          protocolVersion: created.protocolVersion ?? 2,
        }
      : undefined,
  )
  if (!bound) throw new Error("process binding was rejected")
  deps.db.recordSession(created.id, "terminal", "running", { title: created.title })
  deps.notifications.bindSession({
    sessionId: bound.id,
    runId: bound.id,
    projectId: project.id,
    projectName: project.name,
    sessionTitle: bound.title,
    provider,
    ptyId: created.id,
  })
  deps.agents.onProcessStarted({
    provider,
    sessionId: bound.id,
    processId: created.id,
    projectId: project.id,
    cwd: request.checkoutPath,
  })
  if (telemetryError) {
    return deps.terminalInstances.markTelemetryDegraded(
      bound.id, bound.generation, telemetryError,
    ) ?? bound
  }
  return bound
}

export async function resumeTerminalInstance(
  deps: ProcessDriverDependencies,
  instance: TerminalInstance,
  clientId: string,
): Promise<TerminalInstance> {
  if (!instance.provider || !instance.nativeSessionRef) {
    throw new Error("NATIVE_RESUME_UNSUPPORTED")
  }
  const driver = getCliAgentDriver(instance.provider)
  if (!driver.buildResumeLaunch || !driver.validateNativeSessionRef) {
    throw new Error("NATIVE_RESUME_UNSUPPORTED")
  }
  const valid = await driver.validateNativeSessionRef(instance.nativeSessionRef, {
    projectRoot: instance.checkoutPath,
    cwd: instance.checkoutPath,
  })
  if (!valid) throw new Error("NATIVE_SESSION_INVALID")
  const launch = await driver.buildResumeLaunch(instance.nativeSessionRef, {
    projectRoot: instance.checkoutPath,
    cwd: instance.checkoutPath,
    executable: instance.launchProfile?.executable,
    args: instance.launchProfile?.args,
  })
  const restarting = deps.terminalInstances.beginRestart(instance.id, instance.generation)
  if (!restarting) throw new Error("terminal instance cannot be restored")
  try {
    return await launchReservedTerminalInstance(deps, restarting, {
      projectId: restarting.projectId,
      checkoutKey: restarting.checkoutKey,
      checkoutPath: restarting.checkoutPath,
      title: restarting.title,
      provider: restarting.provider ?? undefined,
      executable: launch.command,
      args: launch.args,
      launchRequestId: `${restarting.id}:${restarting.generation}:resume`,
    }, clientId)
  } catch (error) {
    deps.terminalInstances.fail(
      restarting.id,
      restarting.generation,
      error instanceof Error ? error.message : String(error),
    )
    throw error
  }
}

export async function restartTerminalInstance(
  deps: ProcessDriverDependencies,
  instance: TerminalInstance,
  args: readonly string[],
  clientId: string,
): Promise<TerminalInstance> {
  if (instance.ptyId) await Promise.resolve(deps.terminal.dispose(instance.ptyId))
  const restarting = deps.terminalInstances.beginRestart(instance.id, instance.generation)
  if (!restarting) throw new Error("terminal instance cannot be restarted")
  return launchReservedTerminalInstance(deps, restarting, {
    projectId: restarting.projectId,
    checkoutKey: restarting.checkoutKey,
    checkoutPath: restarting.checkoutPath,
    title: restarting.title,
    ...(restarting.provider ? { provider: restarting.provider } : {}),
    args,
    launchRequestId: `${restarting.id}:${restarting.generation}`,
  }, clientId)
}

export function parseProcessProvider(value: string): AgentProvider | null {
  return parseAgentProvider(value)
}

/** Runtime adapter for the terminal ToolUse. */
export class ProcessToolDriver implements ToolDriver {
  readonly kind = "terminal" as const

  constructor(private readonly deps: ProcessDriverDependencies) {}

  create(toolUse: ToolUse, input: ToolUseInput): Effect.Effect<ProcessToolOutput, ToolDriverFailure> {
    return Effect.tryPromise({
      try: async () => {
        const request = processRequest(input)
        const instance = await createTerminalInstance(this.deps, {
          projectId: toolUse.context.project.projectId,
          checkoutKey: toolUse.context.checkoutKey,
          checkoutPath: toolUse.context.checkoutPath,
          title: toolUse.title,
          workspaceId: toolUse.sessionId,
          ...request,
          launchRequestId: `${toolUse.id}:${toolUse.output.kind === "process" ? toolUse.output.generation : 1}`,
        }, toolUse.sessionId)
        this.deps.terminalInstances.bindToolUse(instance.id, toolUse.id)
        return processOutput(instance)
      },
      catch: cause => driverFailure(toolUse, "create", cause),
    })
  }

  restart(toolUse: ToolUse): Effect.Effect<ProcessToolOutput, ToolDriverFailure> {
    return Effect.tryPromise({
      try: async () => {
        const instance = toolUse.output.kind === "process"
          ? this.deps.terminalInstances.get(toolUse.output.terminalInstanceId)
          : null
        const request = processRequest(toolUse.input)
        const sameHome = Boolean(
          instance &&
          instance.projectId === toolUse.context.project.projectId &&
          instance.checkoutPath === toolUse.context.checkoutPath &&
          instance.provider == null,
        )
        if (instance && sameHome) {
          const restarted = await restartTerminalInstance(
            this.deps,
            instance,
            request.args,
            toolUse.sessionId,
          )
          this.deps.terminalInstances.bindToolUse(restarted.id, toolUse.id)
          return processOutput(restarted)
        }
        if (instance) {
          if (instance.ptyId) await Promise.resolve(this.deps.terminal.dispose(instance.ptyId))
          this.deps.terminalInstances.close(instance.id, instance.generation, "")
        }
        const created = await createTerminalInstance(this.deps, {
          projectId: toolUse.context.project.projectId,
          checkoutKey: toolUse.context.checkoutKey,
          checkoutPath: toolUse.context.checkoutPath,
          title: toolUse.title,
          workspaceId: toolUse.sessionId,
          ...request,
          generation: toolUse.output.kind === "process" ? toolUse.output.generation + 1 : 1,
          launchRequestId: `${toolUse.id}:${toolUse.output.kind === "process" ? toolUse.output.generation + 1 : 1}`,
        }, toolUse.sessionId)
        this.deps.terminalInstances.bindToolUse(created.id, toolUse.id)
        return processOutput(created)
      },
      catch: cause => driverFailure(toolUse, "restart", cause),
    })
  }

  cancel(toolUse: ToolUse): Effect.Effect<ProcessToolOutput, ToolDriverFailure> {
    return Effect.tryPromise({
      try: async () => {
        const instance = toolUse.output.kind === "process"
          ? this.deps.terminalInstances.get(toolUse.output.terminalInstanceId)
          : null
        if (!instance) {
          if (toolUse.output.kind !== "process") throw new Error("process output is unavailable")
          return toolUse.output
        }
        if (instance.ptyId) await Promise.resolve(this.deps.terminal.dispose(instance.ptyId))
        const closed = this.deps.terminalInstances.close(instance.id, instance.generation, "")
        return processOutput(closed ?? instance)
      },
      catch: cause => driverFailure(toolUse, "cancel", cause),
    })
  }

  attach(toolUse: ToolUse): Stream.Stream<ToolRuntimeEvent> {
    return Stream.succeed({ _tag: "OutputChanged", toolUse })
  }

  close(toolUse: ToolUse): Effect.Effect<void, ToolDriverFailure> {
    return this.cancel(toolUse).pipe(Effect.asVoid)
  }
}
