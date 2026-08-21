import { Schema } from "effect"
import type {
  AgentDriverCapabilities,
  AgentEvent,
  AgentProvider as TelemetryAgentProvider,
  AgentSessionSnapshot,
} from "@yaade/agent-telemetry"
import type {
  AppNotification as SharedAppNotification,
  NotificationCounts as SharedNotificationCounts,
  NotificationPreferences as SharedNotificationPreferences,
  ListNotificationsResponse,
} from "@yaade/shared"
import type {
  GitCommit,
  GitCommitDetail,
  GitHistoryPage as SharedGitHistoryPage,
  GitNumstatEntry,
  GitRepositorySummary,
  GitStatusEntry as SharedGitStatusEntry,
  GitWorktree,
} from "@yaade/shared"
import {
  AppSession,
  ArchiveSession,
  ArchiveSessionTab,
  ArchiveToolUse,
  CreateSession,
  CreateSessionTab,
  CreateToolUse,
  GetToolUse,
  ListCheckoutTargets,
  ListSessions,
  RenameSession,
  RenameSessionTab,
  ReorderSessions,
  ReorderSessionTabs,
  ReorderToolUses,
  RestoreSession,
  SaveSessionTabLayout,
  SelectSessionTab,
  SelectSessionToolUse,
  SessionTab,
  ToolUse,
  ToolUseId,
  UpdateToolUseContext,
} from "./tool-session.js"
import {
  EmptyTrashResult,
  FsMutationStat,
  RestoreTrashResult,
  TextFileReadResult,
  TextFileWriteOptions,
  TextFileWriteResult,
  TerminalCheckpoint,
  TerminalLease,
  TerminalMutationFence as RpcTerminalMutationFence,
  TrashEntry,
} from "./host.js"

/**
 * The policy applied before a route handler runs.  Keeping this next to the
 * argument and result codecs prevents the HTTP and WebSocket adapters from
 * growing independent lists of path-sensitive operations.
 */
export type HostRoutePathPolicy =
  | { readonly kind: "none" }
  | { readonly kind: "allowed-root"; readonly indices: readonly number[] }
  | { readonly kind: "read-only-path" }
  | { readonly kind: "terminal-id-or-path" }
  | { readonly kind: "trash-restore" }

export type HostRouteOptions = {
  readonly pathPolicy?: HostRoutePathPolicy
  readonly realtime?: boolean
}

type HostRouteDefinition<
  Args extends Schema.Schema.AnyNoContext,
  Result extends Schema.Schema.AnyNoContext,
> = {
  readonly args: Args
  readonly result: Result
  readonly pathPolicy: HostRoutePathPolicy
  readonly realtime: boolean
  readonly decodeArgs: (value: unknown) => unknown[]
  readonly decodeResult: (value: unknown) => unknown
}

type AnyHostRouteDefinition = HostRouteDefinition<
  Schema.Schema.AnyNoContext,
  Schema.Schema.AnyNoContext
>

function route<
  Args extends Schema.Schema.AnyNoContext,
  Result extends Schema.Schema.AnyNoContext,
>(
  args: Args,
  result: Result,
  options: HostRouteOptions = {},
): HostRouteDefinition<Args, Result> {
  return {
    args,
    result,
    pathPolicy: options.pathPolicy ?? { kind: "none" },
    realtime: options.realtime ?? false,
    decodeArgs: value => {
      const decoded = Schema.decodeUnknownSync(args)(value)
      if (!Array.isArray(decoded)) throw new Error("host route arguments must be a tuple")
      return decoded
    },
    decodeResult: value => Schema.decodeUnknownSync(result)(value),
  }
}

const EmptyArgs = Schema.Tuple()
const StringArgs = Schema.Tuple(Schema.String)
const StringStringArgs = Schema.Tuple(Schema.String, Schema.String)
const OptionalStringArgs = Schema.Tuple(Schema.optionalElement(Schema.String))
const UnknownArgs = Schema.Tuple(Schema.Unknown)
const UnknownOptionalArgs = Schema.Tuple(Schema.optionalElement(Schema.Unknown))
const UnknownResult = Schema.Unknown

const WorkspaceEntry = Schema.Struct({
  uri: Schema.String,
  name: Schema.String,
  isDirectory: Schema.Boolean,
})
const WorkspaceStat = Schema.Struct({
  uri: Schema.String,
  isDirectory: Schema.Boolean,
  size: Schema.Number,
})
const TerminalLaunch = Schema.Struct({
  command: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  cols: Schema.optional(Schema.Number),
  rows: Schema.optional(Schema.Number),
})
const TerminalCreateArgs = Schema.Tuple(
  Schema.String,
  Schema.optionalElement(Schema.NullOr(TerminalLaunch)),
)
const ProcessIdentity = Schema.Struct({
  pid: Schema.Number,
  platform: Schema.Literal("linux", "darwin", "windows"),
  bootId: Schema.optional(Schema.String),
  startToken: Schema.String,
  executablePath: Schema.optional(Schema.String),
})
const TerminalCreateResult = Schema.Struct({
  id: Schema.String,
  title: Schema.NullOr(Schema.String),
  osPid: Schema.optional(Schema.NullOr(Schema.Number)),
  osStartedAtMs: Schema.optional(Schema.Number),
  processIdentity: Schema.optional(Schema.NullOr(ProcessIdentity)),
  terminalEpoch: Schema.optional(Schema.String),
})
const TerminalAttachArgs = Schema.Tuple(
  Schema.String,
  Schema.optionalElement(Schema.Number),
)
const TerminalAttachResult = Schema.NullOr(
  Schema.Struct({
    id: Schema.String,
    title: Schema.NullOr(Schema.String),
    terminalEpoch: Schema.optional(Schema.String),
    checkpoint: Schema.optional(TerminalCheckpoint),
    replayQuality: Schema.optional(Schema.Literal("exact", "checkpoint", "degraded")),
    outputChunks: Schema.Array(Schema.String),
    output: Schema.String,
    replayTruncated: Schema.Boolean,
    replayNeedsQueryResponses: Schema.Boolean,
    lastSequence: Schema.Number,
    cols: Schema.optional(Schema.Number),
    rows: Schema.optional(Schema.Number),
    status: Schema.Literal("running", "exited"),
    exitCode: Schema.NullOr(Schema.Number),
    signal: Schema.NullOr(Schema.Number),
  }),
)
const TerminalWriteArgs = Schema.Tuple(
  Schema.String,
  Schema.String,
  Schema.optionalElement(RpcTerminalMutationFence),
)
const TerminalResizeArgs = Schema.Tuple(
  Schema.String,
  Schema.Number,
  Schema.Number,
  Schema.optionalElement(RpcTerminalMutationFence),
)
const TerminalAckArgs = Schema.Tuple(Schema.String, Schema.Number)
const TerminalInstanceIdArgs = Schema.Tuple(Schema.String)
const TerminalInstanceRequestArgs = Schema.Tuple(Schema.Unknown)

