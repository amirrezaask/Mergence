import type {
  GitCommit,
  GitCommitDetail,
  GitHistoryPage,
  GitNumstatEntry,
  GitRepositorySummary,
  GitStatusEntry,
  GitWorktree,
  PanelId,
  PanelView,
  FileSearchOptions,
  ProjectSearchOptions,
  ProjectSearchResult,
  SearchPage,
} from "@yaade/shared"
import type {
  EmptyTrashResult,
  LanguageServerDefinition,
  LspLifecycleEvent,
  LspLogEntry,
  LspLogRequest,
  LspResolveRequest,
  LspStartResult,
  ResolvedLanguageServerTarget,
  RestoreTrashResult,
  TextFileReadResult,
  TextFileWriteOptions,
  TextFileWriteResult,
  TrashEntry,
  AgentRuntimeEvent,
  AgentRuntimeThreadRecovery,
  AgentRuntimeThreadSnapshot,
  AgentRuntimeCreateRequest,
  AgentRuntimeCommandEnvelope,
  AgentRuntimeCommandResult,
  AgentRuntimeDriverDiscovery,
  AgentRuntimeAttachmentUpload,
  AgentRuntimeAttachmentDescriptor,
  AgentRuntimeConnectionState,
  AgentRuntimeConnectionUpdate,
  AgentRuntimeProviderDescriptor,
  AgentRuntimeRegistrySnapshot,
} from "@yaade/rpc"

export type {
  EmptyTrashResult,
  LanguageServerDefinition,
  LspLifecycleEvent,
  LspLogEntry,
  LspLogRequest,
  LspResolveRequest,
  LspStartResult,
  ResolvedLanguageServerTarget,
  RestoreTrashResult,
  TextFileReadResult,
  TextFileWriteOptions,
  TextFileWriteResult,
  TrashEntry,
  AgentRuntimeEvent,
  AgentRuntimeThreadRecovery,
  AgentRuntimeThreadSnapshot,
  AgentRuntimeCreateRequest,
  AgentRuntimeCommandEnvelope,
  AgentRuntimeCommandResult,
  AgentRuntimeDriverDiscovery,
  AgentRuntimeAttachmentUpload,
  AgentRuntimeAttachmentDescriptor,
  AgentRuntimeConnectionState,
  AgentRuntimeConnectionUpdate,
  AgentRuntimeProviderDescriptor,
  AgentRuntimeRegistrySnapshot,
} from "@yaade/rpc"

export type WorkspaceFile = {
  uri: string
  path: string
  name: string
  languageId: string
  isDirty: boolean
}

export type WorkspaceEntry = {
  uri: string
  name: string
  isDirectory: boolean
}

export type WorkspaceStat = {
  uri: string
  isDirectory: boolean
  size: number
}

export type WorkspaceFileChangeKind = "created" | "changed" | "deleted"

export type WorkspaceRoot = {
  uri: string
  name: string
  path: string
}

export interface FileSystemProvider {
  readFile(uri: string): Promise<string>
  writeFile(uri: string, content: string): Promise<void>
  readTextFile?(uri: string): Promise<TextFileReadResult>
  writeTextFile?(
    uri: string,
    content: string,
    options: TextFileWriteOptions,
  ): Promise<TextFileWriteResult>
  readDir(uri: string): Promise<WorkspaceEntry[]>
  stat(uri: string): Promise<WorkspaceStat>
  /** Expected-miss probe. Unlike `stat`, a missing path resolves to false. */
  exists?(uri: string): Promise<boolean>
}

export type JetElectronFS = FileSystemProvider & {
  readTextFile(uri: string): Promise<TextFileReadResult>
  writeTextFile(
    uri: string,
    content: string,
    options: TextFileWriteOptions,
  ): Promise<TextFileWriteResult>
  showOpenFolderDialog(): Promise<string | null>
  showSaveFileDialog(defaultPath?: string): Promise<string | null>
  /** Persist a browser File blob under OS temp; returns absolute path for PTY paste. */
  writeTempDrop?(name: string, contentBase64: string): Promise<string>
  createFile(uri: string): Promise<WorkspaceStat>
  mkdir(uri: string): Promise<WorkspaceStat>
  rename(sourceUri: string, targetUri: string): Promise<WorkspaceStat>
  trash(uri: string): Promise<TrashEntry>
  restoreTrash(id: string, targetUri?: string): Promise<RestoreTrashResult>
  listTrash(): Promise<TrashEntry[]>
  emptyTrash(): Promise<EmptyTrashResult>
  watchWorkspace?(rootUri: string): Promise<void>
  onFileChanged?(
    callback: (uri: string, kind: WorkspaceFileChangeKind) => void,
  ): () => void
}

