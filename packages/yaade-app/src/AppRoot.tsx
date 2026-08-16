import { useEffect } from "react"
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

  return <ToolSessionApp />
}
