import type {
  RuntimeCapabilities,
  SupervisorEvent,
} from "./terminal-protocol/schema.js"
import {
  runtimeSupports,
  type TerminalRuntimeManifest,
} from "./terminal-runtime-registry.js"

export type RoutedTerminalRef = {
  readonly id: string
  readonly ownerId: string
  readonly ownerEpoch: string
  readonly terminalEpoch: string
}

export type RuntimeConnection<Runtime> = {
  readonly manifest: TerminalRuntimeManifest
  readonly runtime: Runtime
}

export type RunningTerminalRef = {
  readonly id: string
  readonly terminalEpoch: string
  readonly status: "running" | "exited"
}

/**
 * In-process routing table for blue/green supervisor generations. The router
 * owns only owner selection and terminal-to-owner references; each connection
 * remains responsible for its own protocol and PTYs.
 */
export class TerminalRuntimeRouter<Runtime> {
  private readonly owners = new Map<string, RuntimeConnection<Runtime>>()
  private readonly terminals = new Map<string, RoutedTerminalRef>()

  register(connection: RuntimeConnection<Runtime>): void {
    this.owners.set(connection.manifest.ownerEpoch, connection)
  }

  unregister(ownerEpoch: string): void {
    this.owners.delete(ownerEpoch)
    for (const [terminalId, terminal] of this.terminals) {
      if (terminal.ownerEpoch === ownerEpoch) this.terminals.delete(terminalId)
    }
  }

  owner(ownerEpoch: string): RuntimeConnection<Runtime> | null {
    return this.owners.get(ownerEpoch) ?? null
  }

  chooseCreateOwner(
    requiredProtocol: number,
    requiredCapabilities: Partial<RuntimeCapabilities> = {},
  ): RuntimeConnection<Runtime> | null {
    const candidates = [...this.owners.values()]
      .filter(connection =>
        runtimeSupports(connection.manifest, requiredProtocol, requiredCapabilities),
      )
      .sort((left, right) => left.manifest.startedAt.localeCompare(right.manifest.startedAt))
    return candidates.at(-1) ?? null
  }

  registerTerminal(terminal: RoutedTerminalRef): void {
    const owner = this.owners.get(terminal.ownerEpoch)
    if (!owner || owner.manifest.ownerId !== terminal.ownerId) {
      throw new Error(`runtime owner is not connected: ${terminal.ownerEpoch}`)
    }
    this.terminals.set(terminal.id, terminal)
  }

  terminal(terminalId: string): RoutedTerminalRef | null {
    return this.terminals.get(terminalId) ?? null
  }

  unregisterTerminal(terminalId: string): void {
    this.terminals.delete(terminalId)
  }

  route(terminalId: string): RuntimeConnection<Runtime> | null {
    const terminal = this.terminals.get(terminalId)
    return terminal ? this.owners.get(terminal.ownerEpoch) ?? null : null
  }

  routeOrThrow(terminalId: string): RuntimeConnection<Runtime> {
    const connection = this.route(terminalId)
    if (!connection) throw new Error(`terminal owner is unavailable: ${terminalId}`)
    return connection
  }

  updateTerminalEpoch(terminalId: string, terminalEpoch: string): void {
    const current = this.terminals.get(terminalId)
    if (!current) throw new Error(`terminal is not registered: ${terminalId}`)
    this.terminals.set(terminalId, { ...current, terminalEpoch })
  }

  listRunning(
    readOwner: (runtime: Runtime) => readonly RunningTerminalRef[],
  ): Array<RoutedTerminalRef & { readonly status: "running" | "exited" }> {
    const result: Array<RoutedTerminalRef & { readonly status: "running" | "exited" }> = []
    for (const connection of this.owners.values()) {
      for (const running of readOwner(connection.runtime)) {
        const reference: RoutedTerminalRef & { readonly status: "running" | "exited" } = {
          id: running.id,
          ownerId: connection.manifest.ownerId,
          ownerEpoch: connection.manifest.ownerEpoch,
          terminalEpoch: running.terminalEpoch,
          status: running.status,
        }
        this.terminals.set(running.id, reference)
        result.push(reference)
      }
    }
    return result
  }

  ownerIsDraining(ownerEpoch: string): boolean {
    return this.owners.get(ownerEpoch)?.manifest.state === "draining"
  }

  ownerHasTerminals(ownerEpoch: string): boolean {
    for (const terminal of this.terminals.values()) {
      if (terminal.ownerEpoch === ownerEpoch) return true
    }
    return false
  }

  applyEvent(ownerEpoch: string, event: SupervisorEvent): RoutedTerminalRef | null {
    if (event.ownerEpoch !== ownerEpoch) return null
    if (!event.terminalId || !event.terminalEpoch) return null
    const current = this.terminals.get(event.terminalId)
    const owner = this.owners.get(ownerEpoch)
    if (!owner) return null
    const reference: RoutedTerminalRef = {
      id: event.terminalId,
      ownerId: owner.manifest.ownerId,
      ownerEpoch,
      terminalEpoch: event.terminalEpoch,
    }
    this.terminals.set(event.terminalId, reference)
    return current && current.terminalEpoch === reference.terminalEpoch ? current : reference
  }
}
