import { timingSafeEqual } from "node:crypto"
import type { IncomingMessage } from "node:http"

export function tokensEqual(expected: string, provided: string): boolean {
  const left = Buffer.from(expected)
  const right = Buffer.from(provided)
  if (left.length !== right.length) {
    timingSafeEqual(left, left)
    return false
  }
  return timingSafeEqual(left, right)
}

export function requestAuthToken(
  req: IncomingMessage,
  url?: URL,
): string | null {
  const header = req.headers.authorization
  if (typeof header === "string") {
    const bearer = header.match(/^Bearer\s+(.+)$/i)
    if (bearer?.[1]) return bearer[1].trim()
  }
  const custom = req.headers["x-yaade-token"]
  if (typeof custom === "string" && custom.trim()) return custom.trim()
  if (Array.isArray(custom) && custom[0]?.trim()) return custom[0].trim()
  const query = url?.searchParams.get("token")
  return query?.trim() || null
}

export function isAuthorizedRequest(
  req: IncomingMessage,
  expectedToken: string | null,
  url?: URL,
): boolean {
  if (!expectedToken) return true
  const provided = requestAuthToken(req, url)
  return Boolean(provided && tokensEqual(expectedToken, provided))
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "")
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1"
}

function isLocalBrowserHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "")
  return isLoopbackHostname(normalized) || normalized === "ide.local"
}

export function isDesktopAppOrigin(url: URL): boolean {
  if (url.protocol === "tauri:") return url.hostname === "localhost"
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.hostname === "tauri.localhost"
  )
}

export function isAllowedWebSocketOrigin(
  origin: string | undefined,
  requestHost?: string,
  allowedOrigins: readonly string[] = [],
): boolean {
  if (!origin) return true
  try {
    const url = new URL(origin)
    if (isDesktopAppOrigin(url)) return true
    if (url.protocol !== "http:" && url.protocol !== "https:") return false
    if (isLocalBrowserHostname(url.hostname)) return true
    if (allowedOrigins.includes("*")) return true
    if (allowedOrigins.some(candidate => candidate === origin)) return true
    return Boolean(requestHost && url.host.toLowerCase() === requestHost.trim().toLowerCase())
  } catch {
    return false
  }
}

export function isAllowedCorsOrigin(
  origin: string | undefined,
  allowedOrigins: readonly string[] = [],
): boolean {
  if (!origin) return false
  try {
    const url = new URL(origin)
    if (isDesktopAppOrigin(url)) return true
    if (url.protocol !== "http:" && url.protocol !== "https:") return false
    if (isLocalBrowserHostname(url.hostname)) return true
  } catch {
    return false
  }
  if (allowedOrigins.includes("*")) return true
  return allowedOrigins.includes(origin)
}

export function isAllowedHttpRequestOrigin(
  origin: string | undefined,
  bindHost: string,
  allowedOrigins: readonly string[] = [],
): boolean {
  if (!origin) return true
  if (!isAllowedCorsOrigin(origin, allowedOrigins)) return false
  if (isLoopbackHostname(bindHost)) return true
  try {
    const url = new URL(origin)
    if (isDesktopAppOrigin(url)) return true
    return url.protocol !== "http:" || isLoopbackHostname(url.hostname)
  } catch {
    return false
  }
}
