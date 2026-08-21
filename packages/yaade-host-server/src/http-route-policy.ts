import type { RouteCapability } from "./route-policy.js"

/** Capability policy for HTTP resources outside the typed RPC route registry. */
export function httpRouteCapability(
  pathname: string,
  method: string,
): RouteCapability | null {
  if (pathname === "/api/v1/rpc") return null
  if (pathname === "/api/v1/security/pairing-code") return "local-admin"
  if (pathname === "/api/v1/security/devices" || /^\/api\/v1\/security\/devices\/[^/]+$/u.test(pathname)) return "admin"
  if (pathname === "/api/v1/security/session/rotate") return "control"
  if (pathname === "/api/v1/system" || pathname === "/api/v1/diagnostics") return "observe"
  if (pathname === "/api/v1/fs/text-file") return method === "GET" ? "observe" : "control"
  if (pathname === "/api/v1/notifications/ingest") return "control"
  if (pathname === "/api/v1/projects/open") return "control"
  if (pathname === "/api/v1/projects") return method === "GET" ? "observe" : "control"
  if (/^\/api\/v1\/projects\/[^/]+\/surface-state$/u.test(pathname)) {
    return method === "GET" ? "observe" : "control"
  }
  if (/^\/api\/v1\/projects\/[^/]+(?:\/file|\/files)?$/u.test(pathname)) {
    return method === "GET" ? "observe" : "control"
  }
  // Protected but unclassified API resources fail closed. Add the route to
  // this table before exposing a new endpoint to paired devices.
  return "admin"
}
