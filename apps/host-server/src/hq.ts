import fs from "node:fs"
import path from "node:path"
import {
  describeAgentActivity,
  type AgentProvider,
  type AgentSessionSnapshot,
} from "@yaade/agents"
import {
  HqAgentSummary,
  HqProjectSummary,
  HqSnapshot,
  type HqAttentionKind,
} from "@yaade/rpc"
import { fileUriToPath } from "@yaade/shared"
import type { HostRuntime } from "./host-runtime.js"
import { pathAllowed } from "./sandbox.js"

const AGENT_COMMANDS: Record<string, AgentProvider> = {
  claude: "claude",
  codex: "codex",
  "cursor-agent": "cursor",
  cursor: "cursor",
  opencode: "opencode",
  grok: "grok",
}

export function inferAgentProvider(
  explicit: string | undefined,
  launchCommand: string | undefined,
): AgentProvider | null {
  if (
    explicit === "claude" ||
    explicit === "codex" ||
    explicit === "cursor" ||
    explicit === "opencode" ||
    explicit === "grok"
  ) {
    return explicit
  }
  if (!launchCommand) return null
  const basename = path.basename(launchCommand).replace(/\.(?:cmd|exe)$/i, "")
  return AGENT_COMMANDS[basename.toLowerCase()] ?? null
}

function canonicalPath(value: string): string {
  try {
    return fs.realpathSync(path.resolve(value))
  } catch {
    return path.resolve(value)
  }
}

function leafCwd(cwdRootUri: string, fallback: string): string {
  try {
    return fileUriToPath(cwdRootUri)
  } catch {
    return fallback
  }
}

function snapshotAttention(
  snapshot: Omit<AgentSessionSnapshot, "_internal"> | null,
  notificationAttention: number,
): HqAttentionKind | null {
  if (snapshot?.attention?.kind === "permission_required") {
    return "permission_required"
  }
  if (snapshot?.attention?.kind === "turn_failed") return "turn_failed"
  if (snapshot?.attention?.kind === "session_failed") return "session_failed"
  if (snapshot?.attention?.kind === "session_terminated") {
    return "session_terminated"
  }
  if (snapshot?.status === "waiting_for_permission") {
    return "permission_required"
  }
  if (snapshot?.status === "waiting_for_user") return "waiting_for_user"
  if (snapshot?.status === "failed") return "turn_failed"
  if (notificationAttention > 0) return "permission_required"
  return null
}

/** Agent CLI finished — hide even if a shell PTY is still running. */
function agentProcessAccessible(
  snapshot: Omit<AgentSessionSnapshot, "_internal"> | null | undefined,
): boolean {
  if (!snapshot) return true
  switch (snapshot.status) {
    case "completed":
    case "failed":
    case "terminated":
    case "disconnected":
      return false
    default:
      return true
  }
}

function availability(
  rootPath: string,
  allowedRoots: string[],
): "available" | "missing" | "forbidden" {
  if (!pathAllowed(rootPath, allowedRoots)) return "forbidden"
  try {
    return fs.statSync(rootPath).isDirectory() ? "available" : "missing"
  } catch {
    return "missing"
  }
}

function newestTimestamp(values: Array<string | null | undefined>): string | null {
  let newest: string | null = null
  for (const value of values) {
    if (value && (!newest || value > newest)) newest = value
  }
  return newest
}

function findProjectForCwd<T extends { rootPath: string }>(
  cwd: string,
  projects: T[],
): T | null {
  const target = canonicalPath(cwd)
  let best: T | null = null
  let bestLen = -1
  for (const project of projects) {
    const root = canonicalPath(project.rootPath)
    if (target === root || target.startsWith(`${root}${path.sep}`)) {
      if (root.length > bestLen) {
        best = project
        bestLen = root.length
      }
    }
  }
  return best
}

