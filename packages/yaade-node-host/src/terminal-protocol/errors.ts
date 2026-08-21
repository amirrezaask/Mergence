export type SupervisorProtocolErrorCode =
  | "FRAME_TOO_LARGE"
  | "FRAME_TRUNCATED"
  | "INVALID_JSON"
  | "INVALID_MESSAGE"
  | "DEADLINE_EXPIRED"
  | "UNSUPPORTED_PROTOCOL"
  | "CAPABILITY_REQUIRED"
  | "PENDING_REQUEST_LIMIT"

export class SupervisorProtocolError extends Error {
  constructor(
    readonly code: SupervisorProtocolErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "SupervisorProtocolError"
  }
}
