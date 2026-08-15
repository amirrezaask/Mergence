export type CapabilityDisposable = { dispose(): void }

export type DynamicRegistration = {
  id: string
  method: string
  registerOptions?: unknown
}

export type DynamicUnregistration = {
  id: string
  method: string
}

export type MonacoDocumentFilter = {
  language?: string
  scheme?: string
  pattern?: string
}

export type MonacoDocumentSelector = Array<string | MonacoDocumentFilter>

type RegistrationOptions = {
  documentSelector?: unknown
}

export function monacoLanguageId(languageId: string): string {
  if (languageId === "tsx" || languageId === "mts" || languageId === "cts") {
    return "typescript"
  }
  if (languageId === "jsx") return "javascript"
  return languageId
}

export function connectionDocumentSelector(
  languageIds: readonly string[],
): MonacoDocumentSelector {
  return [...new Set(languageIds.map(monacoLanguageId))]
}

/** Convert an LSP text-document selector without broadening unsupported filters. */
export function registrationDocumentSelector(
  registerOptions: unknown,
  fallback: MonacoDocumentSelector,
): MonacoDocumentSelector {
  if (!registerOptions || typeof registerOptions !== "object") return fallback
  const selector = (registerOptions as RegistrationOptions).documentSelector
  if (selector == null) return fallback
  if (!Array.isArray(selector)) return []

  const result: MonacoDocumentSelector = []
  for (const filter of selector) {
    if (typeof filter === "string") {
      result.push(monacoLanguageId(filter))
      continue
    }
    if (!filter || typeof filter !== "object") continue
    if ("notebook" in filter) continue

    const language = filter.language
    const scheme = filter.scheme
    const pattern = filter.pattern
    if (pattern != null && typeof pattern !== "string") continue
    if (language != null && typeof language !== "string") continue
    if (scheme != null && typeof scheme !== "string") continue

    const mapped: MonacoDocumentFilter = {}
    if (typeof language === "string") mapped.language = monacoLanguageId(language)
    if (typeof scheme === "string") mapped.scheme = scheme
    if (typeof pattern === "string") mapped.pattern = pattern
    result.push(mapped)
  }
  return result
}

export function documentSelectorMatches(
  selector: MonacoDocumentSelector,
  uri: string,
  languageId: string,
): boolean {
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    return false
  }
  const path = decodeURIComponent(parsed.pathname).replace(/^\//, "")
  return selector.some(filter => {
    if (typeof filter === "string") return filter === monacoLanguageId(languageId)
    if (filter.language && filter.language !== monacoLanguageId(languageId)) return false
    if (filter.scheme && filter.scheme !== parsed.protocol.replace(/:$/, "")) return false
    return !filter.pattern || lspGlobMatches(filter.pattern, path)
  })
}

/** Owns each server registration independently so unregister is exact and leak-free. */
export class DynamicCapabilityStore {
  private readonly registrations = new Map<
    string,
    { method: string; disposable: CapabilityDisposable }
  >()

  constructor(
    private readonly create: (
      registration: DynamicRegistration,
    ) => CapabilityDisposable | undefined,
  ) {}

  register(registrations: readonly DynamicRegistration[]): void {
    for (const registration of registrations) {
      this.unregister([{ id: registration.id, method: registration.method }])
      const disposable = this.create(registration)
      if (disposable) {
        this.registrations.set(registration.id, {
          method: registration.method,
          disposable,
        })
      }
    }
  }

  unregister(unregistrations: readonly DynamicUnregistration[]): void {
    for (const unregistration of unregistrations) {
      const registered = this.registrations.get(unregistration.id)
      if (!registered) continue
      registered.disposable.dispose()
      this.registrations.delete(unregistration.id)
    }
  }

  dispose(): void {
    for (const registration of this.registrations.values()) {
      registration.disposable.dispose()
    }
    this.registrations.clear()
  }

  size(): number {
    return this.registrations.size
  }
}
import { lspGlobMatches } from "./watched-files.js"
