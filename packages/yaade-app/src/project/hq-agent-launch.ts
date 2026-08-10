import type { AgentCliDriver } from "@yaade/ui/agent-picker"

export type HqAgentLaunchIntent = {
  id: string
  projectId: string
  driverId: AgentCliDriver["id"]
  useWorktree?: boolean
  worktreeName?: string
}

/**
 * Module-level HQ → project agent launch queue.
 *
 * React StrictMode remounts wipe component state (`launchRequest`, local claim
 * sets) while an in-flight `openCheckoutSession` still opens the worktree.
 * Keeping the intent here means a remounted ProjectPage can re-seed the mux
 * launch request instead of stranding the user on an empty worktree.
 */
let pending: HqAgentLaunchIntent | null = null
const claimedIds = new Set<string>()

export function queueHqAgentLaunch(intent: HqAgentLaunchIntent): void {
  pending = intent
  claimedIds.delete(intent.id)
}

export function peekHqAgentLaunch(
  projectId: string,
): HqAgentLaunchIntent | null {
  return pending?.projectId === projectId ? pending : null
}

/** Returns true once per intent id — blocks duplicate worktree creates. */
export function claimHqAgentLaunch(intentId: string): boolean {
  if (!intentId || claimedIds.has(intentId)) return false
  claimedIds.add(intentId)
  return true
}

export function clearHqAgentLaunch(intentId?: string): void {
  if (!pending) {
    if (intentId) claimedIds.delete(intentId)
    return
  }
  if (intentId && pending.id !== intentId) return
  if (intentId) claimedIds.delete(intentId)
  else if (pending) claimedIds.delete(pending.id)
  pending = null
}