const GitDiffOptions = Schema.Struct({
  path: Schema.optional(Schema.String),
  staged: Schema.optional(Schema.Boolean),
})
const GitShowOptions = Schema.Struct({
  path: Schema.optional(Schema.String),
  ref: Schema.optional(Schema.String),
})
const GitFileStatus = Schema.Literal(
  "modified",
  "added",
  "deleted",
  "renamed",
  "untracked",
  "conflict",
)
const GitFile = Schema.Struct({
  path: Schema.String,
  status: Schema.String,
  originalPath: Schema.optional(Schema.String),
})
const GitPatchOptions = Schema.Struct({
  reverse: Schema.optional(Schema.Boolean),
  cached: Schema.optional(Schema.Boolean),
})
const GitWorktreeAddOptions = Schema.Struct({
  branch: Schema.String,
  baseRef: Schema.optional(Schema.String),
  createBranch: Schema.optional(Schema.Boolean),
})
const GitWorktreeRemoveOptions = Schema.Struct({
  force: Schema.optional(Schema.Boolean),
})
const GitStatusEntry = Schema.Struct({
  path: Schema.String,
  status: GitFileStatus,
  originalPath: Schema.optional(Schema.String),
  staged: Schema.Boolean,
  unstaged: Schema.Boolean,
  indexStatus: Schema.optional(GitFileStatus),
  worktreeStatus: Schema.optional(GitFileStatus),
})
const GitCommit = Schema.Struct({
  hash: Schema.String,
  shortHash: Schema.String,
  author: Schema.String,
  authoredAt: Schema.Number,
  subject: Schema.String,
})
const GitHistoryPage = Schema.Struct({
  commits: Schema.Array(GitCommit),
  nextCursor: Schema.NullOr(Schema.String),
  snapshotHead: Schema.NullOr(Schema.String),
})
const GitSummary = Schema.Struct({
  branch: Schema.NullOr(Schema.String),
  upstream: Schema.NullOr(Schema.String),
  ahead: Schema.Number,
  behind: Schema.Number,
})
const GitNumstat = Schema.Struct({
  path: Schema.String,
  added: Schema.NullOr(Schema.Number),
  deleted: Schema.NullOr(Schema.Number),
})
const GitWorktree = Schema.Struct({
  path: Schema.String,
  head: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  bare: Schema.Boolean,
  detached: Schema.Boolean,
  locked: Schema.Boolean,
  prunable: Schema.Boolean,
})
const GitCommitDetail = Schema.Struct({
  hash: Schema.String,
  subject: Schema.String,
  body: Schema.String,
  files: Schema.Array(GitFile),
})

