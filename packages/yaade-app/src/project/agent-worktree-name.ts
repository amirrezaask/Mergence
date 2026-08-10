/** Default branch name when launching an agent into a new worktree without a name. */
export function defaultAgentWorktreeName(driverId: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19)
  const safeDriver = driverId.replace(/[^A-Za-z0-9._+-]+/g, "-") || "agent"
  return `yaade/${safeDriver}-${stamp}`
}
