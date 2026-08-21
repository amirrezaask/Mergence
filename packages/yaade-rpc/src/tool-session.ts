import { Data, Schema } from "effect";

/** Stable identifiers for sessions, session windows, and persisted tool uses. */
export const SessionId = Schema.String.pipe(
  Schema.pattern(/^ses-[A-Za-z0-9_-]+$/),
  Schema.brand("SessionId"),
);
export type SessionId = Schema.Schema.Type<typeof SessionId>;

export const ToolUseId = Schema.String.pipe(
  Schema.pattern(/^use-[A-Za-z0-9_-]+$/),
  Schema.brand("ToolUseId"),
);
export type ToolUseId = Schema.Schema.Type<typeof ToolUseId>;

/** A tmux-window equivalent: one session can contain many independent tabs. */
export const SessionTabId = Schema.String.pipe(
  Schema.pattern(/^tab-[A-Za-z0-9_-]+$/),
  Schema.brand("SessionTabId"),
);
export type SessionTabId = Schema.Schema.Type<typeof SessionTabId>;

export const ToolKind = Schema.Literal("terminal", "git");
export type ToolKind = Schema.Schema.Type<typeof ToolKind>;

export const ToolUseStatus = Schema.Literal(
  "created",
  "starting",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
  "disconnected",
);
export type ToolUseStatus = Schema.Schema.Type<typeof ToolUseStatus>;

export class ProjectTarget extends Schema.Class<ProjectTarget>("ProjectTarget")(
  {
    projectId: Schema.String,
    projectPath: Schema.String,
    projectName: Schema.String,
  },
) {}

export class MainCheckout extends Schema.TaggedClass<MainCheckout>()(
  "MainCheckout",
  { kind: Schema.Literal("main") },
) {}

export class ExistingWorktreeCheckout extends Schema.TaggedClass<ExistingWorktreeCheckout>()(
  "ExistingWorktreeCheckout",
  {
    kind: Schema.Literal("existing-worktree"),
    path: Schema.String,
    branch: Schema.optional(Schema.String),
  },
) {}

export class BranchWorktreeCheckout extends Schema.TaggedClass<BranchWorktreeCheckout>()(
  "BranchWorktreeCheckout",
  {
    kind: Schema.Literal("branch-worktree"),
    branch: Schema.String,
    baseRef: Schema.optional(Schema.String),
    createBranch: Schema.Boolean,
  },
) {}

export const CheckoutTarget = Schema.Union(
  MainCheckout,
  ExistingWorktreeCheckout,
  BranchWorktreeCheckout,
);
export type CheckoutTarget = Schema.Schema.Type<typeof CheckoutTarget>;

export class ResolvedToolContext extends Schema.Class<ResolvedToolContext>(
  "ResolvedToolContext",
)({
  project: ProjectTarget,
  checkoutKey: Schema.String,
  checkoutPath: Schema.String,
  checkoutLabel: Schema.String,
  branch: Schema.optional(Schema.String),
  managedWorktree: Schema.Boolean,
}) {}

export class TerminalToolInput extends Schema.TaggedClass<TerminalToolInput>()(
  "TerminalToolInput",
  {
    kind: Schema.Literal("terminal"),
    shellArgs: Schema.optional(Schema.Array(Schema.String)),
    /** When set, the PTY launches this executable instead of the login shell. */
    executable: Schema.optional(Schema.String),
    /** When set, the host treats the PTY as this agent provider. */
    provider: Schema.optional(
      Schema.Literal("claude", "codex", "cursor", "opencode", "grok", "pi"),
    ),
  },
) {}

/** Git is an interactive repository history/review surface, not a process. */
export class GitToolInput extends Schema.TaggedClass<GitToolInput>()(
  "GitToolInput",
  { kind: Schema.Literal("git") },
) {}

export const ToolUseInput = Schema.Union(TerminalToolInput, GitToolInput);
export type ToolUseInput = Schema.Schema.Type<typeof ToolUseInput>;

export const ProcessState = Schema.Literal(
  "starting",
  "running",
  "exited",
  "failed",
  "disconnected",
  "interrupted",
  "restoring",
  "orphaned",
);
export const ActivityState = Schema.Literal(
  "starting",
  "working",
  "running_tool",
  "waiting_for_permission",
  "waiting_for_user",
  "idle",
  "failed",
);

export class ProcessToolOutput extends Schema.TaggedClass<ProcessToolOutput>()(
  "ProcessToolOutput",
  {
    kind: Schema.Literal("process"),
    terminalInstanceId: Schema.String,
    ptyId: Schema.optional(Schema.String),
    generation: Schema.Number,
    processState: ProcessState,
    activityState: ActivityState,
    replayAvailable: Schema.Boolean,
    exitCode: Schema.optional(Schema.Number),
    truncated: Schema.Boolean,
  },
) {}