const SessionSnapshot = Schema.Struct({
  session: AppSession,
  tabs: Schema.Array(SessionTab),
  toolUses: Schema.Array(ToolUse),
})
const CheckoutTargetResult = Schema.Struct({
  kind: Schema.Literal("main", "worktree"),
  path: Schema.String,
  branch: Schema.NullOr(Schema.String),
})
const ProjectTargetResult = Schema.Struct({
  projectId: Schema.String,
  projectPath: Schema.String,
  projectName: Schema.String,
})
const CliProvider = Schema.Literal(
  "claude",
  "codex",
  "cursor",
  "opencode",
  "grok",
  "pi",
)
const NotificationProvider = Schema.Literal(
  "claude",
  "codex",
  "cursor",
  "opencode",
  "grok",
  "pi",
  "shell",
  "system",
)
const AppNotification = Schema.Struct({
  id: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  sessionId: Schema.NullOr(Schema.String),
  runId: Schema.optional(Schema.NullOr(Schema.String)),
  projectName: Schema.NullOr(Schema.String),
  sessionTitle: Schema.NullOr(Schema.String),
  provider: Schema.NullOr(NotificationProvider),
  type: Schema.Literal(
    "turn-completed",
    "input-required",
    "permission-required",
    "failed",
    "process-exited",
    "session-started",
    "provider-notification",
    "background-output",
    "system",
  ),
  severity: Schema.Literal("info", "success", "warning", "error"),
  status: Schema.Literal("unread", "read", "resolved", "dismissed"),
  title: Schema.String,
  message: Schema.NullOr(Schema.String),
  source: Schema.Literal(
    "interactive-runtime",
    "provider-hook",
    "provider-plugin",
    "osc",
    "process",
    "system",
    "aggregated-pty",
  ),
  eventId: Schema.NullOr(Schema.String),
  eventSequence: Schema.NullOr(Schema.Number),
  providerSessionId: Schema.NullOr(Schema.String),
  providerEvent: Schema.NullOr(Schema.String),
  providerTurnId: Schema.NullOr(Schema.String),
  requiresAction: Schema.Boolean,
  actionResolvedAt: Schema.NullOr(Schema.String),
  readAt: Schema.NullOr(Schema.String),
  dismissedAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  metadata: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  delivery: Schema.optional(Schema.Unknown),
})
const NotificationCounts = Schema.Struct({
  totalUnread: Schema.Number,
  actionRequired: Schema.Number,
  errors: Schema.Number,
})
const NotificationPreferences = Schema.Struct({
  desktopEnabled: Schema.Boolean,
  soundEnabled: Schema.Boolean,
  notifyOnCompleted: Schema.Boolean,
  notifyOnInputRequired: Schema.Boolean,
  notifyOnPermissionRequired: Schema.Boolean,
  notifyOnFailure: Schema.Boolean,
  includeBackgroundOutput: Schema.Boolean,
  backgroundOutputSettleMs: Schema.Number,
  retentionDays: Schema.Number,
  maxRetained: Schema.Number,
})
const NotificationList = Schema.Struct({
  items: Schema.Array(AppNotification),
  nextCursor: Schema.NullOr(Schema.String),
  counts: NotificationCounts,
})
const NotificationIngest = Schema.Struct({
  notification: Schema.NullOr(AppNotification),
  created: Schema.Boolean,
  updated: Schema.Boolean,
  deduped: Schema.Boolean,
  skipped: Schema.Boolean,
  skipReason: Schema.optional(Schema.String),
})
const AgentCapabilities = Schema.Struct({
  sessionLifecycle: Schema.Boolean,
  promptLifecycle: Schema.Boolean,
  turnLifecycle: Schema.Literal("native", "derived", "unsupported"),
  toolLifecycle: Schema.Boolean,
  permissions: Schema.Boolean,
  subagents: Schema.Boolean,
  compaction: Schema.Boolean,
  fileEvents: Schema.Literal("native", "derived", "unsupported"),
  nativeResume: Schema.optional(Schema.Boolean),
})
const ProviderAvailability = Schema.Struct({
  provider: CliProvider,
  available: Schema.Boolean,
  binary: Schema.String,
  version: Schema.NullOr(Schema.String),
  capabilities: AgentCapabilities,
  error: Schema.NullOr(Schema.String),
})
const AgentEvent = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  id: Schema.String,
  kind: Schema.Literal(
    "process.started",
    "process.exited",
    "session.started",
    "session.resumed",
    "session.ended",
    "session.failed",
    "prompt.submitted",
    "turn.started",
    "turn.completed",
    "turn.failed",
    "tool.started",
    "tool.completed",
    "tool.failed",
    "permission.requested",
    "permission.resolved",
    "subagent.started",
    "subagent.completed",
    "subagent.failed",
    "compaction.started",
    "compaction.completed",
    "file.touched",
    "notification.requested",
  ),
  provider: CliProvider,
  occurredAt: Schema.String,
  receivedAt: Schema.String,
  processId: Schema.String,
  nativeProcessId: Schema.optional(Schema.Number),
  sessionId: Schema.String,
  nativeSessionId: Schema.String,
  projectId: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  turn: Schema.optional(Schema.Struct({ id: Schema.String, nativeId: Schema.optional(Schema.String) })),
  tool: Schema.optional(Schema.Struct({
    id: Schema.String,
    nativeId: Schema.optional(Schema.String),
    name: Schema.String,
    category: Schema.String,
    status: Schema.Literal("running", "completed", "failed", "blocked"),
    startedAt: Schema.optional(Schema.String),
    completedAt: Schema.optional(Schema.String),
    durationMs: Schema.optional(Schema.Number),
  })),
  permission: Schema.optional(Schema.Struct({
    id: Schema.String,
    toolName: Schema.optional(Schema.String),
    category: Schema.optional(Schema.String),
    status: Schema.Literal("requested", "allowed", "denied", "cancelled"),
  })),
  subagent: Schema.optional(Schema.Struct({
    id: Schema.String,
    nativeId: Schema.optional(Schema.String),
    parentId: Schema.optional(Schema.String),
    type: Schema.optional(Schema.String),
    status: Schema.Literal("running", "completed", "failed"),
  })),
  file: Schema.optional(Schema.Struct({
    path: Schema.String,
    operation: Schema.optional(Schema.Literal("read", "create", "modify", "delete")),
  })),
  metadata: Schema.optional(Schema.Record({
    key: Schema.String,
    value: Schema.Union(Schema.String, Schema.Number, Schema.Boolean, Schema.Null),
  })),
  source: Schema.Struct({
    nativeEventName: Schema.String,
    providerVersion: Schema.optional(Schema.String),
  }),
})
const AgentSnapshot = Schema.Struct({
  id: Schema.String,
  nativeSessionId: Schema.String,
  provider: CliProvider,
  providerVersion: Schema.optional(Schema.String),
  projectId: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  status: Schema.Literal(
    "starting",
    "working",
    "running_tool",
    "waiting_for_permission",
    "waiting_for_user",
    "idle",
    "completed",
    "failed",
    "terminated",
    "disconnected",
  ),
  startedAt: Schema.String,
  lastActivityAt: Schema.String,
  endedAt: Schema.optional(Schema.String),
  process: Schema.Struct({
    id: Schema.String,
    pid: Schema.optional(Schema.Number),
    running: Schema.Boolean,
    exitCode: Schema.optional(Schema.Number),
    expectedExit: Schema.optional(Schema.Boolean),
  }),
  currentTurn: Schema.optional(Schema.Struct({
    id: Schema.String,
    startedAt: Schema.String,
    durationMs: Schema.Number,
  })),
  currentTool: Schema.optional(Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    category: Schema.String,
    startedAt: Schema.String,
    durationMs: Schema.Number,
  })),
  counts: Schema.Struct({
    turns: Schema.Number,
    completedTurns: Schema.Number,
    failedTurns: Schema.Number,
    tools: Schema.Number,
    runningTools: Schema.Number,
    failedTools: Schema.Number,
    touchedFiles: Schema.Number,
    compactions: Schema.Number,
    subagents: Schema.optional(Schema.Number),
    activeSubagents: Schema.optional(Schema.Number),
  }),
  runtime: Schema.Struct({ processRuntimeMs: Schema.Number, activeRuntimeMs: Schema.Number }),
  files: Schema.Array(Schema.Struct({
    path: Schema.String,
    lastOperation: Schema.optional(Schema.Literal("read", "create", "modify", "delete")),
    lastTouchedAt: Schema.String,
  })),
  unread: Schema.Struct({
    count: Schema.Number,
    latestEventAt: Schema.optional(Schema.String),
    latestEventKind: Schema.optional(Schema.String),
  }),
  attention: Schema.optional(Schema.Struct({
    kind: Schema.String,
    eventId: Schema.String,
    createdAt: Schema.String,
  })),
  capabilities: AgentCapabilities,
  _internal: Schema.optional(Schema.Unknown),
})
const AgentRun = Schema.Struct({
  runId: Schema.String,
  launchRequestId: Schema.String,
  generation: Schema.Number,
  provider: CliProvider,
  projectId: Schema.String,
  workspaceId: Schema.String,
  checkoutKey: Schema.String,
  checkoutPath: Schema.String,
  title: Schema.String,
  toolUseId: Schema.optional(Schema.NullOr(Schema.String)),
  ptyId: Schema.NullOr(Schema.String),
  nativeSessionId: Schema.NullOr(Schema.String),
  processState: Schema.Literal(
    "reserved",
    "starting",
    "running",
    "exited",
    "disconnected",
    "interrupted",
    "restoring",
    "orphaned",
  ),
  activityState: Schema.Literal(
    "starting",
    "working",
    "running_tool",
    "waiting_for_permission",
    "waiting_for_user",
    "idle",
    "failed",
  ),
  telemetryState: Schema.Literal("connecting", "connected", "degraded", "process_only"),
  createdAt: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  lastActivityAt: Schema.NullOr(Schema.String),
  endedAt: Schema.NullOr(Schema.String),
  exitCode: Schema.NullOr(Schema.Number),
  endReason: Schema.NullOr(Schema.String),
  telemetryError: Schema.NullOr(Schema.String),
  revision: Schema.Number,
  processIdentity: Schema.optional(Schema.NullOr(ProcessIdentity)),
})
const TerminalInstance = Schema.Struct({
  id: Schema.String,
  generation: Schema.Number,
  projectId: Schema.String,
  workspaceId: Schema.NullOr(Schema.String),
  checkoutKey: Schema.String,
  checkoutPath: Schema.String,
  title: Schema.String,
  provider: Schema.NullOr(CliProvider),
  launchRequestId: Schema.NullOr(Schema.String),
  ptyId: Schema.NullOr(Schema.String),
  nativeSessionId: Schema.NullOr(Schema.String),
  processState: Schema.Literal(
    "starting",
    "running",
    "exited",
    "failed",
    "disconnected",
    "interrupted",
    "restoring",
    "orphaned",
  ),
  activityState: Schema.Literal(
    "starting",
    "working",
    "running_tool",
    "waiting_for_permission",
    "waiting_for_user",
    "idle",
    "failed",
  ),
  telemetryState: Schema.Literal("connecting", "connected", "degraded", "process_only"),
  createdAt: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  lastActivityAt: Schema.NullOr(Schema.String),
  endedAt: Schema.NullOr(Schema.String),
  exitCode: Schema.NullOr(Schema.Number),
  endReason: Schema.NullOr(Schema.String),
  telemetryError: Schema.NullOr(Schema.String),
  revision: Schema.Number,
  processIdentity: Schema.optional(Schema.NullOr(ProcessIdentity)),
  terminalEpoch: Schema.optional(Schema.NullOr(Schema.String)),
  launchProfile: Schema.optional(Schema.Unknown),
  nativeSessionRef: Schema.optional(Schema.Unknown),
  restartPolicy: Schema.optional(Schema.Literal("never", "manual", "resume-on-daemon-start")),
})
const TaskResult = Schema.Struct({ exitCode: Schema.Number, output: Schema.String })
const LaunchConfig = Schema.Struct({
  workspacePath: Schema.String,
  filePath: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Literal("default", "explicit", "external")),
})

