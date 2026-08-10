/**
 * Sync facade over Effect `SessionRuntime` / session state machine.
 * Callers keep Promise/imperative style; status transitions go through
 * `nextSessionStatus` in `effect/session-machine.ts`.
 *
 * Invariant: modal close / goHome does NOT call clear/archive/dispose — only
 * UI detach. PTY lifetime is owned by host until explicit end/archive/restart.
 */
import {
  detectAgentCliProviderFromCommand,
  extractAgentCliSessionIdFromLaunchArgs,
  isAgentCliProvider,
} from "../agent-cli-launch.js"
import type { KnownTabKind } from "@yaade/workspace"
import {
  defaultSessionStore,
  type HydratedTerminalSession,
  type SessionNotifyKind,
  type TerminalSessionState,
} from "../effect/session-runtime.js"
import type { TerminalSessionStatus } from "../effect/session-machine.js"
import { clearAgentSessionTelemetry } from "../agent-snapshot-store.js"

export type {
  TerminalSessionStatus,
  TerminalSessionState,
  HydratedTerminalSession,
  SessionNotifyKind,
}

export const TERMINAL_TAB_TYPE_ID: KnownTabKind = "terminal"

export function subscribeTerminalSessions(
  listener: (tabId: string, kind: SessionNotifyKind) => void,
): () => void {
  return defaultSessionStore.subscribe(listener)
}

export function registerTerminalSession(
  tabId: string,
  cwdRootUri: string,
  launchCommand?: string,
  options?: {
    launchArgs?: string[]
    launchEnv?: Record<string, string>
    parentSessionTabId?: string
    customLabel?: string
    agentId?: string
    agentTitle?: string
    agentDriverId?: string
    agentCliSessionId?: string
    pendingCliMint?: boolean
    lastActivityAt?: string
  },
): void {
  defaultSessionStore.register(tabId, cwdRootUri, launchCommand, options)
}

export function terminalSessionForTab(tabId: string): TerminalSessionState | undefined {
  return defaultSessionStore.get(tabId)
}

export function terminalCwdForTab(tabId: string): string {
  const session = defaultSessionStore.get(tabId)
  return session?.liveCwdUri || session?.cwdRootUri || ""
}

export function terminalSpawnCwdForTab(tabId: string): string {
  return defaultSessionStore.get(tabId)?.cwdRootUri ?? ""
}

export function terminalLaunchCommandForTab(tabId: string): string | undefined {
  return defaultSessionStore.get(tabId)?.launchCommand
}

export function terminalLaunchArgsForTab(tabId: string): string[] | undefined {
  return defaultSessionStore.get(tabId)?.launchArgs
}

export function terminalLaunchEnvForTab(
  tabId: string,
): Record<string, string> | undefined {
  return defaultSessionStore.get(tabId)?.launchEnv
}

export function trackTerminalPtyId(tabId: string, ptyId: string | null): void {
  defaultSessionStore.trackPty(tabId, ptyId)
}

export function terminalPtyIdForTab(tabId: string): string | undefined {
  return defaultSessionStore.get(tabId)?.ptyId
}

/**
 * A live terminal only needs destructive-close confirmation after observable
 * use. Merely creating/attaching a PTY does not count: a fresh shell may emit a
 * prompt before the user has done anything.
 */
export function terminalSessionNeedsCloseConfirmation(
  session: TerminalSessionState | undefined,
): boolean {
  if (!session || (session.status !== "starting" && session.status !== "running")) {
    return false
  }
  return session.hasUserInput || session.hasMeaningfulOutput
}

export function recordTerminalUserInput(tabId: string): void {
  defaultSessionStore.recordUserInput(tabId)
}

export function recordTerminalOutput(tabId: string, chunk?: string): void {
  defaultSessionStore.recordOutput(tabId, chunk)
}

export function setTerminalCustomLabel(tabId: string, label: string): void {
  defaultSessionStore.setCustomLabel(tabId, label)
}

export function updateTerminalLiveCwd(tabId: string, cwdUri: string): void {
  defaultSessionStore.updateLiveCwd(tabId, cwdUri)
}

export function setAgentSessionTitle(tabId: string, title: string): void {
  defaultSessionStore.setAgentTitle(tabId, title)
}

export function bindAgentToSession(
  tabId: string,
  binding: { agentId: string; driverId: string; threadId?: string },
): void {
  defaultSessionStore.bindAgent(tabId, binding)
}

