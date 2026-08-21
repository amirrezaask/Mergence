import type { DeviceScope } from "./device-auth.js"

const OBSERVE_CHANNELS = new Set([
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
])

/** Host-token callers are unrestricted. Observe may only read. */
export function deviceMayInvoke(
  scopes: readonly DeviceScope[] | undefined,
  channel: string,
): boolean {
  if (!scopes || scopes.length === 0) return true
  if (scopes.includes("admin") || scopes.includes("control")) return true
  if (!scopes.includes("observe")) return false
  return OBSERVE_CHANNELS.has(channel)
}
