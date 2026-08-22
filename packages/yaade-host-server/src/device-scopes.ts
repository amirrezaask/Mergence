import type { DeviceScope } from "./device-auth.js"
import { principalMayInvoke } from "./route-policy.js"
import { makePairedDevicePrincipal } from "./principal.js"

const OBSERVE_CHANNELS = new Set([
  "mux:listSessions",
  "mux:getSession",
  "mux:getTerminal",
  "terminal:listViewers",
  "terminal:attach",
  "terminal:ack",
  "terminal:ready",
  "terminal:getCwd",
  "terminal:getForegroundProcess",
])

/** Host-token callers are unrestricted. Paired devices terminal route policy. */
export function deviceMayInvoke(
  scopes: readonly DeviceScope[] | undefined,
  channel: string,
): boolean {
  if (!scopes || scopes.length === 0) return true
  if (OBSERVE_CHANNELS.has(channel) && scopes.includes("observe")) return true
  return principalMayInvoke(
    makePairedDevicePrincipal("scope-check", scopes, "scope-check"),
    channel,
  )
}
