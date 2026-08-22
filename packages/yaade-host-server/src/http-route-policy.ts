import type { RouteCapability } from "./route-policy.js"

/** Capability policy for HTTP resources outside the typed RPC route registry. */
export function httpRouteCapability(
  pathname: string,
  _method: string,
): RouteCapability | null {
  if (pathname === "/api/v1/rpc") return null
  if (pathname === "/api/v1/security/pairing-code") return "local-admin"
  if (pathname === "/api/v1/security/devices" || /^\/api\/v1\/security\/devices\/[^/]+$/u.test(pathname)) return "admin"
  if (pathname === "/api/v1/security/session/rotate") return "control"
  if (pathname === "/api/v1/system" || pathname === "/api/v1/diagnostics") return "observe"
  return pathname.startsWith("/api/") ? "admin" : null
}
