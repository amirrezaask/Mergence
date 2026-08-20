import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "@yaade/ui/styles.css"
import { AppRoot } from "./AppRoot.js"
import { HostPortsProvider } from "./host-ports.js"
import { AppErrorBoundary } from "./AppErrorBoundary.js"
import {
  createMultiServerHostClient,
  loadStoredServerDefinitions,
} from "@yaade/host-client"
import { applyInitialAppearance } from "./hooks/useAppearanceSettings.js"
import { SystemSignalsProvider } from "./system-signals/SystemSignalsProvider.js"
import { registerPwa } from "./pwa.js"
import { ServerConnectionsProvider } from "./server-connections.js"

const startupWindow = window as Window & { __yaadeStartupBootstrapAt?: number }
startupWindow.__yaadeStartupBootstrapAt ??= performance.now()
applyInitialAppearance()

const currentServer = {
  id: "current-host",
  name: "This client",
  url: window.location.origin,
}
const serverConnections = createMultiServerHostClient({
  currentServer,
  servers: window.yaadeDesktop ? [] : loadStoredServerDefinitions(),
  globalTarget: {
    setYaade: value => {
      window.yaade = value
    },
  },
})
window.yaade = serverConnections.ports

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ServerConnectionsProvider manager={serverConnections}>
      <HostPortsProvider ports={serverConnections.ports}>
        <AppErrorBoundary>
          <SystemSignalsProvider>
            <AppRoot />
          </SystemSignalsProvider>
        </AppErrorBoundary>
      </HostPortsProvider>
    </ServerConnectionsProvider>
  </StrictMode>,
)

registerPwa()