export type JetElectronSearch = {
  project(
    rootUri: string,
    query: string,
    opts?: ProjectSearchOptions,
    signal?: AbortSignal,
  ): Promise<SearchPage<ProjectSearchResult>>
  listFiles(rootUri: string, signal?: AbortSignal): Promise<SearchPage<string>>
  fileSearch(
    rootUri: string,
    query: string,
    opts?: FileSearchOptions,
    signal?: AbortSignal,
  ): Promise<SearchPage<string>>
  trackFileAccess?(rootUri: string, query: string, path: string): Promise<void>
  isScanReady?(rootUri: string): Promise<boolean>
  isSupported?(rootUri: string): Promise<boolean>
}

export type JetTaskSpawnRequest = {
  id: string
  command: string
  args: string[]
  cwd: string
}

export type JetElectronTasks = {
  spawn(req: JetTaskSpawnRequest): Promise<{ exitCode: number; output: string }>
}

export type JetElectronLSP = {
  resolve(request: LspResolveRequest): Promise<ResolvedLanguageServerTarget | null>
  start(target: ResolvedLanguageServerTarget): Promise<LspStartResult>
  stop(id: string): Promise<void>
  listDefinitions(): Promise<LanguageServerDefinition[]>
  logs(request?: LspLogRequest): Promise<LspLogEntry[]>
  onLifecycle(cb: (event: LspLifecycleEvent) => void): () => void
  /** Compatibility signal for consumers that only need the failed session id. */
  onCrashed(cb: (id: string) => void): () => void
}

export type JetElectronTerminal = {
  create(
    cwdUri: string,
    launch?: {
      command?: string
      args?: string[]
      env?: Record<string, string>
      cols?: number
      rows?: number
    },
  ): Promise<{ id: string; title?: string }>
  attach(id: string): Promise<{
    id: string
    title?: string
    /** Ring segments for attach replay (preferred). */
    outputChunks?: string[]
    /** Legacy joined form; may be empty when outputChunks is set. */
    output: string
    lastSequence: number
    status: "running" | "exited"
    exitCode?: number
    signal?: number
  } | null>
  write(id: string, data: string): Promise<void>
  writeBinary(id: string, dataBase64: string): Promise<void>
  resize(id: string, cols: number, rows: number): Promise<void>
  /**
   * Acknowledge that `charCount` chars from `terminal:data` have been parsed
   * by xterm. Host uses this for PTY pause/resume flow control.
   */
  acknowledgeData(id: string, charCount: number): Promise<void>
  /**
   * Live working directory of the PTY process as a `file://` URI.
   * Prefers OS introspection of the foreground process, then OSC 7, then spawn cwd.
   */
  getCwd(id: string): Promise<string | null>
  /** Basename of the foreground process under this PTY (e.g. `nvim`, `fish`). */
  getForegroundProcess(id: string): Promise<string | null>
  onData(id: string, callback: (data: string) => void): () => void
  onExit(cb: (id: string, exitCode: number, signal?: number) => void): () => void
  dispose(id: string): Promise<void>
}

export type LaunchConfig = {
  workspacePath: string
  filePath?: string
  source?: "default" | "explicit" | "external"
}

/**
 * Identifies one mux session's workspace lease within the current host client.
 * The host combines this with the transport client id so separate browser tabs
 * can retain the same root independently.
 */
export type WorkspaceLeaseIdentity = {
  sessionId: string
}

export type JetElectronWorkspace = {
  activate(rootUri: string, owner: WorkspaceLeaseIdentity): Promise<{ ok: boolean }>
  deactivate?(
    rootUri: string,
    owner: WorkspaceLeaseIdentity,
  ): Promise<{ ok: boolean }>
  onFileIndex(callback: (rootUri: string, files: string[]) => void): () => void
  onSearchReady?(callback: (rootUri: string) => void): () => void
}