export type HostToolSessionSnapshot = {
  session: AppSession
  tabs: SessionTab[]
  toolUses: ToolUse[]
}

export type HostTerminalInstanceInfo = {
  id: string
  generation: number
  projectId: string
  workspaceId: string | null
  checkoutKey: string
  checkoutPath: string
  title: string
  provider: TelemetryAgentProvider | null
  launchRequestId: string | null
  ptyId: string | null
  nativeSessionId: string | null
  processIdentity?: {
    pid: number
    platform: "linux" | "darwin" | "windows"
    bootId?: string
    startToken: string
    executablePath?: string
  } | null
  terminalEpoch?: string | null
  launchProfile?: unknown
  nativeSessionRef?: unknown
  restartPolicy?: "never" | "manual" | "resume-on-daemon-start"
  processState:
    | "starting"
    | "running"
    | "exited"
    | "failed"
    | "disconnected"
    | "interrupted"
    | "restoring"
    | "orphaned"
  activityState:
    | "starting"
    | "working"
    | "running_tool"
    | "waiting_for_permission"
    | "waiting_for_user"
    | "idle"
    | "failed"
  telemetryState: "connecting" | "connected" | "degraded" | "process_only"
  createdAt: string
  startedAt: string | null
  lastActivityAt: string | null
  endedAt: string | null
  exitCode: number | null
  endReason: string | null
  telemetryError: string | null
  revision: number
}

export type HostAgentRunInfo = {
  runId: string
  launchRequestId: string
  generation: number
  provider: TelemetryAgentProvider
  projectId: string
  workspaceId: string
  checkoutKey: string
  checkoutPath: string
  title: string
  toolUseId?: string | null
  ptyId: string | null
  nativeSessionId: string | null
  processIdentity?: {
    pid: number
    platform: "linux" | "darwin" | "windows"
    bootId?: string
    startToken: string
    executablePath?: string
  } | null
  processState:
    | "reserved"
    | "starting"
    | "running"
    | "exited"
    | "disconnected"
    | "interrupted"
    | "restoring"
    | "orphaned"
  activityState:
    | "starting"
    | "working"
    | "running_tool"
    | "waiting_for_permission"
    | "waiting_for_user"
    | "idle"
    | "failed"
  telemetryState: "connecting" | "connected" | "degraded" | "process_only"
  createdAt: string
  startedAt: string | null
  lastActivityAt: string | null
  endedAt: string | null
  exitCode: number | null
  endReason: string | null
  telemetryError: string | null
  revision: number
}

export type HostProviderAvailability = {
  provider: TelemetryAgentProvider
  available: boolean
  binary: string
  version: string | null
  capabilities: AgentDriverCapabilities
  error: string | null
}

export type HostTerminalAttachResult = {
  id: string
  title?: string
  outputChunks?: string[]
  output: string
  replayTruncated?: boolean
  replayNeedsQueryResponses?: boolean
  lastSequence: number
  cols?: number
  rows?: number
  status: "running" | "exited"
  exitCode?: number
  signal?: number
}

