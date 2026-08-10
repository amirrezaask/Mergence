export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "")
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1"
}

function isLocalBrowserHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "")
  return isLoopbackHostname(normalized) || normalized === "ide.local"
}

export function isAllowedWebSocketOrigin(
  origin: string | undefined,
  requestHost?: string,
): boolean {
  if (!origin) return true
  try {
    const url = new URL(origin)
    if (url.protocol !== "http:" && url.protocol !== "https:") return false
    if (isLocalBrowserHostname(url.hostname)) return true
    return Boolean(requestHost && url.host.toLowerCase() === requestHost.trim().toLowerCase())
  } catch {
    return false
  }
}
