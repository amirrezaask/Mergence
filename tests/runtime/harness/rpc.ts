import { ArchiveSession, SessionId } from "../../../packages/yaade-rpc/src/tool-session.js"
import { Schema } from "effect"
import { waitUntil } from "./wait.js"

export type RpcSuccess = { value: unknown }
export type RpcFailure = { error: unknown }

export async function hostRpcResult(
  origin: string,
  channel: string,
  args: unknown[],
  clientId = "legacy:runtime-e2e",
  token?: string,
): Promise<{ ok: true; value: unknown } | { ok: false; status: number; error: unknown }> {
  let response: Response
  try {
    response = await fetch(`${origin}/api/v1/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ channel, args, clientId }),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${channel} failed: ${message}`)
  }
  const body = (await response.json()) as RpcSuccess | RpcFailure
  if (!response.ok || "error" in body) {
    return { ok: false, status: response.status, error: "error" in body ? body.error : body }
  }
  return { ok: true, value: body.value }
}

export function rpcErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined
  if ("code" in error && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code
  }
  return undefined
}

export async function readSystem(origin: string): Promise<{
  capabilities: {
    features: {
      terminalCheckpoints: boolean
      nativeAgentResume: boolean
    }
  }
  identity: { serverId: string; serverEpoch: string }
}> {
  const response = await fetch(`${origin}/api/v1/system`)
  if (!response.ok) throw new Error(`/api/v1/system ${response.status}`)
  return (await response.json()) as {
    capabilities: {
      features: {
        terminalCheckpoints: boolean
        nativeAgentResume: boolean
      }
    }
    identity: { serverId: string; serverEpoch: string }
  }
}

export async function hostRpc(
  origin: string,
  channel: string,
  args: unknown[],
  clientId = "legacy:runtime-e2e",
): Promise<unknown> {
  const result = await hostRpcResult(origin, channel, args, clientId)
  if (!result.ok) {
    throw new Error(`${channel} failed: ${JSON.stringify(result.error)}`)
  }
  return result.value
}

export async function readHealth(origin: string): Promise<{
  status: string
  identity: { serverId: string; serverEpoch: string }
  health: {
    status: string
    supervisor: { status: string; message: string }
    runningTerminals: number
  }
}> {
  const response = await fetch(`${origin}/health`)
  if (!response.ok) throw new Error(`/health ${response.status}`)
  return (await response.json()) as {
    status: string
    identity: { serverId: string; serverEpoch: string }
    health: {
      status: string
      supervisor: { status: string; message: string }
      runningTerminals: number
    }
  }
}

export async function listProjects(
  origin: string,
): Promise<Array<{ id: string; name: string; rootPath: string }>> {
  const response = await fetch(`${origin}/api/v1/projects`)
  if (!response.ok) throw new Error(`list projects failed (${response.status})`)
  return (await response.json()) as Array<{ id: string; name: string; rootPath: string }>
}

export async function createProject(
  origin: string,
  rootPath: string,
  token?: string,
): Promise<{ id: string; name: string; rootPath: string }> {
  const response = await fetch(`${origin}/api/v1/projects`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ rootPath }),
  })
  if (!response.ok) {
    throw new Error(`could not register project (${response.status})`)
  }
  return (await response.json()) as { id: string; name: string; rootPath: string }
}

export type TerminalInstanceInfo = {
  id: string
  generation: number
  projectId: string
  toolUseId: string | null
  launchRequestId: string | null
  ptyId: string | null
  processIdentity: {
    pid: number
    platform: "linux" | "darwin" | "windows"
    startToken: string
    bootId?: string
    executablePath?: string
  } | null
  processState: string
  title: string
  provider?: string | null
  nativeSessionId?: string | null
  telemetryState?: string
  activityState?: string
  restartPolicy?: string
}

export type ToolUseInfo = {
  id: string
  sessionId: string
  tabId?: string
  kind: string
  status: string
  output: {
    kind: string
    terminalInstanceId?: string
    ptyId?: string
    generation?: number
    processState?: string
  }
}

export type SessionInfo = {
  id: string
  title: string
  activeTabId?: string
}

export type AttachSnapshot = {
  id: string
  output: string
  outputChunks: string[]
  lastSequence: number
  cols?: number
  rows?: number
  status: "running" | "exited"
  terminalEpoch?: string
  replayQuality?: "exact" | "checkpoint" | "degraded"
  replayTruncated?: boolean
  checkpoint?: {
    checkpointVersion?: number
    sequence?: number
    cols?: number
    rows?: number
    syntheticAnsi?: string
  }
}

export async function listSessions(
  origin: string,
  includeArchived = false,
): Promise<Array<{ session: SessionInfo; tabs: Array<{ id: string }>; toolUses: ToolUseInfo[] }>> {
  return (await hostRpc(origin, "tools:listSessions", [includeArchived])) as Array<{
    session: SessionInfo
    tabs: Array<{ id: string }>
    toolUses: ToolUseInfo[]
  }>
}

export async function createSession(origin: string, title: string): Promise<SessionInfo> {
  return (await hostRpc(origin, "tools:createSession", [title])) as SessionInfo
}

export async function createToolUse(origin: string, body: unknown): Promise<ToolUseInfo> {
  return (await hostRpc(origin, "tools:createUse", [body])) as ToolUseInfo
}

export async function createTerminalInstance(
  origin: string,
  body: Record<string, unknown>,
): Promise<TerminalInstanceInfo> {
  return (await hostRpc(origin, "terminal:createInstance", [body])) as TerminalInstanceInfo
}

