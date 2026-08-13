import type { ToolKind } from "@yaade/rpc"
import type { ToolDriver } from "./model.js"

const TOOL_KINDS: readonly ToolKind[] = ["agent", "terminal", "search", "git"]

/** Closed v1 registry. Adding a public tool requires changing this list. */
export class ToolRegistry {
  private readonly drivers = new Map<ToolKind, ToolDriver>()

  constructor(drivers: readonly ToolDriver[]) {
    for (const driver of drivers) {
      if (!TOOL_KINDS.includes(driver.kind)) {
        throw new Error(`unsupported tool kind: ${driver.kind}`)
      }
      if (this.drivers.has(driver.kind)) {
        throw new Error(`duplicate tool driver: ${driver.kind}`)
      }
      this.drivers.set(driver.kind, driver)
    }
    if (this.drivers.size !== TOOL_KINDS.length) {
      throw new Error("the v1 tool registry is incomplete")
    }
  }

  get(kind: ToolKind): ToolDriver {
    const driver = this.drivers.get(kind)
    if (!driver) throw new Error(`tool driver is unavailable: ${kind}`)
    return driver
  }

  kinds(): readonly ToolKind[] {
    return TOOL_KINDS
  }
}
