import { ToolSessionApp } from "../tools/ToolSessionApp.js"

/** Compatibility export; the Session shell owns project workspaces now. */
export function ProjectPage() {
  return <ToolSessionApp />
}

export default ProjectPage
