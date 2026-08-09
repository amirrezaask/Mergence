import type { AgentSessionSnapshot } from "../types/snapshot.js"

function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/")
  return parts[parts.length - 1] || path
}

/** Shared user-facing activity label from snapshot state. */
export function describeAgentActivity(snapshot: AgentSessionSnapshot): string {
  if (snapshot.attention?.kind === "permission_required") {
    const tool = snapshot.currentTool?.name
    if (tool) return `Wants to run ${tool}`
    return "Waiting for permission"
  }

  if (snapshot.status === "waiting_for_permission") {
    return "Waiting for permission"
  }

  if (snapshot.status === "waiting_for_user") {
    return "Waiting for you"
  }

  if (snapshot.status === "failed") {
    return "Turn or session failed"
  }

  if (snapshot.status === "terminated") {
    return "Session terminated"
  }

  if (snapshot.status === "completed") {
    return "Session completed"
  }

  if (snapshot.status === "disconnected") {
    return "Disconnected"
  }

  if (snapshot.status === "idle" || snapshot.status === "starting") {
    if (snapshot.status === "starting") return "Starting"
    return "Idle"
  }

  const tool = snapshot.currentTool
  if (tool && (snapshot.status === "running_tool" || snapshot.status === "working")) {
    const file = snapshot.files[0]
    switch (tool.category) {
      case "file_read":
        return file ? `Reading ${basename(file.path)}` : `Reading files`
      case "file_write":
        return file ? `Editing ${basename(file.path)}` : `Editing files`
      case "shell":
        return "Running tests"
      case "search":
        return "Searching the codebase"
      case "web":
        return "Browsing documentation"
      case "mcp":
        return `Calling ${tool.name} MCP`
      case "subagent":
        return "Running a subagent"
      case "task":
        return "Updating task state"
      default:
        return `Running ${tool.name}`
    }
  }

  if (snapshot.status === "working") {
    return "Working"
  }

  return "Running"
}

/** Format duration for compact cards (e.g. 2m 14s, 8m). */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`
  return `${s}s`
}
