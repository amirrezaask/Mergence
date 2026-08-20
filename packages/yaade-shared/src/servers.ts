/** A server the YAADE client can connect to. Tokens are kept optional so
 * unauthenticated loopback hosts remain easy to add. */
export type YaadeServerDefinition = {
  readonly id: string
  readonly name: string
  readonly url: string
  readonly token?: string
}

export type YaadeServerStatus = "connecting" | "connected" | "offline"

export type YaadeServerConnection = {
  readonly id: string
  readonly name: string
  readonly url: string
  readonly status: YaadeServerStatus
  readonly sessionCount: number
  readonly error?: string
}
