import type { ProviderDriverKind, ProviderInstanceId } from "./contracts/types.js"

export type ProviderInstanceEntry = {
  instanceId: ProviderInstanceId
  driverKind: ProviderDriverKind
  displayName: string
  accentColor?: string
  available: boolean
  unavailableReason?: string
  /** Yaade driver id used for createThread */
  yaadeDriverId: string
  providerId: string
}
