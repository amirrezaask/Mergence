/// <reference types="vite/client" />

interface Window {
  yaadeDesktop?: {
    isDesktop: true
    platform: string
    loadServerDefinitions?: () => Promise<unknown>
    saveServerDefinitions?: (
      servers: readonly import("@yaade/shared").YaadeServerDefinition[],
    ) => Promise<void>
    inspectDaemon?: () => Promise<{
      running: boolean
      runningTerminals: number
      origin: string
      pid: number
    }>
    stopDaemon?: () => Promise<void>
  }
}