type HostRouteResultOverrides = {
  "fs:readDir": Array<{ uri: string; name: string; isDirectory: boolean }>
  "fs:stat": { uri: string; isDirectory: boolean; size: number }
  "fs:createFile": { uri: string; isDirectory: boolean; size: number }
  "fs:mkdir": { uri: string; isDirectory: boolean; size: number }
  "fs:rename": { uri: string; isDirectory: boolean; size: number }
  "fs:trash": TrashEntry
  "fs:restoreTrash": RestoreTrashResult
  "fs:listTrash": TrashEntry[]
  "fs:emptyTrash": EmptyTrashResult
  "fs:writeTempDrop": string
  "fs:showOpenFolderDialog": string | null
  "fs:showSaveFileDialog": string | null
  "tasks:spawn": { exitCode: number; output: string }
  "git:status": SharedGitStatusEntry[]
  "git:diff": string
  "git:show": string
  "git:commitFileContents": { original: string; modified: string }
  "git:summary": GitRepositorySummary
  "git:branches": string[]
  "git:branch": string | null
  "git:defaultBranch": string | null
  "git:history": GitCommit[]
  "git:historyPage": SharedGitHistoryPage
  "git:numstat": GitNumstatEntry[]
  "git:commitFiles": GitCommitDetail
  "git:worktreeList": GitWorktree[]
  "git:worktreeAdd": GitWorktree
  "tools:listSessions": HostToolSessionSnapshot[]
  "tools:reorderSessions": AppSession[]
  "tools:createTab": SessionTab
  "tools:renameTab": SessionTab
  "tools:saveTabLayout": SessionTab
  "tools:reorderTabs": SessionTab[]
  "tools:archiveTab": SessionTab
  "tools:selectTab": AppSession
  "tools:archiveSession": AppSession
  "tools:restoreSession": AppSession
  "tools:getSession": HostToolSessionSnapshot | null
  "tools:createUse": ToolUse
  "tools:updateUseContext": ToolUse
  "tools:reorderUses": ToolUse[]
  "tools:selectUse": AppSession
  "tools:getUse": ToolUse | null
  "tools:cancelUse": ToolUse
  "tools:restartUse": ToolUse
  "tools:archiveUse": ToolUse
  "tools:renameUse": ToolUse
  "tools:listProjects": Array<{ projectId: string; projectPath: string; projectName: string }>
  "tools:addProject": { projectId: string; projectPath: string; projectName: string }
  "tools:listCheckoutTargets": Array<{ kind: "main" | "worktree"; path: string; branch: string | null }>
  "notifications:list": ListNotificationsResponse
  "notifications:counts": SharedNotificationCounts
  "notifications:ingest": {
    notification: SharedAppNotification | null
    created: boolean
    updated: boolean
    deduped: boolean
    skipped: boolean
    skipReason?: string
  }
  "notifications:get": SharedAppNotification | null
  "notifications:markRead": SharedAppNotification | null
  "notifications:markUnread": SharedAppNotification | null
  "notifications:dismiss": SharedAppNotification | null
  "notifications:restore": SharedAppNotification | null
  "notifications:acknowledge": SharedAppNotification | null
  "notifications:markAllRead": SharedNotificationCounts
  "notifications:unreadBySession": Record<string, number>
  "notifications:markSessionUnread": SharedAppNotification | null
  "notifications:getPreferences": SharedNotificationPreferences
  "notifications:setPreferences": SharedNotificationPreferences
  "notifications:bindSession": { ok: boolean }
  "agents:listProviders": HostProviderAvailability[]
  "agents:launch": { run: HostAgentRunInfo; pty: { id: string; title: string | null } | null }
  "agents:stop": HostAgentRunInfo | null
  "agents:close": HostAgentRunInfo | null
  "agents:listLive": HostAgentRunInfo[]
  "agents:listProject": HostAgentRunInfo[]
  "agents:get": HostAgentRunInfo | null
  "agents:getTranscript": { output: string; truncated: boolean } | null
  "agents:listActivity": { runs: HostAgentRunInfo[]; nextCursor: string | null }
  "agents:getSnapshot": AgentSessionSnapshot | null
  "agents:listEvents": AgentEvent[]
  "agents:ingestNative": { eventCount: number; snapshot: AgentSessionSnapshot | null; nativeSessionId: string | null }
  "agents:installProjectHooks": { written: string[] }
  "terminal:create": { id: string; title?: string }
  "terminal:write": void
  "terminal:writeBinary": void
  "terminal:resize": void
  "terminal:ack": void
  "terminal:ready": void
  "terminal:dispose": void
  "terminal:attach": HostTerminalAttachResult | null
  "terminal:getCwd": string | null
  "terminal:getForegroundProcess": string | null
  "terminal:listInstances": HostTerminalInstanceInfo[]
  "terminal:createInstance": HostTerminalInstanceInfo
  "terminal:restartInstance": HostTerminalInstanceInfo | null
  "terminal:closeInstance": HostTerminalInstanceInfo | null
  "terminal:getInstanceTranscript": { output: string; truncated: boolean } | null
  "yaade:getLaunchConfig": { workspacePath: string; filePath?: string; source?: "default" | "explicit" | "external" } | null
  "yaade:getHomeDir": string
  "yaade:loadGlobalYaadercScanRoots": string[]
  "perf:recordStartup": string
  "perf:getStartupLogPath": string
  "shell:openInApp": { ok: boolean }
  "shell:revealInFolder": { ok: boolean }
}

/**
 * Canonical RPC route registry.
 *
 * The object is contract-only: browser transports, HTTP dispatch, and the
 * realtime terminal adapter all consume the same route definitions.
 * A route's decoded argument tuple and result type are therefore part of one
 * interface instead of being reconstructed at every adapter.
 */