export class GitToolOutput extends Schema.TaggedClass<GitToolOutput>()(
  "GitToolOutput",
  { kind: Schema.Literal("git") },
) {}

export const ToolUseOutput = Schema.Union(ProcessToolOutput, GitToolOutput);
export type ToolUseOutput = Schema.Schema.Type<typeof ToolUseOutput>;

export class AppSession extends Schema.Class<AppSession>("AppSession")({
  id: SessionId,
  title: Schema.String,
  position: Schema.Number,
  /** Current tmux-window equivalent. */
  activeTabId: Schema.optional(SessionTabId),
  /** Kept for one migration cycle for older clients. */
  activeToolUseId: Schema.optional(ToolUseId),
  revision: Schema.optional(Schema.Number),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  archivedAt: Schema.optional(Schema.String),
}) {}

export class SessionTab extends Schema.Class<SessionTab>("SessionTab")({
  id: SessionTabId,
  sessionId: SessionId,
  title: Schema.String,
  position: Schema.Number,
  activeToolUseId: Schema.optional(ToolUseId),
  /** Versioned JSON snapshot of this Window's one-ToolUse-per-pane split tree. */
  layoutJson: Schema.optional(Schema.String),
  revision: Schema.optional(Schema.Number),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  archivedAt: Schema.optional(Schema.String),
}) {}

const ToolUseRecord = Schema.Struct({
  id: ToolUseId,
  sessionId: SessionId,
  /** Optional only for decoding pre-window persisted records. New records always set it. */
  tabId: Schema.optional(SessionTabId),
  kind: ToolKind,
  title: Schema.String,
  position: Schema.Number,
  status: ToolUseStatus,
  context: ResolvedToolContext,
  input: ToolUseInput,
  inputRevision: Schema.Number,
  output: ToolUseOutput,
  error: Schema.optional(Schema.String),
  revision: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  startedAt: Schema.optional(Schema.String),
  finishedAt: Schema.optional(Schema.String),
  archivedAt: Schema.optional(Schema.String),
});

/** A persisted invocation. The filter enforces the input/output kind pairing. */
export const ToolUse = ToolUseRecord.pipe(
  Schema.filter(
    (value) =>
      (value.kind === "git" &&
        value.input.kind === "git" &&
        value.output.kind === "git") ||
      (value.kind === "terminal" &&
        value.input.kind === "terminal" &&
        value.output.kind === "process"),
    { message: () => "ToolUse kind does not match its input and output" },
  ),
);
export type ToolUse = Schema.Schema.Type<typeof ToolUseRecord>;

