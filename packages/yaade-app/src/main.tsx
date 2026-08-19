import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "@yaade/ui/styles.css"
import { AppRoot } from "./AppRoot.js"
import { HostPortsProvider } from "./host-ports.js"
import { AppErrorBoundary } from "./AppErrorBoundary.js"
import { createYaadeApi, createWebTransport } from "@yaade/host-client"
import { applyInitialAppearance } from "./hooks/useAppearanceSettings.js"
import { SystemSignalsProvider } from "./system-signals/SystemSignalsProvider.js"
import { registerPwa } from "./pwa.js"

const startupWindow = window as Window & { __yaadeStartupBootstrapAt?: number }
startupWindow.__yaadeStartupBootstrapAt ??= performance.now()
applyInitialAppearance()

const transport = createWebTransport()
/** Composition adapter kept only for the legacy browser-global seam. */
const hostPorts = createYaadeApi(transport)
window.yaade = hostPorts

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HostPortsProvider ports={hostPorts}>
      <AppErrorBoundary>
        <SystemSignalsProvider>
          <AppRoot />
        </SystemSignalsProvider>
      </AppErrorBoundary>
    </HostPortsProvider>
  </StrictMode>,
)

registerPwa()
