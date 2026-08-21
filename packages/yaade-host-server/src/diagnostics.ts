const SECRET_KEY = /token|secret|authorization|cookie|password|private.?key|credential|session/i

export function redactDiagnostics(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === "string") {
    let next = value
    for (const secret of secrets) {
      if (secret && next.includes(secret)) next = next.split(secret).join("[redacted]")
    }
    return next
  }
  if (Array.isArray(value)) return value.map(item => redactDiagnostics(item, secrets))
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(record)) {
      out[key] = SECRET_KEY.test(key) ? "[redacted]" : redactDiagnostics(nested, secrets)
    }
    return out
  }
  return value
}

export type DiagnosticBundleInput = {
  generatedAt: string
  identity: unknown
  health: unknown
  config: unknown
  devices: unknown
  capabilities: unknown
}

export function diagnosticBundle(
  input: DiagnosticBundleInput,
  secrets: readonly string[] = [],
): unknown {
  return redactDiagnostics(input, secrets)
}
