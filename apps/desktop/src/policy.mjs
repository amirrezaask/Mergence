import path from "node:path"

const WEB_PROTOCOLS = new Set(["http:", "https:"])

/**
 * @param {string} candidate
 * @param {readonly string[]} allowedOrigins
 */
export function isAllowedAppUrl(candidate, allowedOrigins) {
  try {
    const url = new URL(candidate)
    return WEB_PROTOCOLS.has(url.protocol) && allowedOrigins.includes(url.origin)
  } catch {
    return false
  }
}

/**
 * Return a URL that may be handed to the operating system browser.
 * Electron's shell APIs are intentionally kept behind this protocol allowlist.
 *
 * @param {string} candidate
 */
export function externalHttpUrl(candidate) {
  try {
    const url = new URL(candidate)
    if (!WEB_PROTOCOLS.has(url.protocol)) return null
    if (url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}

/**
 * Desktop launches accept an explicit workspace flag. The `--` form is also
 * supported so paths beginning with a dash cannot be mistaken for flags.
 *
 * @param {readonly string[]} argv
 */
export function workspaceFromArgs(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument) continue

    if (argument === "--workspace") {
      const value = argv[index + 1]
      return value && !value.startsWith("-") ? path.resolve(value) : null
    }

    if (argument.startsWith("--workspace=")) {
      const value = argument.slice("--workspace=".length)
      return value ? path.resolve(value) : null
    }

    if (argument === "--") {
      const value = argv[index + 1]
      return value && value.length > 0 ? path.resolve(value) : null
    }
  }

  return null
}

/**
 * @param {readonly string[]} allowedOrigins
 * @param {boolean} development
 */
export function contentSecurityPolicy(allowedOrigins, development) {
  if (allowedOrigins.length === 0) {
    throw new Error("At least one trusted desktop origin is required")
  }

  const socketOrigins = allowedOrigins.map(origin =>
    origin.replace(/^https:/, "wss:").replace(/^http:/, "ws:"),
  )
  const scriptSources = development
    ? "'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'"
    : "'self' 'unsafe-inline' 'wasm-unsafe-eval'"
  // Remote host definitions are user-controlled and may be added after the
  // window boots. Keep scripts, frames, and navigation allowlisted while
  // allowing the app's typed host client to reach an explicitly configured
  // HTTP(S)/WebSocket endpoint.
  const connectSources = [
    "'self'",
    ...allowedOrigins,
    ...socketOrigins,
    "http:",
    "https:",
    "ws:",
    "wss:",
  ].join(" ")

  return [
    "default-src 'self'",
    `script-src ${scriptSources}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    `connect-src ${connectSources}`,
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ")
}
