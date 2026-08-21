import { isHostRouteName } from "@yaade/rpc"
import type { DeviceScope } from "./device-auth.js"
import type { RequestPrincipal } from "./principal.js"

export type RouteCapability = "public" | "observe" | "control" | "admin" | "local-admin"

const ADMIN_ROUTES = new Set<string>([
  "agents:stop",
  "agents:close",
  "agents:installProjectHooks",
  "terminal:dispose",
  "terminal:restartInstance",
  "terminal:resumeInstance",
  "terminal:closeInstance",
  "terminal:transferControl",
  "tools:archiveTab",
  "tools:archiveSession",
  "tools:archiveUse",
  "fs:emptyTrash",
  "notifications:runRetention",
])

const OBSERVE_ROUTES = new Set<string>([
  "yaade:getLaunchConfig",
  "yaade:getHomeDir",
  "yaade:loadGlobalYaadercScanRoots",
  "perf:getStartupLogPath",
  "tools:listSessions",
  "tools:getSession",
  "tools:getUse",
  "tools:listProjects",
  "tools:listCheckoutTargets",
  "notifications:list",
  "notifications:counts",
  "notifications:get",
  "notifications:unreadBySession",
  "notifications:getPreferences",
  "agents:listProviders",
  "agents:listLive",
  "agents:listProject",
  "agents:get",
  "agents:getTranscript",
  "agents:listActivity",
  "agents:getSnapshot",
  "agents:listEvents",
  "fs:readFile",
  "fs:readTextFile",
  "fs:readDir",
  "fs:stat",
  "fs:exists",
  "fs:listTrash",
  "git:isRepo",
  "git:status",
  "git:diff",
  "git:show",
  "git:branch",
  "git:summary",
  "git:branches",
  "git:history",
  "git:historyPage",
  "git:numstat",
  "git:commitFiles",
  "git:worktreeList",
  "git:defaultBranch",
  "terminal:listInstances",
  "terminal:getInstanceTranscript",
  "terminal:listViewers",
  "terminal:attach",
  "terminal:ack",
  "terminal:ready",
  "terminal:getCwd",
  "terminal:getForegroundProcess",
  "terminal:getInstanceTranscript",
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