export function agentCliSessionIdForTab(tabId: string): string | undefined {
  return defaultSessionStore.get(tabId)?.agentCliSessionId
}

export function setAgentCliSessionId(tabId: string, cliSessionId: string): void {
  defaultSessionStore.setAgentCliSessionId(tabId, cliSessionId)
}

export function setPendingCliMint(tabId: string, pending: boolean): void {
  defaultSessionStore.setPendingCliMint(tabId, pending)
}

export function updateTerminalLaunchArgs(tabId: string, launchArgs: string[]): void {
  defaultSessionStore.updateLaunchArgs(tabId, launchArgs)
}

export function sessionHasResumableAgentCli(tabId: string): boolean {
  const session = defaultSessionStore.get(tabId)
  if (!session?.agentId) return false
  if (session.agentCliSessionId) return true
  const provider = isAgentCliProvider(session.agentId)
    ? session.agentId
    : detectAgentCliProviderFromCommand(session.launchCommand)
  return Boolean(
    extractAgentCliSessionIdFromLaunchArgs(provider, session.launchArgs),
  )
}

export function terminalTabIdForPty(ptyId: string): string | undefined {
  return defaultSessionStore.tabIdForPty(ptyId)
}

export function markTerminalExited(ptyId: string, exitCode: number, signal?: number): void {
  defaultSessionStore.markExited(ptyId, exitCode, signal)
}

export function markTerminalFailed(tabId: string): void {
  defaultSessionStore.markFailed(tabId)
}

/**
 * Hydrate / attach-miss: clear stale PTY and leave session as `starting` so the
 * home card survives reload and TerminalPanel can respawn (or resume CLI).
 * Never deletes the session.
 */
export function markTerminalUnavailable(tabId: string): void {
  markTerminalAwaitingResume(tabId)
}

export function markTerminalAwaitingResume(tabId: string): void {
  defaultSessionStore.markAwaitingResume(tabId)
}

export function restartTerminalSession(tabId: string): void {
  defaultSessionStore.restart(tabId)
}

export function resumeArchivedSession(tabId: string): void {
  defaultSessionStore.resumeArchived(tabId)
}

export function clearTerminalSession(tabId: string): void {
  defaultSessionStore.clear(tabId)
  clearAgentSessionTelemetry(tabId)
}

export function listTerminalSessions(): TerminalSessionState[] {
  return defaultSessionStore.list()
}

export function isSessionArchived(tabId: string): boolean {
  return Boolean(defaultSessionStore.get(tabId)?.archivedAt)
}

export function archiveSession(tabId: string): void {
  defaultSessionStore.archive(tabId)
  clearAgentSessionTelemetry(tabId)
}

/** @deprecated Use `isSessionArchived`. */
export const isSessionDone = isSessionArchived

/** @deprecated Use `archiveSession`. */
export const markSessionDone = archiveSession

/**
 * Create a regular shell that belongs to an ADE session. These shells are kept
 * out of the Mission Control roster: they are Terminal-tool tabs, not sessions.
 */
export function addSessionTerminal(
  parentSessionTabId: string,
  options?: { minimumOrdinal?: number },
): TerminalSessionState | undefined {
  return defaultSessionStore.addSessionTerminal(parentSessionTabId, options)
}

export function listSessionTerminals(parentSessionTabId: string): TerminalSessionState[] {
  return defaultSessionStore.listSessionTerminals(parentSessionTabId)
}

export function activeSessionTerminalTabId(parentSessionTabId: string): string | undefined {
  return defaultSessionStore.activeSessionTerminalTabId(parentSessionTabId)
}

export function setActiveSessionTerminal(parentSessionTabId: string, tabId: string): void {
  defaultSessionStore.setActiveSessionTerminal(parentSessionTabId, tabId)
}

export function removeSessionTerminal(parentSessionTabId: string, tabId: string): void {
  defaultSessionStore.removeSessionTerminal(parentSessionTabId, tabId)
}

/** Includes the primary agent/terminal PTY and all Terminal-tool shell PTYs. */
export function terminalPtyIdsForSession(parentSessionTabId: string): string[] {
  return defaultSessionStore.ptyIdsForSession(parentSessionTabId)
}

/** Restore session fields after a tab has been re-opened (refresh hydrate). */
export function hydrateTerminalSession(entry: HydratedTerminalSession): void {
  defaultSessionStore.hydrate(entry)
}

export function bumpTerminalActivity(tabId: string): void {
  defaultSessionStore.bumpActivity(tabId)
}
