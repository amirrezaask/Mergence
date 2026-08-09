import type { AgentProvider } from "../types/events.js"
import type { CliAgentDriver } from "../types/driver.js"
import { claudeDriver } from "./claude.js"
import { codexDriver } from "./codex.js"
import { cursorDriver } from "./cursor.js"
import { opencodeDriver } from "./opencode.js"
import { grokDriver } from "./grok.js"

const DRIVERS: Record<AgentProvider, CliAgentDriver> = {
  claude: claudeDriver,
  codex: codexDriver,
  cursor: cursorDriver,
  opencode: opencodeDriver,
  grok: grokDriver,
}

export function getCliAgentDriver(provider: AgentProvider): CliAgentDriver {
  return DRIVERS[provider]
}

export function listCliAgentDrivers(): CliAgentDriver[] {
  return Object.values(DRIVERS)
}

export {
  claudeDriver,
  codexDriver,
  cursorDriver,
  opencodeDriver,
  grokDriver,
}
