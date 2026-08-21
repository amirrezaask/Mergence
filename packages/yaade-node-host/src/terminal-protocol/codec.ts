import {
  MAX_SUPERVISOR_FRAME_BYTES,
  supervisorOperationLimit,
} from "./limits.js"
import {
  isSupervisorCommand,
  isSupervisorEvent,
  isSupervisorResponse,
  type SupervisorProtocolMessage,
} from "./schema.js"
import { SupervisorProtocolError } from "./errors.js"
import type { SupervisorCommand } from "./schema.js"

export function encodeSupervisorProtocolMessage(
  message: SupervisorProtocolMessage,
): Buffer {
  const json = Buffer.from(JSON.stringify(message), "utf8")
  if (json.byteLength > MAX_SUPERVISOR_FRAME_BYTES) {
    throw new SupervisorProtocolError("FRAME_TOO_LARGE", "supervisor frame is too large")
  }
  if (isSupervisorCommand(message)) {
    const limit = supervisorOperationLimit(message.operation)
    if (json.byteLength > limit) {
      throw new SupervisorProtocolError(
        "FRAME_TOO_LARGE",
        `supervisor ${message.operation} command exceeds its limit`,
      )
    }
  }
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32BE(json.byteLength, 0)
  return Buffer.concat([header, json])
}

export function decodeSupervisorProtocolMessage(
  payload: Uint8Array,
): SupervisorProtocolMessage {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(payload).toString("utf8"))
  } catch {
    throw new SupervisorProtocolError("INVALID_JSON", "supervisor payload is not valid JSON")
  }
  if (isSupervisorCommand(value) || isSupervisorResponse(value) || isSupervisorEvent(value)) {
    return value
  }
  throw new SupervisorProtocolError("INVALID_MESSAGE", "unknown supervisor protocol message")
}

export function assertSupervisorDeadline(
  command: Pick<SupervisorCommand, "deadlineUnixMs">,
  now = Date.now(),
): void {
  if (command.deadlineUnixMs <= now) {
    throw new SupervisorProtocolError("DEADLINE_EXPIRED", "supervisor command deadline has expired")
  }
}

export function assertPendingRequestCapacity(
  pendingRequests: number,
  maxPendingRequests: number,
): void {
  if (pendingRequests >= maxPendingRequests) {
    throw new SupervisorProtocolError("PENDING_REQUEST_LIMIT", "too many pending supervisor requests")
  }
}

export class SupervisorProtocolFrameReader {
  private buffer = Buffer.alloc(0)

  push(chunk: Uint8Array): SupervisorProtocolMessage[] {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)])
    const messages: SupervisorProtocolMessage[] = []
    while (this.buffer.byteLength >= 4) {
      const size = this.buffer.readUInt32BE(0)
      if (size > MAX_SUPERVISOR_FRAME_BYTES) {
        this.buffer = Buffer.alloc(0)
        throw new SupervisorProtocolError("FRAME_TOO_LARGE", "declared supervisor frame is too large")
      }
      if (this.buffer.byteLength < 4 + size) break
      const payload = this.buffer.subarray(4, 4 + size)
      this.buffer = this.buffer.subarray(4 + size)
      const message = decodeSupervisorProtocolMessage(payload)
      if (
        message.kind === "command" &&
        payload.byteLength > supervisorOperationLimit(message.operation)
      ) {
        throw new SupervisorProtocolError(
          "FRAME_TOO_LARGE",
          `supervisor ${message.operation} command exceeds its limit`,
        )
      }
      messages.push(message)
    }
    return messages
  }

  finish(): void {
    if (this.buffer.byteLength !== 0) {
      throw new SupervisorProtocolError("FRAME_TRUNCATED", "supervisor stream ended mid-frame")
    }
  }
}
