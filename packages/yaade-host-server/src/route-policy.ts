import { isHostRouteName } from "@yaade/rpc"
import type { DeviceScope } from "./device-auth.js"
import type { RequestPrincipal } from "./principal.js"

export type RouteCapability = "public" | "observe" | "control" | "admin" | "local-admin"

const ADMIN_ROUTES = new Set<string>([
  "terminal:dispose",
  "terminal:transferControl",
  "mux:archiveTab",
  "mux:archiveSession",
  "mux:closeTerminal",
])

const OBSERVE_ROUTES = new Set<string>([
  "mux:listSessions",
  "mux:getSession",
  "mux:getTerminal",
  "terminal:listViewers",
  "terminal:attach",
  "terminal:ready",
  "terminal:getCwd",
  "terminal:getForegroundProcess",
])

const LOCAL_ADMIN_ROUTES = new Set<string>([
  "terminal:stopAll",
  "runtime:markDraining",
  "runtime:shutdown",
])

/** Return the capability required before a route handler can run. */
export function routeCapability(channel: string): RouteCapability {
  if (LOCAL_ADMIN_ROUTES.has(channel)) return "local-admin"
  if (ADMIN_ROUTES.has(channel)) return "admin"
  if (OBSERVE_ROUTES.has(channel)) return "observe"
  if (!isHostRouteName(channel)) return "local-admin"
  // Every registered route not explicitly read-only or lifecycle-admin is a
  // control operation. This secure default prevents a newly-added mutation
  // from accidentally becoming observe-only.
  return "control"
}

export function principalMayUseCapability(
  principal: Pick<RequestPrincipal, "authenticationKind" | "scopes">,
  capability: RouteCapability,
): boolean {
  if (capability === "public") return true
  if (principal.authenticationKind === "host-token") return true
  if (principal.authenticationKind === "local-development") return true
  if (capability === "local-admin") return false
  if (capability === "admin") return principal.scopes.has("admin")
  if (capability === "control") return hasControl(principal.scopes)
  return hasObserve(principal.scopes)
}

function hasObserve(scopes: ReadonlySet<DeviceScope>): boolean {
  return scopes.has("observe") || scopes.has("control") || scopes.has("admin")
}

function hasControl(scopes: ReadonlySet<DeviceScope>): boolean {
  return scopes.has("control") || scopes.has("admin")
}

export function principalMayInvoke(
  principal: Pick<RequestPrincipal, "authenticationKind" | "scopes">,
  channel: string,
): boolean {
  return principalMayUseCapability(principal, routeCapability(channel))
}