export type JetElectronGit = {
  isRepo(rootUri: string): Promise<boolean>
  status(rootUri: string): Promise<GitStatusEntry[]>
  diff(rootUri: string, opts?: { path?: string; staged?: boolean }): Promise<string>
  show(rootUri: string, path: string, ref: "HEAD" | "INDEX" | string): Promise<string>
  commitFileContents(
    rootUri: string,
    hash: string,
    file: { path: string; status: string; originalPath?: string },
  ): Promise<{ original: string; modified: string }>
  branch(rootUri: string): Promise<string | null>
  summary(rootUri: string): Promise<GitRepositorySummary>
  branches(rootUri: string): Promise<string[]>
  stage(rootUri: string, paths: string[]): Promise<void>
  unstage(rootUri: string, paths: string[]): Promise<void>
  discard(rootUri: string, paths: string[]): Promise<void>
  commit(rootUri: string, summary: string, body?: string): Promise<void>
  checkout(rootUri: string, branch: string): Promise<void>
  fetch(rootUri: string): Promise<void>
  pull(rootUri: string): Promise<void>
  push(rootUri: string): Promise<void>
  history(rootUri: string, limit?: number): Promise<GitCommit[]>
  historyPage(rootUri: string, cursor?: string, pageSize?: number): Promise<GitHistoryPage>
  numstat(rootUri: string): Promise<GitNumstatEntry[]>
  commitFiles(rootUri: string, hash: string): Promise<GitCommitDetail>
  applyPatch(rootUri: string, patch: string, opts?: { reverse?: boolean }): Promise<void>
  worktreeList(rootUri: string): Promise<GitWorktree[]>
  worktreeAdd(
    rootUri: string,
    worktreePath: string,
    opts: { branch: string; baseRef?: string; createBranch?: boolean },
  ): Promise<GitWorktree>
  worktreeRemove(
    rootUri: string,
    worktreePath: string,
    opts?: { force?: boolean },
  ): Promise<void>
  defaultBranch(rootUri: string): Promise<string | null>
}

export type OpenInAppId =
  | "vscode"
  | "cursor"
  | "emacs"
  | "sublime"
  | "zed"
  | "finder"
  | "terminal"
  | "kitty"
  | "ghostty"
  | "xcode"
  | "intellij"

export type JetElectronShell = {
  openInApp(appId: OpenInAppId, rootUri: string): Promise<{ ok: boolean }>
  revealInFolder(rootUri: string): Promise<{ ok: boolean }>
}

export type JetElectronNotifications = {
  list(
    req?: import("@yaade/shared").ListNotificationsRequest,
  ): Promise<import("@yaade/shared").ListNotificationsResponse>
  counts(): Promise<import("@yaade/shared").NotificationCounts>
  get(id: string): Promise<import("@yaade/shared").AppNotification | null>
  ingest(
    req: import("@yaade/shared").IngestNotificationRequest,
  ): Promise<{
    notification: import("@yaade/shared").AppNotification | null
    created: boolean
    updated: boolean
    deduped: boolean
    skipped: boolean
    skipReason?: string
  }>
  markRead(id: string): Promise<import("@yaade/shared").AppNotification | null>
  markUnread(id: string): Promise<import("@yaade/shared").AppNotification | null>
  dismiss(id: string): Promise<import("@yaade/shared").AppNotification | null>
  restore(id: string): Promise<import("@yaade/shared").AppNotification | null>
  acknowledge(id: string): Promise<import("@yaade/shared").AppNotification | null>
  markAllRead(
    req?: import("@yaade/shared").MarkAllNotificationsReadRequest,
  ): Promise<import("@yaade/shared").NotificationCounts>
  unreadBySession(): Promise<Record<string, number>>
  markSessionUnread(
    sessionId: string,
  ): Promise<import("@yaade/shared").AppNotification | null>
  getPreferences(): Promise<import("@yaade/shared").NotificationPreferences>
  setPreferences(
    prefs: Partial<import("@yaade/shared").NotificationPreferences>,
  ): Promise<import("@yaade/shared").NotificationPreferences>
  bindSession(
    req: import("@yaade/shared").BindNotificationSessionRequest,
  ): Promise<{ ok: boolean }>
  onEvent(
    callback: (event: import("@yaade/shared").NotificationStreamEvent) => void,
  ): () => void
}