export class CreateSession extends Schema.TaggedClass<CreateSession>()(
  "CreateSession",
  {
    title: Schema.optional(Schema.String),
  },
) {}
export class RenameSession extends Schema.TaggedClass<RenameSession>()(
  "RenameSession",
  {
    sessionId: SessionId,
    title: Schema.String,
  },
) {}
export class CreateSessionTab extends Schema.TaggedClass<CreateSessionTab>()(
  "CreateSessionTab",
  {
    sessionId: SessionId,
    title: Schema.optional(Schema.String),
  },
) {}
export class RenameSessionTab extends Schema.TaggedClass<RenameSessionTab>()(
  "RenameSessionTab",
  {
    tabId: SessionTabId,
    title: Schema.String,
  },
) {}
export class SaveSessionTabLayout extends Schema.TaggedClass<SaveSessionTabLayout>()(
  "SaveSessionTabLayout",
  {
    tabId: SessionTabId,
    layoutJson: Schema.String.pipe(Schema.maxLength(65_536)),
    /** Revision observed by the writer; prevents an older layout overwriting a newer one. */
    revision: Schema.optional(Schema.Number),
  },
) {}
export class ReorderSessionTabs extends Schema.TaggedClass<ReorderSessionTabs>()(
  "ReorderSessionTabs",
  {
    sessionId: SessionId,
    tabIds: Schema.Array(SessionTabId),
  },
) {}
export class ArchiveSessionTab extends Schema.TaggedClass<ArchiveSessionTab>()(
  "ArchiveSessionTab",
  {
    tabId: SessionTabId,
    mode: Schema.Literal("keep-running", "stop-tools"),
  },
) {}
export class SelectSessionTab extends Schema.TaggedClass<SelectSessionTab>()(
  "SelectSessionTab",
  {
    sessionId: SessionId,
    tabId: Schema.optional(SessionTabId),
  },
) {}
export class ReorderSessions extends Schema.TaggedClass<ReorderSessions>()(
  "ReorderSessions",
  {
    sessionIds: Schema.Array(SessionId),
  },
) {}
export class ArchiveSession extends Schema.TaggedClass<ArchiveSession>()(
  "ArchiveSession",
  {
    sessionId: SessionId,
    mode: Schema.Literal("keep-running", "stop-tools"),
  },
) {}
export class RestoreSession extends Schema.TaggedClass<RestoreSession>()(
  "RestoreSession",
  {
    sessionId: SessionId,
  },
) {}
export class CreateToolUse extends Schema.TaggedClass<CreateToolUse>()(
  "CreateToolUse",
  {
    sessionId: SessionId,
    /** Optional for older clients; the host resolves the session's active tab. */
    tabId: Schema.optional(SessionTabId),
    title: Schema.optional(Schema.String),
    kind: ToolKind,
    project: ProjectTarget,
    checkout: CheckoutTarget,
    input: ToolUseInput,
  },
) {}
export class AddProject extends Schema.TaggedClass<AddProject>()(
  "AddProject",
  {
    rootPath: Schema.String,
  },
) {}
export class UpdateToolUseContext extends Schema.TaggedClass<UpdateToolUseContext>()(
  "UpdateToolUseContext",
  {
    toolUseId: ToolUseId,
    revision: Schema.Number,
    project: ProjectTarget,
    checkout: CheckoutTarget,
  },
) {}
export class ReorderToolUses extends Schema.TaggedClass<ReorderToolUses>()(
  "ReorderToolUses",
  {
    sessionId: SessionId,
    /** Optional for older clients; new clients reorder within one tab. */
    tabId: Schema.optional(SessionTabId),
    toolUseIds: Schema.Array(ToolUseId),
  },
) {}
export class CancelToolUse extends Schema.TaggedClass<CancelToolUse>()(
  "CancelToolUse",
  {
    toolUseId: ToolUseId,
    revision: Schema.Number,
  },
) {}
export class RestartToolUse extends Schema.TaggedClass<RestartToolUse>()(
  "RestartToolUse",
  {
    toolUseId: ToolUseId,
    revision: Schema.Number,
  },
) {}
export class ArchiveToolUse extends Schema.TaggedClass<ArchiveToolUse>()(
  "ArchiveToolUse",
  {
    toolUseId: ToolUseId,
  },
) {}
export class SelectSessionToolUse extends Schema.TaggedClass<SelectSessionToolUse>()(
  "SelectSessionToolUse",
  { sessionId: SessionId, toolUseId: Schema.optional(ToolUseId) },
) {}
export class ListSessions extends Schema.TaggedClass<ListSessions>()(
  "ListSessions",
  {
    includeArchived: Schema.optional(Schema.Boolean),
  },
) {}
export class GetSession extends Schema.TaggedClass<GetSession>()("GetSession", {
  sessionId: SessionId,
}) {}
export class GetToolUse extends Schema.TaggedClass<GetToolUse>()("GetToolUse", {
  toolUseId: ToolUseId,
}) {}
export class ListCheckoutTargets extends Schema.TaggedClass<ListCheckoutTargets>()(
  "ListCheckoutTargets",
  {
    projectId: Schema.String,
  },
) {}

export const ToolCommand = Schema.Union(
  CreateSession,
  RenameSession,
  CreateSessionTab,
  RenameSessionTab,
  SaveSessionTabLayout,
  ReorderSessionTabs,
  ArchiveSessionTab,
  SelectSessionTab,
  ReorderSessions,
  ArchiveSession,
  RestoreSession,
  CreateToolUse,
  AddProject,
  UpdateToolUseContext,
  ReorderToolUses,
  CancelToolUse,
  RestartToolUse,
  ArchiveToolUse,
  SelectSessionToolUse,
  ListSessions,
  GetSession,
  GetToolUse,
  ListCheckoutTargets,
);
export type ToolCommand = Schema.Schema.Type<typeof ToolCommand>;

const EventBase = {
  eventId: Schema.String,
  revision: Schema.Number,
  occurredAt: Schema.String,
};

