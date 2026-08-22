import type { TerminalKind } from "@yaade/rpc"
import type { TerminalRuntimeDriver } from "./model.js"

const TERMINAL_KINDS: readonly TerminalKind[] = ["terminal"]

/** Closed v1 registry. Adding a public terminal requires changing this list. */
export class TerminalRegistry {
  private readonly drivers = new Map<TerminalKind, TerminalRuntimeDriver>()

  constructor(drivers: readonly TerminalRuntimeDriver[]) {
    for (const driver of drivers) {
      if (!TERMINAL_KINDS.includes(driver.kind)) {
        throw new Error(`unsupported terminal kind: ${driver.kind}`)
      }
      if (this.drivers.has(driver.kind)) {
        throw new Error(`duplicate terminal driver: ${driver.kind}`)
      }
      this.drivers.set(driver.kind, driver)
    }
    if (this.drivers.size !== TERMINAL_KINDS.length) {
      throw new Error("the v1 terminal registry is incomplete")
    }
  }

  get(kind: TerminalKind): TerminalRuntimeDriver {
    const driver = this.drivers.get(kind)
    if (!driver) throw new Error(`terminal driver is unavailable: ${kind}`)
    return driver
  }

  kinds(): readonly TerminalKind[] {
    return TERMINAL_KINDS
  }
}
