export type TerminalAttachStatus =
  | "starting"
  | "running"
  | "exited"
  | "failed"
  | "created"

/**
 * attachOnly panels must not treat a missing PTY as a dead session while the
 * host is still binding one. The first ToolUseCreated event has no ptyId;
 * ToolUseUpdated arrives a moment later. The setup effect re-runs when the id
 * appears.
 */
export function shouldWaitForExistingPty(options: {
  readonly attachOnly: boolean
  readonly existingPtyId?: string
  readonly status: TerminalAttachStatus
}): boolean {
  if (!options.attachOnly || options.existingPtyId) return false
  return options.status !== "failed" && options.status !== "exited"
}