export const HOST_ROUTES = {
  "fs:readFile": route(StringArgs, Schema.String, { pathPolicy: { kind: "read-only-path" } }),
  "fs:writeFile": route(StringStringArgs, Schema.Null, { pathPolicy: { kind: "allowed-root", indices: [0] } }),
  "fs:readTextFile": route(StringArgs, TextFileReadResult, { pathPolicy: { kind: "read-only-path" } }),
  "fs:writeTextFile": route(
    Schema.Tuple(Schema.String, Schema.String, TextFileWriteOptions),
    TextFileWriteResult,
    { pathPolicy: { kind: "allowed-root", indices: [0] } },
  ),
  "fs:writeTempDrop": route(StringStringArgs, Schema.String),
  "fs:readDir": route(StringArgs, Schema.Array(WorkspaceEntry), { pathPolicy: { kind: "allowed-root", indices: [0] } }),
  "fs:stat": route(StringArgs, WorkspaceStat, { pathPolicy: { kind: "read-only-path" } }),
  "fs:exists": route(StringArgs, Schema.Boolean, { pathPolicy: { kind: "read-only-path" } }),
  "fs:createFile": route(StringArgs, FsMutationStat, { pathPolicy: { kind: "allowed-root", indices: [0] } }),
  "fs:mkdir": route(StringArgs, FsMutationStat, { pathPolicy: { kind: "allowed-root", indices: [0] } }),
  "fs:rename": route(StringStringArgs, FsMutationStat, { pathPolicy: { kind: "allowed-root", indices: [0, 1] } }),
  "fs:trash": route(StringArgs, TrashEntry, { pathPolicy: { kind: "allowed-root", indices: [0] } }),  "fs:restoreTrash": route(
    Schema.Union(Schema.Tuple(Schema.String), Schema.Tuple(Schema.String, Schema.String)),
    RestoreTrashResult,
    { pathPolicy: { kind: "trash-restore" } },
  ),
  "fs:listTrash": route(EmptyArgs, Schema.Array(TrashEntry)),
  "fs:emptyTrash": route(EmptyArgs, EmptyTrashResult),
  "fs:showOpenFolderDialog": route(EmptyArgs, Schema.NullOr(Schema.String)),
  "fs:showSaveFileDialog": route(OptionalStringArgs, Schema.NullOr(Schema.String)),

  "git:isRepo": route(StringArgs, Schema.Boolean, { pathPolicy: { kind: "allowed-root", indices: [0] } }),
  "git:status": route(StringArgs, Schema.Array(GitStatusEntry), { pathPolicy: { kind: "allowed-root", indices: [0] } }),
  "git:diff": route(Schema.Tuple(Schema.String, Schema.optionalElement(GitDiffOptions)), Schema.String, { pathPolicy: { kind: "allowed-root", indices: [0] } }),
  "git:show": route(Schema.Tuple(Schema.String, GitShowOptions), Schema.String, { pathPolicy: { kind: "allowed-root", indices: [0] } }),
  "git:commitFileContents": route(Schema.Tuple(Schema.String, Schema.String, GitFile), Schema.Struct({ original: Schema.String, modified: Schema.String }), { pathPolicy: { kind: "allowed-root", indices: [0] } }),
  "git:branch": route(StringArgs, Schema.NullOr(Schema.String), { pathPolicy: { kind: "allowed-root", indices: [0] } }),
  "git:summary": route(StringArgs, GitSummary, { pathPolicy: { kind: "allowed-root", indices: [0] } }),
  "git:branches": route(StringArgs, Schema.Array(Schema.String), { pathPolicy: { kind: "allowed-root", indices: [0] } }),
  "git:stage": route(Schema.Tuple(Schema.String, Schema.Array(Schema.String)), Schema.Null, { pathPolicy: { kind: "allowed-root", indices: [0] } }),
  "git:unstage": route(Schema.Tuple(Schema.String, Schema.Array(Schema.String)), Schema.Null, { pathPolicy: { kind: "allowed-root", indices: [0] } }),
  "git:discard": route(Schema.Tuple(Schema.String, Schema.Array(Schema.String)), Schema.Null, { pathPolicy: { kind: "allowed-root", indices: [0] } }),
  "git:commit": route(Schema.Tuple(Schema.String, Schema.String, Schema.optionalElement(Schema.String)), Schema.Null, { pathPolicy: { kind: "allowed-root", indices: [0] } }),
  "git:checkout": route(StringStringArgs, Schema.Null, { pathPolicy: { kind: "allowed-root", indices: [0] } }),
  "git:fetch": route(StringArgs, Schema.Null, { pathPolicy: { kind: "allowed-root", indices: [0] } }),
  "git:pull": route(StringArgs, Schema.Null, { pathPolicy: { kind: "allowed-root", indices: [0] } }),
  "git:push": route(StringArgs, Schema.Null, { pathPolicy: { kind: "allowed-root", indices: [0] } }),
  "git:history": route(Schema.Tuple(Schema.String, Schema.optionalElement(Schema.Number)), Schema.Array(GitCommit), { pathPolicy: { kind: "allowed-root", indices: [0] } }),
  // A nullable cursor lets callers request a sized first page without putting
  // an undefined hole in the positional tuple. Undefined array elements are
  // serialized as null before the request reaches the host.
  "git:historyPage": route(Schema.Tuple(Schema.String, Schema.optionalElement(Schema.NullOr(Schema.String)), Schema.optionalElement(Schema.Number)), GitHistoryPage, { pathPolicy: { kind: "allowed-root", indices: [0] } }),
  "git:numstat": route(StringArgs, Schema.Array(GitNumstat), { pathPolicy: { kind: "allowed-root", indices: [0] } }),
  "git:commitFiles": route(StringStringArgs, GitCommitDetail, { pathPolicy: { kind: "allowed-root", indices: [0] } }),
  "git:applyPatch": route(Schema.Tuple(Schema.String, Schema.String, Schema.optionalElement(GitPatchOptions)), Schema.Null, { pathPolicy: { kind: "allowed-root", indices: [0] } }),
  "git:worktreeList": route(StringArgs, Schema.Array(GitWorktree), { pathPolicy: { kind: "allowed-root", indices: [0] } }),
  "git:worktreeAdd": route(Schema.Tuple(Schema.String, Schema.String, GitWorktreeAddOptions), GitWorktree, { pathPolicy: { kind: "allowed-root", indices: [0] } }),
  "git:worktreeRemove": route(Schema.Tuple(Schema.String, Schema.String, Schema.optionalElement(GitWorktreeRemoveOptions)), Schema.Null, { pathPolicy: { kind: "allowed-root", indices: [0] } }),
  "git:defaultBranch": route(StringArgs, Schema.NullOr(Schema.String), { pathPolicy: { kind: "allowed-root", indices: [0] } }),

  "shell:openInApp": route(StringStringArgs, Schema.Struct({ ok: Schema.Boolean })),
  "shell:revealInFolder": route(StringArgs, Schema.Struct({ ok: Schema.Boolean })),
  "tasks:spawn": route(UnknownArgs, TaskResult),
  "perf:recordStartup": route(UnknownArgs, Schema.String),
  "perf:getStartupLogPath": route(EmptyArgs, Schema.String),
  "yaade:getLaunchConfig": route(EmptyArgs, Schema.NullOr(LaunchConfig)),
  "yaade:getHomeDir": route(EmptyArgs, Schema.String),
  "yaade:loadGlobalYaadercScanRoots": route(EmptyArgs, Schema.Array(Schema.String)),

  "tools:listSessions": route(Schema.Tuple(Schema.Boolean), Schema.Array(SessionSnapshot)),
  "tools:createSession": route(OptionalStringArgs, AppSession),
  "tools:renameSession": route(StringStringArgs, AppSession),
  "tools:reorderSessions": route(Schema.Tuple(ReorderSessions), Schema.Array(AppSession)),
  "tools:createTab": route(Schema.Tuple(CreateSessionTab), SessionTab),
  "tools:renameTab": route(Schema.Tuple(RenameSessionTab), SessionTab),
  "tools:saveTabLayout": route(Schema.Tuple(SaveSessionTabLayout), SessionTab),
  "tools:reorderTabs": route(Schema.Tuple(ReorderSessionTabs), Schema.Array(SessionTab)),
  "tools:archiveTab": route(Schema.Tuple(ArchiveSessionTab), SessionTab),
  "tools:selectTab": route(Schema.Tuple(SelectSessionTab), AppSession),
  "tools:archiveSession": route(Schema.Tuple(ArchiveSession), AppSession),
  "tools:restoreSession": route(Schema.Tuple(RestoreSession), AppSession),
  "tools:getSession": route(StringArgs, Schema.NullOr(SessionSnapshot)),
  "tools:createUse": route(Schema.Tuple(CreateToolUse), ToolUse),
  "tools:updateUseContext": route(Schema.Tuple(UpdateToolUseContext), ToolUse),
  "tools:reorderUses": route(Schema.Tuple(ReorderToolUses), Schema.Array(ToolUse)),
  "tools:selectUse": route(Schema.Tuple(Schema.String, Schema.optionalElement(ToolUseId)), AppSession),
  "tools:getUse": route(Schema.Tuple(ToolUseId), Schema.NullOr(ToolUse)),
  "tools:cancelUse": route(Schema.Tuple(ToolUseId, Schema.Number), ToolUse),
  "tools:restartUse": route(Schema.Tuple(ToolUseId, Schema.Number), ToolUse),
  "tools:archiveUse": route(Schema.Tuple(ArchiveToolUse), ToolUse),
  "tools:renameUse": route(StringStringArgs, ToolUse),
  "tools:listProjects": route(EmptyArgs, Schema.Array(ProjectTargetResult)),
  "tools:addProject": route(StringArgs, ProjectTargetResult, { pathPolicy: { kind: "allowed-root", indices: [0] } }),
  "tools:listCheckoutTargets": route(Schema.Tuple(ListCheckoutTargets), Schema.Array(CheckoutTargetResult)),

  "notifications:list": route(UnknownOptionalArgs, NotificationList),
  "notifications:counts": route(EmptyArgs, NotificationCounts),
  "notifications:get": route(StringArgs, Schema.NullOr(AppNotification)),
  "notifications:ingest": route(UnknownArgs, NotificationIngest),
  "notifications:markRead": route(StringArgs, Schema.NullOr(AppNotification)),
  "notifications:markUnread": route(StringArgs, Schema.NullOr(AppNotification)),
  "notifications:dismiss": route(StringArgs, Schema.NullOr(AppNotification)),
  "notifications:restore": route(StringArgs, Schema.NullOr(AppNotification)),
  "notifications:acknowledge": route(StringArgs, Schema.NullOr(AppNotification)),
  "notifications:markAllRead": route(UnknownOptionalArgs, NotificationCounts),
  "notifications:unreadBySession": route(EmptyArgs, Schema.Record({ key: Schema.String, value: Schema.Number })),
  "notifications:markSessionUnread": route(StringArgs, Schema.NullOr(AppNotification)),
  "notifications:getPreferences": route(EmptyArgs, NotificationPreferences),
  "notifications:setPreferences": route(UnknownArgs, NotificationPreferences),
  "notifications:bindSession": route(UnknownArgs, Schema.Struct({ ok: Schema.Boolean })),
  "notifications:runRetention": route(EmptyArgs, UnknownResult),

  "agents:listProviders": route(Schema.Tuple(Schema.Boolean), Schema.Array(ProviderAvailability)),
  "agents:launch": route(UnknownArgs, Schema.Struct({ run: AgentRun, pty: Schema.NullOr(Schema.Struct({ id: Schema.String, title: Schema.NullOr(Schema.String) })) })),
  "agents:stop": route(UnknownArgs, Schema.NullOr(AgentRun)),
  "agents:close": route(UnknownArgs, Schema.NullOr(AgentRun)),
  "agents:listLive": route(Schema.Tuple(Schema.optionalElement(Schema.String)), Schema.Array(AgentRun)),
  "agents:listProject": route(StringArgs, Schema.Array(AgentRun)),
  "agents:get": route(StringArgs, Schema.NullOr(AgentRun)),
  "agents:getTranscript": route(StringArgs, Schema.NullOr(Schema.Struct({ output: Schema.String, truncated: Schema.Boolean }))),
  "agents:listActivity": route(UnknownOptionalArgs, Schema.Struct({ runs: Schema.Array(AgentRun), nextCursor: Schema.NullOr(Schema.String) })),
  "agents:getSnapshot": route(StringArgs, Schema.NullOr(AgentSnapshot)),
  "agents:listEvents": route(Schema.Tuple(Schema.String, Schema.optionalElement(Schema.Unknown)), Schema.Array(AgentEvent)),
  "agents:ingestNative": route(UnknownArgs, Schema.Struct({ eventCount: Schema.Number, snapshot: Schema.NullOr(AgentSnapshot), nativeSessionId: Schema.NullOr(Schema.String) })),
  "agents:installProjectHooks": route(UnknownArgs, Schema.Struct({ written: Schema.Array(Schema.String) })),

  "terminal:create": route(TerminalCreateArgs, TerminalCreateResult, { pathPolicy: { kind: "allowed-root", indices: [0] } }),
  "terminal:write": route(TerminalWriteArgs, Schema.Unknown, { pathPolicy: { kind: "terminal-id-or-path" }, realtime: true }),
  "terminal:writeBinary": route(TerminalWriteArgs, Schema.Unknown, { pathPolicy: { kind: "terminal-id-or-path" }, realtime: true }),
  "terminal:resize": route(TerminalResizeArgs, Schema.Unknown, { pathPolicy: { kind: "terminal-id-or-path" }, realtime: true }),
  "terminal:ack": route(TerminalAckArgs, Schema.Unknown, { pathPolicy: { kind: "terminal-id-or-path" }, realtime: true }),
  "terminal:acquireLease": route(
    Schema.Tuple(Schema.String, Schema.optionalElement(Schema.Literal("writer", "observer"))),
    Schema.NullOr(TerminalLease),
    { pathPolicy: { kind: "terminal-id-or-path" } },
  ),
  "terminal:renewLease": route(
    Schema.Tuple(Schema.String, Schema.String),
    Schema.NullOr(TerminalLease),
    { pathPolicy: { kind: "terminal-id-or-path" } },
  ),
  "terminal:releaseLease": route(
    Schema.Tuple(Schema.String, Schema.String),
    Schema.Null,
    { pathPolicy: { kind: "terminal-id-or-path" } },
  ),
  "terminal:requestControl": route(
    StringArgs,
    Schema.NullOr(TerminalLease),
    { pathPolicy: { kind: "terminal-id-or-path" } },
  ),
  "terminal:transferControl": route(
    Schema.Tuple(Schema.String, Schema.String, Schema.String),
    Schema.NullOr(TerminalLease),
    { pathPolicy: { kind: "terminal-id-or-path" } },
  ),
  "terminal:listViewers": route(
    StringArgs,
    Schema.Array(Schema.String),
    { pathPolicy: { kind: "terminal-id-or-path" } },
  ),
  "terminal:ready": route(StringArgs, Schema.Unknown, { pathPolicy: { kind: "terminal-id-or-path" }, realtime: true }),
  "terminal:attach": route(TerminalAttachArgs, TerminalAttachResult, { pathPolicy: { kind: "terminal-id-or-path" }, realtime: true }),
  "terminal:getCwd": route(StringArgs, Schema.NullOr(Schema.String), { pathPolicy: { kind: "terminal-id-or-path" } }),
  "terminal:getForegroundProcess": route(StringArgs, Schema.NullOr(Schema.String), { pathPolicy: { kind: "terminal-id-or-path" } }),
  "terminal:dispose": route(StringArgs, Schema.Null, { pathPolicy: { kind: "terminal-id-or-path" } }),
  "terminal:listInstances": route(StringArgs, Schema.Array(TerminalInstance)),
  "terminal:createInstance": route(TerminalInstanceRequestArgs, TerminalInstance),
  "terminal:restartInstance": route(TerminalInstanceRequestArgs, Schema.NullOr(TerminalInstance)),
  "terminal:resumeInstance": route(TerminalInstanceRequestArgs, Schema.NullOr(TerminalInstance)),
  "terminal:closeInstance": route(TerminalInstanceRequestArgs, Schema.NullOr(TerminalInstance)),
  "terminal:getInstanceTranscript": route(StringArgs, Schema.NullOr(Schema.Struct({ output: Schema.String, truncated: Schema.Boolean }))),
} as const satisfies Record<string, AnyHostRouteDefinition>