export type JetElectronAgents = {
  listProviders(refresh?: boolean): Promise<Array<{
    provider: "claude" | "codex" | "cursor" | "opencode" | "grok"
    available: boolean
    binary: string
    version: string | null
    capabilities: import("@yaade/agents").AgentDriverCapabilities
    error: string | null
  }>>
  launch(req: {
    launchRequestId: string
    provider: "claude" | "codex" | "cursor" | "opencode" | "grok"
    projectId: string
    workspaceId: string
    checkoutKey?: string
    title?: string
    args?: string[]
  }): Promise<{
    run: AgentRunInfo
    pty: { id: string; title: string | null } | null
  }>
  stop(req: { runId: string; generation?: number }): Promise<AgentRunInfo | null>
  listLive(projectId?: string): Promise<AgentRunInfo[]>
  get(runId: string): Promise<AgentRunInfo | null>
  listActivity(opts?: { limit?: number; cursor?: string; projectId?: string }): Promise<{
    runs: AgentRunInfo[]
    nextCursor: string | null
  }>
  getSnapshot(
    sessionId: string,
  ): Promise<import("@yaade/agents").AgentSessionSnapshot | null>
  listEvents(
    sessionId: string,
    opts?: { limit?: number; before?: string },
  ): Promise<import("@yaade/agents").AgentEvent[]>
  ingestNative(req: {
    provider: string
    sessionId: string
    payload: unknown
    processId?: string
    projectId?: string
    focusedSessionId?: string | null
    appFocused?: boolean
  }): Promise<{
    eventCount: number
    snapshot: import("@yaade/agents").AgentSessionSnapshot | null
    nativeSessionId: string | null
  }>
  installProjectHooks(req: {
    provider: string
    projectRoot: string
  }): Promise<{ written: string[] }>
  onEvent(
    callback: (event: {
      type: "agents.snapshot" | "agents.event" | "agents.run"
      sessionId: string
      snapshot?: import("@yaade/agents").AgentSessionSnapshot
      nativeSessionId?: string
      event?: import("@yaade/agents").AgentEvent
      kind?: "run.created" | "run.updated" | "run.ended"
      run?: AgentRunInfo
    }) => void,
  ): () => void
}

export type JetElectronAgentRuntime = {
  createThread(input: AgentRuntimeCreateRequest): Promise<AgentRuntimeThreadSnapshot>
  listThreads(projectSessionId?: string): Promise<AgentRuntimeThreadSnapshot[]>
  listProviders(): Promise<AgentRuntimeProviderDescriptor[]>
  listDrivers(cwdUri: string): Promise<AgentRuntimeDriverDiscovery[]>
  uploadAttachment(
    input: AgentRuntimeAttachmentUpload,
  ): Promise<AgentRuntimeAttachmentDescriptor>
  getSnapshot(threadId: string): Promise<AgentRuntimeThreadSnapshot | null>
  getConnectionState(threadId: string): Promise<AgentRuntimeConnectionState>
  recoverThread(
    threadId: string,
    afterSequence: number,
  ): Promise<AgentRuntimeThreadRecovery>
  sendCommand(
    command: AgentRuntimeCommandEnvelope,
  ): Promise<AgentRuntimeCommandResult>
  closeThread(threadId: string): Promise<AgentRuntimeThreadSnapshot>
  deleteThread(threadId: string): Promise<boolean>
  onEvent(callback: (event: AgentRuntimeEvent) => void): () => void
  onSnapshot(callback: (snapshot: AgentRuntimeThreadSnapshot) => void): () => void
  onConnection(callback: (update: AgentRuntimeConnectionUpdate) => void): () => void
  onRegistryChanged(callback: (providers: AgentRuntimeRegistrySnapshot) => void): () => void
  onReplayGap(callback: (floor: number, lastSequence: number) => void): () => void
}

export type AgentRunInfo = {
  runId: string
  launchRequestId: string
  generation: number
  provider: "claude" | "codex" | "cursor" | "opencode" | "grok"
  projectId: string
  workspaceId: string
  checkoutKey: string
  checkoutPath: string
  title: string
  ptyId: string | null
  nativeSessionId: string | null
  processState: "reserved" | "starting" | "running" | "exited" | "disconnected"
  activityState: "starting" | "working" | "running_tool" | "waiting_for_permission" | "waiting_for_user" | "idle" | "failed"
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

export type YaadeHostAPI = {
  fs: JetElectronFS
  search: JetElectronSearch
  lsp: JetElectronLSP
  terminal?: JetElectronTerminal
  tasks?: JetElectronTasks
  workspace?: JetElectronWorkspace
  git?: JetElectronGit
  shell?: JetElectronShell
  notifications?: JetElectronNotifications
  agents?: JetElectronAgents
  agentRuntime?: JetElectronAgentRuntime
  getLaunchConfig?(): Promise<LaunchConfig | null>
  getHomeDir?(): Promise<string>
  loadGlobalYaadercScanRoots?(): Promise<string[]>
  onLaunch?(cb: (config: LaunchConfig) => void): () => void
  recordStartup?(record: Record<string, unknown>): Promise<string>
  getStartupLogPath?(): Promise<string>
}

declare global {
  interface Window {
    yaade?: YaadeHostAPI
  }
}

export type PanelViewKind = PanelView["kind"]
