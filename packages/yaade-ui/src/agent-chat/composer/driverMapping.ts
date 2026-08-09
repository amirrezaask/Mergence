import {
  getCatalogModels,
  getDefaultModelSlug,
  type ComposerProviderId,
} from "./contracts/models-catalog.js"
import { ProviderDriverKind, ProviderInstanceId } from "./contracts/types.js"
import type { ProviderInstanceEntry } from "./providerInstances.js"
import type { ModelEsque } from "./providerIconUtils.js"

/** Map yaade driver id / provider id → composer catalog provider key */
export function catalogProviderForDriver(input: {
  driverId: string
  providerId: string
  integration?: string
}): ComposerProviderId | null {
  const haystack = `${input.driverId} ${input.providerId} ${input.integration ?? ""}`.toLowerCase()
  if (haystack.includes("mock")) return "mock"
  if (haystack.includes("cursor")) return "cursor"
  if (haystack.includes("codex")) return "codex"
  if (haystack.includes("claude")) return "claudeAgent"
  if (haystack.includes("grok")) return "grok"
  if (haystack.includes("opencode")) return "opencode"
  return null
}

export type YaadeDriverDescriptor = {
  id: string
  name: string
  providerId: string
  integration?: string
  available: boolean
  reason?: string
}

export function buildProviderInstanceEntries(
  drivers: ReadonlyArray<YaadeDriverDescriptor>,
): {
  instanceEntries: ProviderInstanceEntry[]
  modelOptionsByInstance: Map<string, ModelEsque[]>
} {
  const instanceEntries: ProviderInstanceEntry[] = []
  const modelOptionsByInstance = new Map<string, ModelEsque[]>()

  for (const driver of drivers) {
    const catalogKey = catalogProviderForDriver({
      driverId: driver.id,
      providerId: driver.providerId,
      integration: driver.integration,
    })
    if (!catalogKey) continue
    const instanceId = ProviderInstanceId.make(driver.id)
    instanceEntries.push({
      instanceId,
      driverKind: ProviderDriverKind.make(catalogKey),
      displayName: driver.name,
      available: driver.available,
      unavailableReason: driver.reason,
      yaadeDriverId: driver.id,
      providerId: driver.providerId,
    })
    const models = getCatalogModels(catalogKey).map(model => ({
      slug: model.slug,
      name: model.name,
      shortName: model.shortName,
      subProvider: model.subProvider,
      isLegacy: model.isLegacy,
      isDefault: model.isDefault,
      isCustom: model.isCustom,
      capabilities: model.capabilities,
    }))
    modelOptionsByInstance.set(instanceId, models)
  }

  return { instanceEntries, modelOptionsByInstance }
}

export function defaultSelectionForInstances(
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>,
): { instanceId: string; model: string } | null {
  const available =
    instanceEntries.find(entry => entry.available && entry.driverKind === "mock") ??
    instanceEntries.find(entry => entry.available) ??
    instanceEntries[0]
  if (!available) return null
  return {
    instanceId: available.instanceId,
    model: getDefaultModelSlug(available.driverKind),
  }
}
