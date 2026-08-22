import { Effect } from "effect"
import { pathToFileUri } from "@yaade/shared"
import { TerminalOutput, type MuxTerminal, type TerminalInput } from "@yaade/rpc"
import type { TerminalHost } from "@yaade/node-host"
import type { HostConfig } from "../config.js"
import { TerminalRuntimeDriverFailure } from "./errors.js"

type ProcessDriverDependencies = {
  readonly config: HostConfig
  readonly terminal: TerminalHost
}

function driverFailure(
  terminal: MuxTerminal,
  operation: string,
  cause: unknown,
): TerminalRuntimeDriverFailure {
  return new TerminalRuntimeDriverFailure({
    muxTerminalId: terminal.id,
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  })
}

function output(
  ptyId: string,
  generation: number,
  processState: "running" | "exited",
): TerminalOutput {
  return TerminalOutput.make({
    kind: "process",
    terminalInstanceId: ptyId,
    ptyId,
    generation,
    processState,
    activityState: processState === "running" ? "idle" : "failed",
    replayAvailable: true,
    truncated: false,
  })
}

/** Owns the small adapter between persisted terminal records and TerminalHost. */
export class TerminalProcessDriver {
  constructor(private readonly deps: ProcessDriverDependencies) {}

  create(
    terminal: MuxTerminal,
    input: TerminalInput,
  ): Effect.Effect<TerminalOutput, TerminalRuntimeDriverFailure> {
    return Effect.tryPromise({
      try: async () => {
        const launch = input.shellArgs?.length ? { args: [...input.shellArgs] } : null
        const created = await Promise.resolve(
          this.deps.terminal.create(
            pathToFileUri(this.deps.config.launchConfig.workspacePath),
            launch,
            terminal.sessionId,
            `${terminal.id}:${terminal.output.generation}`,
          ),
        )
        return output(created.id, terminal.output.generation, "running")
      },
      catch: cause => driverFailure(terminal, "create", cause),
    })
  }

  restart(
    terminal: MuxTerminal,
  ): Effect.Effect<TerminalOutput, TerminalRuntimeDriverFailure> {
    return Effect.tryPromise({
      try: async () => {
        if (terminal.output.ptyId) {
          await Promise.resolve(this.deps.terminal.dispose(terminal.output.ptyId))
        }
        const generation = terminal.output.generation + 1
        const launch = terminal.input.shellArgs?.length
          ? { args: [...terminal.input.shellArgs] }
          : null
        const created = await Promise.resolve(
          this.deps.terminal.create(
            pathToFileUri(this.deps.config.launchConfig.workspacePath),
            launch,
            terminal.sessionId,
            `${terminal.id}:${generation}`,
          ),
        )
        return output(created.id, generation, "running")
      },
      catch: cause => driverFailure(terminal, "restart", cause),
    })
  }

  cancel(
    terminal: MuxTerminal,
  ): Effect.Effect<TerminalOutput, TerminalRuntimeDriverFailure> {
    return Effect.tryPromise({
      try: async () => {
        if (terminal.output.ptyId) {
          await Promise.resolve(this.deps.terminal.dispose(terminal.output.ptyId))
        }
        return TerminalOutput.make({
          ...terminal.output,
          processState: "exited",
          activityState: "idle",
          replayAvailable: false,
        })
      },
      catch: cause => driverFailure(terminal, "cancel", cause),
    })
  }
}
