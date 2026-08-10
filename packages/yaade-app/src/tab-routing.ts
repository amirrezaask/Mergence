import type { YaadePanelTree, WorkspaceService } from "@yaade/workspace"
import { normalizeAbsPath } from "@yaade/workspace"
import { fileUriToPath } from "@yaade/shared"
import {
  isTerminalTabId,
  panelTabIds,
  terminalTabId,
} from "@yaade/workspace"
import type { PanelId } from "@yaade/shared"
import { getAllLeafPanels } from "./panel-routing.js"
import { openSessionInLayout } from "./session-layout.js"
import {
  TERMINAL_TAB_TYPE_ID,
  registerTerminalSession,
  terminalCwdForTab,
} from "./tabs/terminal-session.js"

export type OpenTerminalTabOpts = {
  sessionKey?: string
  label?: string
  cwdRootUri?: string
  launchCommand?: string
  launchArgs?: string[] | ((tabId: string) => string[])
  launchEnv?: Record<string, string> | ((tabId: string) => Record<string, string>)
  agentId?: string
  agentTitle?: string
  agentDriverId?: string
  agentCliSessionId?: string
  pendingCliMint?: boolean
  lastActivityAt?: string
}

export function listTerminalTabs(
  tree: YaadePanelTree,
): { panelId: PanelId; tabId: string }[] {
  const result: { panelId: PanelId; tabId: string }[] = []
  for (const panel of getAllLeafPanels(tree)) {
    const view = tree.getView(panel)
    if (view?.kind !== "tabs") continue
    for (const tabId of panelTabIds(view)) {
      if (isTerminalTabId(tabId)) result.push({ panelId: panel, tabId })
    }
  }
  return result
}

function rootUriKey(uri: string): string {
  if (!uri) return ""
  try {
    return normalizeAbsPath(fileUriToPath(uri))
  } catch {
    return uri
  }
}

export function listTerminalTabsForRoot(
  tree: YaadePanelTree,
  rootUri: string,
): { panelId: PanelId; tabId: string }[] {
  const key = rootUriKey(rootUri)
  return listTerminalTabs(tree).filter(
    ({ tabId }) => rootUriKey(terminalCwdForTab(tabId)) === key,
  )
}

export function isActiveTerminalTab(tree: YaadePanelTree, focused: PanelId | null): boolean {
  if (!focused) return false
  const view = tree.getView(focused)
  if (view?.kind !== "tabs") return false
  return isTerminalTabId(view.activeTabId)
}

let nextSessionKeySeq = 0

/** Unique opaque session key — never reuse Date.now alone (same-ms collisions). */
export function allocTerminalSessionKey(): string {
  nextSessionKeySeq += 1
  const uuid =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${nextSessionKeySeq.toString(36)}`
  return `session-${uuid}`
}

/**
 * Create a new terminal/agent session and tile it: empty focused pane fills
 * in-place; an occupied pane splits to the right (one session per pane).
 */
export function openTerminalTab(
  workspace: WorkspaceService,
  tree: YaadePanelTree,
  focused: PanelId | null,
  opts: OpenTerminalTabOpts = {},
): { panelId: PanelId; tabId: string } {
  const sessionKey = opts.sessionKey ?? allocTerminalSessionKey()
  const tabId = terminalTabId(sessionKey)
  const label = opts.label ?? "Terminal"
  const cwdRootUri = opts.cwdRootUri ?? workspace.root?.uri ?? ""
  const launchArgs =
    typeof opts.launchArgs === "function"
      ? opts.launchArgs(tabId)
      : opts.launchArgs
  const launchEnv =
    typeof opts.launchEnv === "function"
      ? opts.launchEnv(tabId)
      : opts.launchEnv
  registerTerminalSession(tabId, cwdRootUri, opts.launchCommand, {
    launchArgs,
    launchEnv,
    agentId: opts.agentId,
    agentTitle: opts.agentTitle ?? label,
    agentDriverId: opts.agentDriverId,
    agentCliSessionId: opts.agentCliSessionId,
    pendingCliMint: opts.pendingCliMint,
    lastActivityAt: opts.lastActivityAt,
  })
  workspace.registerTab({
    id: tabId,
    kind: TERMINAL_TAB_TYPE_ID,
    label,
  })
  const opened = openSessionInLayout(workspace, tree, tabId, focused)
  return { panelId: opened.panelId, tabId: opened.tabId }
}