export type HostRouteName = keyof typeof HOST_ROUTES
export type HostRouteArgs<Name extends HostRouteName> = Schema.Schema.Type<
  (typeof HOST_ROUTES)[Name]["args"]
>
type MutableResult<Value> = Value extends
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  ? Value
  : Value extends readonly [infer First, infer Second]
    ? [MutableResult<First>, MutableResult<Second>]
    : Value extends readonly (infer Item)[]
      ? MutableResult<Item>[]
      : Value extends object
        ? { -readonly [Key in keyof Value]: MutableResult<Value[Key]> }
        : Value

type RouteResultValue<Name extends HostRouteName> = Name extends keyof HostRouteResultOverrides
  ? HostRouteResultOverrides[Name]
  : Schema.Schema.Type<(typeof HOST_ROUTES)[Name]["result"]>

export type HostRouteResult<Name extends HostRouteName> = [
  RouteResultValue<Name>,
] extends [null]
  ? void
  : MutableResult<RouteResultValue<Name>>
export type HostRoute = (typeof HOST_ROUTES)[HostRouteName]

const HOST_ROUTE_ENTRIES = Object.entries(HOST_ROUTES)

/** Runtime lookup used by adapters after the channel crosses the wire. */
export function getHostRoute(channel: string): HostRoute | undefined {
  return HOST_ROUTE_ENTRIES.find(([name]) => name === channel)?.[1]
}

/** Decode positional arguments exactly once at the RPC seam. */
export function decodeHostRouteArgs(channel: string, args: unknown[]): unknown[] {
  const route = getHostRoute(channel)
  if (!route) throw new Error(`unknown host channel: ${channel}`)
  return route.decodeArgs(args)
}

/** Validate a handler result before it is put on HTTP or WS. */
export function decodeHostRouteResult<Name extends HostRouteName>(
  name: Name,
  value: unknown,
): HostRouteResult<Name>
export function decodeHostRouteResult(
  name: HostRouteName,
  value: unknown,
): unknown {
  const route = getHostRoute(name)
  if (!route) throw new Error(`unknown host channel: ${name}`)
  return route.decodeResult(value)
}

export const HOST_ROUTE_CHANNELS = HOST_ROUTE_ENTRIES
  .map(([name]) => name)
  .filter(isHostRouteName)
export const HOST_HOT_ROUTES = HOST_ROUTE_ENTRIES
  .filter(([, route]) => route.realtime)
  .map(([channel]) => channel)
  .filter(isHostRouteName)

export function isHostRouteName(value: string): value is HostRouteName {
  return getHostRoute(value) !== undefined
}