export async function listTerminalInstances(
  origin: string,
  projectId: string,
): Promise<TerminalInstanceInfo[]> {
  return (await hostRpc(origin, "terminal:listInstances", [projectId])) as TerminalInstanceInfo[]
}

export async function attachTerminal(
  origin: string,
  ptyId: string,
  afterSequence?: number,
  clientId?: string,
): Promise<AttachSnapshot | null> {
  const args = afterSequence == null ? [ptyId] : [ptyId, afterSequence]
  const attached = (await hostRpc(origin, "terminal:attach", args, clientId)) as AttachSnapshot | null
  if (!attached) return null
  return {
    ...attached,
    output: [
      attached.checkpoint?.syntheticAnsi ?? "",
      (attached.outputChunks ?? []).join(""),
      attached.output,
    ].join(""),
  }
}

export async function waitForAttach(
  origin: string,
  ptyId: string,
  timeoutMs = 15_000,
): Promise<AttachSnapshot> {
  let attached: AttachSnapshot | null = null
  await waitUntil(async () => {
    attached = await attachTerminal(origin, ptyId)
    return attached?.status === "running" || attached?.status === "exited"
  }, timeoutMs, `attach ${ptyId}`)
  if (!attached) throw new Error(`terminal ${ptyId} did not attach`)
  return attached
}

export async function getToolUse(origin: string, toolUseId: string): Promise<ToolUseInfo | null> {
  return (await hostRpc(origin, "tools:getUse", [toolUseId])) as ToolUseInfo | null
}

export async function writeTerminal(
  origin: string,
  ptyId: string,
  data: string,
  clientId?: string,
): Promise<unknown> {
  return hostRpc(origin, "terminal:write", [ptyId, data], clientId)
}

export async function writeTerminalResult(
  origin: string,
  ptyId: string,
  data: string,
  clientId: string,
) {
  return hostRpcResult(origin, "terminal:write", [ptyId, data], clientId)
}

export async function resizeTerminal(
  origin: string,
  ptyId: string,
  cols: number,
  rows: number,
  clientId?: string,
): Promise<unknown> {
  return hostRpc(origin, "terminal:resize", [ptyId, cols, rows], clientId)
}

export async function resizeTerminalResult(
  origin: string,
  ptyId: string,
  cols: number,
  rows: number,
  clientId: string,
) {
  return hostRpcResult(origin, "terminal:resize", [ptyId, cols, rows], clientId)
}

export async function acquireLease(
  origin: string,
  ptyId: string,
  clientId: string,
  mode?: "writer" | "observer",
) {
  const args = mode ? [ptyId, mode] : [ptyId]
  return hostRpc(origin, "terminal:acquireLease", args, clientId)
}

export async function requestControl(origin: string, ptyId: string, clientId: string) {
  return hostRpcResult(origin, "terminal:requestControl", [ptyId], clientId)
}

export async function transferControl(
  origin: string,
  ptyId: string,
  leaseId: string,
  fromClientId: string,
  targetClientId: string,
) {
  return hostRpc(origin, "terminal:transferControl", [ptyId, leaseId, targetClientId], fromClientId)
}

export async function listViewers(origin: string, ptyId: string, clientId?: string) {
  return (await hostRpc(origin, "terminal:listViewers", [ptyId], clientId)) as string[]
}

export async function closeTerminalInstance(
  origin: string,
  id: string,
  generation: number,
): Promise<unknown> {
  return hostRpc(origin, "terminal:closeInstance", [{ id, generation }])
}

export async function ingestNative(
  origin: string,
  body: {
    provider: string
    sessionId: string
    payload: unknown
    processId?: string
  },
): Promise<{ eventCount: number; nativeSessionId: string | null }> {
  return (await hostRpc(origin, "agents:ingestNative", [body])) as {
    eventCount: number
    nativeSessionId: string | null
  }
}

export async function resumeTerminalInstance(
  origin: string,
  id: string,
  generation: number,
): Promise<TerminalInstanceInfo> {
  return (await hostRpc(origin, "terminal:resumeInstance", [{ id, generation }])) as TerminalInstanceInfo
}

export async function restartTerminalInstance(
  origin: string,
  id: string,
  generation: number,
): Promise<TerminalInstanceInfo> {
  return (await hostRpc(origin, "terminal:restartInstance", [{ id, generation }])) as TerminalInstanceInfo
}

export async function getAgentSnapshot(
  origin: string,
  sessionId: string,
): Promise<{ nativeSessionId?: string | null; status?: string } | null> {
  return (await hostRpc(origin, "agents:getSnapshot", [sessionId])) as {
    nativeSessionId?: string | null
    status?: string
  } | null
}

export async function notificationCounts(origin: string): Promise<{
  totalUnread?: number
  actionRequired?: number
}> {
  return (await hostRpc(origin, "notifications:counts", [])) as {
    totalUnread?: number
    actionRequired?: number
  }
}

export async function listLiveAgents(origin: string): Promise<TerminalInstanceInfo[]> {
  return (await hostRpc(origin, "agents:listLive", [])) as TerminalInstanceInfo[]
}

export async function archiveSession(
  origin: string,
  sessionId: string,
  mode: "keep-running" | "stop-tools" = "keep-running",
): Promise<unknown> {
  return hostRpc(origin, "tools:archiveSession", [
    ArchiveSession.make({
      sessionId: Schema.decodeUnknownSync(SessionId)(sessionId),
      mode,
    }),
  ])
}
