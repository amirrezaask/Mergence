const SECRET_PATTERNS = [
  /\b(api[_-]?key|token|secret|password|passwd|authorization|bearer)\b\s*[=:]\s*\S+/gi,
  /\b(sk-[a-zA-Z0-9_-]{8,})\b/g,
  /\b(ghp_[a-zA-Z0-9]{20,})\b/g,
  /\b(xox[baprs]-[a-zA-Z0-9-]{10,})\b/g,
]

/** Redact secrets and truncate for safe UI/command previews. */
export function redactCommandPreview(
  command: string | null | undefined,
  maxLen = 80,
): string | null {
  if (command == null) return null
  let text = command.replace(/[\u0000-\u001f\u007f]/g, " ").trim()
  if (!text) return null
  for (const re of SECRET_PATTERNS) {
    text = text.replace(re, "[redacted]")
  }
  if (text.length > maxLen) {
    return `${text.slice(0, maxLen - 1)}…`
  }
  return text
}

/** Strip control chars and bound free-form metadata strings. */
export function sanitizeMetadataValue(
  value: string | number | boolean | null | undefined,
  maxLen = 240,
): string | number | boolean | null {
  if (value == null) return null
  if (typeof value === "number" || typeof value === "boolean") return value
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim()
  if (!cleaned) return null
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned
}
