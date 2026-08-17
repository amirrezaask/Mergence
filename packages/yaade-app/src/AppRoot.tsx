import { useEffect, useState } from "react"
import { RefreshCw } from "lucide-react"
import { GlassMaterialGallery } from "@yaade/ui"
import { Button } from "@yaade/ui/primitives"
import { basicAgentBridge } from "./basic-agent-bridge.js"
import { ToolSessionApp } from "./tools/ToolSessionApp.js"
import { applyPwaUpdate } from "./pwa.js"

/** The Session shell is now the only browser app surface. */
export function AppRoot() {
  const [updateReady, setUpdateReady] = useState(false)

  useEffect(() => {
    window.__yaadeAgent = basicAgentBridge({ route: "hq", workspace: "/" })
    return () => {
      if (window.__yaadeAgent?.getState().route === "hq") {
        delete window.__yaadeAgent
      }
    }
  }, [])

  useEffect(() => {
    const onUpdate = () => setUpdateReady(true)
    window.addEventListener("yaade:pwa-update", onUpdate)
    return () => window.removeEventListener("yaade:pwa-update", onUpdate)
  }, [])

  if (location.pathname === "/__yaade/glass-gallery") {
    return <GlassMaterialGallery />
  }
  return (
    <>
      <ToolSessionApp />
      {updateReady ? (
        <aside
          className="yaade-pwa-update fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-50 mx-auto flex max-w-sm items-center gap-3 rounded-[var(--yaade-island-radius)] border border-border bg-popover/95 p-2 pl-3 text-popover-foreground shadow-xl backdrop-blur-xl"
          role="status"
          data-yaade-pwa-update=""
        >
          <p className="min-w-0 flex-1 text-xs">A YAADE update is ready.</p>
          <Button
            type="button"
            size="sm"
            onClick={applyPwaUpdate}
          >
            <RefreshCw data-icon="inline-start" />
            Reload
          </Button>
        </aside>
      ) : null}
    </>
  )
}