export class SessionCreated extends Schema.TaggedClass<SessionCreated>()(
  "SessionCreated",
  {
    ...EventBase,
    session: AppSession,
  },
) {}
export class SessionUpdated extends Schema.TaggedClass<SessionUpdated>()(
  "SessionUpdated",
  {
    ...EventBase,
    session: AppSession,
  },
) {}
export class SessionArchived extends Schema.TaggedClass<SessionArchived>()(
  "SessionArchived",
  {
    ...EventBase,
    session: AppSession,
  },
) {}
export class SessionRestored extends Schema.TaggedClass<SessionRestored>()(
  "SessionRestored",
  {
    ...EventBase,
    session: AppSession,
  },
) {}
export class SessionTabCreated extends Schema.TaggedClass<SessionTabCreated>()(
  "SessionTabCreated",
  {
    ...EventBase,
    tab: SessionTab,
  },
) {}
export class SessionTabUpdated extends Schema.TaggedClass<SessionTabUpdated>()(
  "SessionTabUpdated",
  {
    ...EventBase,
    tab: SessionTab,
  },
) {}
export class SessionTabArchived extends Schema.TaggedClass<SessionTabArchived>()(
  "SessionTabArchived",
  {
    ...EventBase,
    tab: SessionTab,
  },
) {}
export class ToolUseCreated extends Schema.TaggedClass<ToolUseCreated>()(
  "ToolUseCreated",
  {
    ...EventBase,
    toolUseId: ToolUseId,
    toolUse: ToolUse,
  },
) {}
export class ToolUseUpdated extends Schema.TaggedClass<ToolUseUpdated>()(
  "ToolUseUpdated",
  {
    ...EventBase,
    toolUseId: ToolUseId,
    toolUse: ToolUse,
  },
) {}
export class ToolUseOutputChanged extends Schema.TaggedClass<ToolUseOutputChanged>()(
  "ToolUseOutputChanged",
  { ...EventBase, toolUseId: ToolUseId, output: ToolUseOutput },
) {}
export class ToolUseArchived extends Schema.TaggedClass<ToolUseArchived>()(
  "ToolUseArchived",
  {
    ...EventBase,
    toolUseId: ToolUseId,
  },
) {}

export const ToolEvent = Schema.Union(
  SessionCreated,
  SessionUpdated,
  SessionArchived,
  SessionRestored,
  SessionTabCreated,
  SessionTabUpdated,
  SessionTabArchived,
  ToolUseCreated,
  ToolUseUpdated,
  ToolUseOutputChanged,
  ToolUseArchived,
);
export type ToolEvent = Schema.Schema.Type<typeof ToolEvent>;

export class SessionTabNotFound extends Data.TaggedError("SessionTabNotFound")<{
  readonly tabId: string;
  readonly message: string;
}> {
  readonly code = "NOT_FOUND" as const;
}
export class SessionTabConflict extends Data.TaggedError("SessionTabConflict")<{
  readonly tabId: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;
  readonly message: string;
}> {
  readonly code = "CONFLICT" as const;
}
export class SessionNotFound extends Data.TaggedError("SessionNotFound")<{
  readonly sessionId: string;
  readonly message: string;
}> {
  readonly code = "NOT_FOUND" as const;
}
export class ToolUseNotFound extends Data.TaggedError("ToolUseNotFound")<{
  readonly toolUseId: string;
  readonly message: string;
}> {
  readonly code = "NOT_FOUND" as const;
}
export type InvalidToolInputDetails = object;

export class InvalidToolInput extends Data.TaggedError("InvalidToolInput")<{
  readonly message: string;
  readonly details?: InvalidToolInputDetails;
}> {
  readonly code = "OPERATION_FAILED" as const;
}
export class InvalidToolCommand extends Data.TaggedError("InvalidToolCommand")<{
  readonly message: string;
}> {
  readonly code = "OPERATION_FAILED" as const;
}
export class ProjectTargetUnavailable extends Data.TaggedError(
  "ProjectTargetUnavailable",
)<{
  readonly projectPath: string;
  readonly message: string;
}> {
  readonly code = "PATH_OUTSIDE_ALLOWED_ROOTS" as const;
}
export class CheckoutResolutionFailed extends Data.TaggedError(
  "CheckoutResolutionFailed",
)<{
  readonly message: string;
}> {
  readonly code = "OPERATION_FAILED" as const;
}
export class ToolUseConflict extends Data.TaggedError("ToolUseConflict")<{
  readonly toolUseId: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;
  readonly message: string;
}> {
  readonly code = "CONFLICT" as const;
}
export class ToolRuntimeFailure extends Data.TaggedError("ToolRuntimeFailure")<{
  readonly toolUseId: string;
  readonly message: string;
  readonly cause?: unknown;
}> {
  readonly code = "OPERATION_FAILED" as const;
}

export type ToolSessionError =
  | SessionNotFound
  | SessionTabNotFound
  | SessionTabConflict
  | ToolUseNotFound
  | InvalidToolInput
  | InvalidToolCommand
  | ProjectTargetUnavailable
  | CheckoutResolutionFailed
  | ToolUseConflict
  | ToolRuntimeFailure;
