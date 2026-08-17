import { useEffect } from "react"
import { GlassMaterialGallery } from "@yaade/ui"
import { basicAgentBridge } from "./basic-agent-bridge.js"
import { ToolSessionApp } from "./tools/ToolSessionApp.js"

/** The Session shell is now the only browser app surface. */
export function AppRoot() {
  useEffect(() => {
    window.__yaadeAgent = basicAgentBridge({ route: "hq", workspace: "/" })
    return () => {
      if (window.__yaadeAgent?.getState().route === "hq") {
        delete window.__yaadeAgent
      }
    }
  }, [])

  if (location.pathname === "/__yaade/glass-gallery") {
    return <GlassMaterialGallery />
  }
  return <ToolSessionApp />
}
