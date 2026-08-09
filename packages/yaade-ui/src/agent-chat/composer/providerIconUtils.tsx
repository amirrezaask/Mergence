import type { ProviderDriverKind } from "./contracts/types.js"
import {
  ClaudeAI,
  CursorIcon,
  GrokIcon,
  type Icon,
  OpenAI,
  OpenCodeIcon,
} from "./ProviderIcons.js"

const MockIcon: Icon = props => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}>
    <path d="M12 8V4H8" />
    <rect width="16" height="12" x="4" y="8" rx="2" />
    <path d="M2 14h2" />
    <path d="M20 14h2" />
    <path d="M15 13v2" />
    <path d="M9 13v2" />
  </svg>
)

export const PROVIDER_ICON_BY_PROVIDER: Partial<Record<string, Icon>> = {
  codex: OpenAI,
  claudeAgent: ClaudeAI,
  opencode: OpenCodeIcon,
  cursor: CursorIcon,
  grok: GrokIcon,
  mock: MockIcon,
}

export type ModelEsque = {
  slug: string
  name: string
  shortName?: string | undefined
  subProvider?: string | undefined
  isLegacy?: boolean | undefined
  isDefault?: boolean | undefined
  isCustom?: boolean | undefined
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function stripLeadingQualifier(value: string, qualifier: string | null | undefined): string {
  const trimmedQualifier = qualifier?.trim()
  if (!trimmedQualifier) return value
  const pattern = new RegExp(`^${escapeRegExp(trimmedQualifier)}(?:\\s*[.:/-]\\s*|\\s+)`, "iu")
  return value.replace(pattern, "").trim() || value
}

export function getDisplayModelName(
  model: ModelEsque,
  options?: { preferShortName?: boolean },
): string {
  const name = options?.preferShortName && model.shortName ? model.shortName : model.name
  return stripLeadingQualifier(name, model.subProvider)
}

export function getTriggerDisplayModelName(model: ModelEsque): string {
  return getDisplayModelName(model, { preferShortName: true })
}

export function getTriggerDisplayModelLabel(model: ModelEsque): string {
  return getTriggerDisplayModelName(model)
}

export function resolveProviderIcon(driverKind: ProviderDriverKind): Icon | null {
  return PROVIDER_ICON_BY_PROVIDER[driverKind] ?? null
}
