export type SupervisorOperation =
  | "handshake"
  | "create"
  | "attach"
  | "acquireLease"
  | "renewLease"
  | "releaseLease"
  | "sendInput"
  | "sendPaste"
  | "sendFocus"
  | "sendMouse"
  | "resize"
  | "readSnapshot"
  | "readHistory"
  | "inspect"
  | "subscribe"
  | "dispose"
  | "markDraining"
  | "shutdownWhenEmpty"
  | "listRunning"
  | "listLeases"
  | "currentWriterLease"
  | "forceTakeover"
  | "transferLease"
  | "releaseConnection"
  | "ping"
  | "getCwd"
  | "waitForExit"
  | "shutdown"

export const SUPERVISOR_PROTOCOL_VERSION = 2
export const SUPERVISOR_PROTOCOL_MIN = 1
export const SUPERVISOR_PROTOCOL_MAX = 2
export const MAX_SUPERVISOR_FRAME_BYTES = 16 * 1024 * 1024
export const MAX_HANDSHAKE_BYTES = 64 * 1024
export const MAX_COMMAND_BYTES = 256 * 1024
export const MAX_INPUT_BYTES = 64 * 1024
export const MAX_PASTE_BYTES = 256 * 1024
export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
export const MAX_HISTORY_PAGE_BYTES = 4 * 1024 * 1024
export const MAX_PENDING_REQUESTS = 1_024

export function supervisorOperationLimit(operation: SupervisorOperation): number {
  switch (operation) {
    case "handshake":
      return MAX_HANDSHAKE_BYTES
    case "sendInput":
      return MAX_INPUT_BYTES
    case "sendPaste":
      return MAX_PASTE_BYTES
    case "sendMouse":
      return MAX_COMMAND_BYTES
    case "readSnapshot":
      return MAX_SNAPSHOT_BYTES
    case "readHistory":
      return MAX_HISTORY_PAGE_BYTES
    default:
      return MAX_COMMAND_BYTES
  }
}
