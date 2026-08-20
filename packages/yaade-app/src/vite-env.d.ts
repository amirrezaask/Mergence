/// <reference types="vite/client" />

interface Window {
  yaadeDesktop?: {
    isDesktop: true
    platform: string
    loadServerDefinitions?: () => Promise<unknown>
    saveServerDefinitions?: (
      servers: readonly import("@yaade/shared").YaadeServerDefinition[],
    ) => Promise<void>
  }
}