export function buildHqSnapshot(runtime: HostRuntime): HqSnapshot {
  const projects = runtime.db.projects()
  const sessions = runtime.db.listAllProjectSessions(runtime.machineHostname)
  const projectById = new Map(projects.map(project => [project.id, project]))
  const sessionById = new Map(sessions.map(session => [session.id, session]))
  const sessionsByProjectPath = new Map<string, typeof sessions>()
  for (const session of sessions) {
    if (session.archivedAt) continue
    const bucket = sessionsByProjectPath.get(session.projectPath)
    if (bucket) bucket.push(session)
    else sessionsByProjectPath.set(session.projectPath, [session])
  }
  const unreadBySession = runtime.notifications.unreadBySession()
  const unreadByProject = runtime.notifications.unreadByProject()
  const attentionBySession = runtime.notifications.attentionBySession()
  const attentionByProject = runtime.notifications.attentionByProject()
  const agents: HqAgentSummary[] = []
  // AgentRunService is the only live source. It has a process-generation
  // binding, unlike old layout leaves and cwd-based PTY guesses.
  const durableRunService = (runtime as unknown as {
    agentRuns?: { listLive: () => ReturnType<HostRuntime["agentRuns"]["listLive"]> }
  }).agentRuns
  for (const run of durableRunService?.listLive() ?? []) {
    if (!run.ptyId) continue
    const inspected = runtime.terminal.inspect(run.ptyId)
    if (!inspected || inspected.status !== "running") continue
    const project = projectById.get(run.projectId)
    const referencedSession = sessionById.get(run.workspaceId)
    const projectSession = referencedSession && !referencedSession.archivedAt
      ? referencedSession
      : sessionsByProjectPath.get(project?.rootPath ?? "")?.[0]
    if (!project || !projectSession) continue
    const snapshot = runtime.agents.getSnapshot(run.runId)
    const unreadCount = unreadBySession[run.runId] ?? 0
    const attention = snapshotAttention(snapshot, attentionBySession[run.runId] ?? 0)
    const status = run.activityState === "working" || run.activityState === "running_tool"
      ? run.activityState
      : run.activityState === "waiting_for_permission" || run.activityState === "waiting_for_user"
        ? run.activityState
        : run.activityState === "failed" ? "failed" : "starting"
    const activity = snapshot
      ? describeAgentActivity(snapshot)
      : run.telemetryState === "degraded"
        ? "Running · limited telemetry"
        : run.telemetryState === "process_only"
          ? "Running · process telemetry"
          : "Telemetry connecting"
    agents.push(HqAgentSummary.make({
      runId: run.runId,
      generation: run.generation,
      sessionId: run.runId,
      ptyId: run.ptyId,
      projectId: project.id,
      projectName: project.name,
      projectPath: project.rootPath,
      projectSessionId: projectSession.id,
      projectSessionTitle: projectSession.title,
      cwdPath: run.checkoutPath,
      worktreeBranch: projectSession.worktreeBranch,
      provider: run.provider,
      title: run.title,
      status,
      activity,
      telemetry: run.telemetryState === "connecting" ? "pending" : run.telemetryState,
      startedAt: run.startedAt,
      lastActivityAt: run.lastActivityAt,
      runtimeMs: run.startedAt ? Math.max(0, Date.now() - Date.parse(run.startedAt)) : 0,
      unreadCount,
      attention,
      currentTool: snapshot?.currentTool
        ? { name: snapshot.currentTool.name, category: snapshot.currentTool.category }
        : null,
    }))
  }

  // Compatibility only for databases/pages that predate agent_runs. New
  // launches never enter this branch; it can disappear after migration rollout.
  if (!durableRunService) {
    const claimedPtyIds = new Set<string>()
    for (const projectSession of sessions) {
      if (projectSession.archivedAt) continue
      for (const leaf of projectSession.payload.sessions) {
        const ptyId = leaf.ptyId
        if (!ptyId || claimedPtyIds.has(ptyId)) continue
        const provider = inferAgentProvider(leaf.agentProvider, leaf.launchCommand)
        if (!provider) continue
        claimedPtyIds.add(ptyId)
        const inspected = runtime.terminal.inspect(ptyId)
        if (!inspected || inspected.status !== "running") continue
        const project = projects.find(candidate => candidate.rootPath === projectSession.projectPath)
        if (!project) continue
        const snapshot = runtime.agents.getSnapshot(leaf.ptyTabId)
        if (!agentProcessAccessible(snapshot)) continue
        const binding = runtime.notifications.bindingForSession(leaf.ptyTabId)
        agents.push(HqAgentSummary.make({
          sessionId: leaf.ptyTabId,
          ptyId,
          projectId: project.id,
          projectName: project.name,
          projectPath: project.rootPath,
          projectSessionId: projectSession.id,
          projectSessionTitle: projectSession.title,
          cwdPath: leafCwd(leaf.cwdRootUri, projectSession.cwdPath),
          worktreeBranch: projectSession.worktreeBranch,
          provider,
          title: binding?.sessionTitle ?? leaf.agentTitle ?? inspected.title ?? provider,
          status: snapshot?.status ?? "starting",
          activity: snapshot ? describeAgentActivity(snapshot) : "Telemetry connecting",
          telemetry: snapshot ? "connected" : "pending",
          startedAt: snapshot?.startedAt ?? null,
          lastActivityAt: snapshot?.lastActivityAt ?? projectSession.updatedAt,
          runtimeMs: snapshot?.runtime.processRuntimeMs ?? 0,
          unreadCount: unreadBySession[leaf.ptyTabId] ?? 0,
          attention: snapshotAttention(snapshot, attentionBySession[leaf.ptyTabId] ?? 0),
          currentTool: snapshot?.currentTool
            ? { name: snapshot.currentTool.name, category: snapshot.currentTool.category }
            : null,
        }))
      }
    }
    const listRunning = runtime.terminal.listRunning?.bind(runtime.terminal)
    if (listRunning) {
      for (const inspected of listRunning()) {
        if (claimedPtyIds.has(inspected.id)) continue
        const provider = inferAgentProvider(undefined, inspected.spawnCommand ?? undefined)
        const project = provider ? findProjectForCwd(inspected.spawnCwd, projects) : null
        if (!provider || !project) continue
        const projectSession = sessions.find(session =>
          !session.archivedAt && session.projectPath === project.rootPath && session.cwdPath === inspected.spawnCwd,
        ) ?? sessions.find(session => !session.archivedAt && session.projectPath === project.rootPath)
        if (!projectSession) continue
        const binding = runtime.notifications.bindingForPty(inspected.id)
        const sessionId = binding?.sessionId ?? `pty:${inspected.id}`
        const snapshot = runtime.agents.getSnapshot(sessionId)
        if (!agentProcessAccessible(snapshot)) continue
        agents.push(HqAgentSummary.make({
          sessionId,
          ptyId: inspected.id,
          projectId: project.id,
          projectName: project.name,
          projectPath: project.rootPath,
          projectSessionId: projectSession.id,
          projectSessionTitle: projectSession.title,
          cwdPath: inspected.spawnCwd,
          worktreeBranch: projectSession.worktreeBranch,
          provider,
          title: binding?.sessionTitle ?? inspected.title ?? provider,
          status: snapshot?.status ?? "starting",
          activity: snapshot ? describeAgentActivity(snapshot) : "Telemetry connecting",
          telemetry: snapshot ? "connected" : "pending",
          startedAt: snapshot?.startedAt ?? null,
          lastActivityAt: snapshot?.lastActivityAt ?? projectSession.updatedAt,
          runtimeMs: snapshot?.runtime.processRuntimeMs ?? 0,
          unreadCount: unreadBySession[sessionId] ?? 0,
          attention: snapshotAttention(snapshot, attentionBySession[sessionId] ?? 0),
          currentTool: snapshot?.currentTool
            ? { name: snapshot.currentTool.name, category: snapshot.currentTool.category }
            : null,
        }))
      }
    }
  }

  const agentsByProjectId = new Map<string, HqAgentSummary[]>()
  for (const agent of agents) {
    const bucket = agentsByProjectId.get(agent.projectId)
    if (bucket) bucket.push(agent)
    else agentsByProjectId.set(agent.projectId, [agent])
  }

  const projectSummaries = projects.map(project => {
    // Project and workspace paths are canonicalized at insertion. Indexed maps
    // keep HQ aggregation O(projects + workspaces + live runs) and avoid
    // filesystem canonicalization inside the summary loop.
    const projectSessions = sessionsByProjectPath.get(project.rootPath) ?? []
    const projectAgents = agentsByProjectId.get(project.id) ?? []
    const liveAttention = projectAgents.filter(agent => agent.attention != null).length
    return HqProjectSummary.make({
      id: project.id,
      name: project.name,
      rootPath: project.rootPath,
      availability: availability(project.rootPath, runtime.config.allowedRoots),
      sessionCount: projectSessions.length,
      liveAgentCount: projectAgents.length,
      attentionCount: Math.max(
        liveAttention,
        attentionByProject[project.id] ?? 0,
      ),
      unreadCount: unreadByProject[project.id] ?? 0,
      lastActivityAt: newestTimestamp([
        project.updatedAt,
        ...projectSessions.map(session => session.updatedAt),
        ...projectAgents.map(agent => agent.lastActivityAt),
      ]),
    })
  })

  return HqSnapshot.make({
    version: 1,
    generatedAt: new Date().toISOString(),
    machineHostname: runtime.machineHostname,
    notificationCounts: runtime.notifications.counts(),
    projects: projectSummaries,
    agents,
  })
}
