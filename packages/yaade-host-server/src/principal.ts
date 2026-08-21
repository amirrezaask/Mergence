import { randomUUID } from "node:crypto"
import type { DeviceScope } from "./device-auth.js"

export type RequestPrincipal = {
  readonly principalId: string
  readonly deviceId: string | null
  readonly connectionId: string
  readonly scopes: ReadonlySet<DeviceScope>
  readonly authenticationKind:
    | "host-token"
    | "paired-device"
    | "local-development"
}

export function makeHostTokenPrincipal(connectionId: string): RequestPrincipal {
  return {
    principalId: "host-token",
    deviceId: null,
    connectionId,
    scopes: new Set<DeviceScope>(["observe", "control", "admin"]),
    authenticationKind: "host-token",
  }
}

export function makeLocalDevelopmentPrincipal(
  connectionId: string,
): RequestPrincipal {
  return {
    principalId: "local-development",
    deviceId: null,
    connectionId,
    scopes: new Set<DeviceScope>(["observe", "control", "admin"]),
    authenticationKind: "local-development",
  }
}

export function makePairedDevicePrincipal(
  deviceId: string,
  scopes: readonly DeviceScope[],
  connectionId: string,
): RequestPrincipal {
  return {
    principalId: `device:${deviceId}`,
    deviceId,
    connectionId,
    scopes: new Set(scopes),
    authenticationKind: "paired-device",
  }
}

/**
 * Compatibility boundary for direct in-process dispatch tests and legacy
 * callers. The string is an actor correlation key, never an authentication
 * decision; network adapters must resolve a real principal first.
 */
export function makeCompatibilityPrincipal(clientId: string): RequestPrincipal {
  return {
    principalId: `compat:${clientId}`,
    deviceId: null,
    connectionId: clientId,
    scopes: new Set<DeviceScope>(["observe", "control", "admin"]),
    authenticationKind: "local-development",
  }
}

/**
 * HTTP has no long-lived socket identity, so it may carry a caller-provided
 * correlation key. The key is namespaced by the authenticated principal and
 * only selects a server-generated connection ID; it never grants a scope.
 */
export class RequestPrincipalRegistry {
  private readonly connections = new Map<string, string>()
  private readonly maxEntries = 4_096

  resolve(principal: RequestPrincipal, correlationId: string | null): RequestPrincipal {
    if (!correlationId || correlationId.length > 256) return principal
    const key = `${principal.principalId}\u0000${correlationId}`
    let connectionId = this.connections.get(key)
    if (!connectionId) {
      connectionId = `http-${randomUUID()}`
      this.connections.set(key, connectionId)
      while (this.connections.size > this.maxEntries) {
        const oldest = this.connections.keys().next()
        if (oldest.done) break
        this.connections.delete(oldest.value)
      }
    }
    return { ...principal, connectionId }
  }
}
