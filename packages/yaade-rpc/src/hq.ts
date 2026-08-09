import { Schema } from "effect"

export const HqAgentProvider = Schema.Literal(
  "claude",
  "codex",
  "cursor",
  "opencode",
  "grok",
)
export type HqAgentProvider = Schema.Schema.Type<typeof HqAgentProvider>

export const HqAgentStatus = Schema.Literal(
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
)
export type HqAgentStatus = Schema.Schema.Type<typeof HqAgentStatus>

export const HqAttentionKind = Schema.Literal(
  "permission_required",
  "waiting_for_user",
  "turn_failed",
  "session_failed",
  "session_terminated",
)
export type HqAttentionKind = Schema.Schema.Type<typeof HqAttentionKind>

export class HqProjectSummary extends Schema.Class<HqProjectSummary>(
  "HqProjectSummary",
)({
  id: Schema.String,
  name: Schema.String,
  rootPath: Schema.String,
  availability: Schema.Literal("available", "missing", "forbidden"),
  sessionCount: Schema.Number,
  liveAgentCount: Schema.Number,
  attentionCount: Schema.Number,
  unreadCount: Schema.Number,
  lastActivityAt: Schema.NullOr(Schema.String),
}) {}

export class HqAgentSummary extends Schema.Class<HqAgentSummary>(
  "HqAgentSummary",
)({
  /** Durable OS-process lifetime. Legacy rows decode with an empty id. */
  runId: Schema.optionalWith(Schema.String, { default: () => "" }),
  generation: Schema.optionalWith(Schema.Number, { default: () => 0 }),
  sessionId: Schema.String,
  ptyId: Schema.String,
  projectId: Schema.String,
  projectName: Schema.String,
  projectPath: Schema.String,
  projectSessionId: Schema.String,
  projectSessionTitle: Schema.String,
  cwdPath: Schema.String,
  worktreeBranch: Schema.NullOr(Schema.String),
  provider: HqAgentProvider,
  title: Schema.String,
  status: HqAgentStatus,
  activity: Schema.String,
  telemetry: Schema.Literal("connected", "pending", "degraded", "process_only"),
  startedAt: Schema.NullOr(Schema.String),
  lastActivityAt: Schema.NullOr(Schema.String),
  runtimeMs: Schema.Number,
  unreadCount: Schema.Number,
  attention: Schema.NullOr(HqAttentionKind),
  currentTool: Schema.NullOr(
    Schema.Struct({
      name: Schema.String,
      category: Schema.String,
    }),
  ),
}) {}

export class HqSnapshot extends Schema.Class<HqSnapshot>("HqSnapshot")({
  version: Schema.Literal(1),
  generatedAt: Schema.String,
  machineHostname: Schema.String,
  notificationCounts: Schema.Struct({
    totalUnread: Schema.Number,
    actionRequired: Schema.Number,
    errors: Schema.Number,
  }),
  projects: Schema.Array(HqProjectSummary),
  agents: Schema.Array(HqAgentSummary),
}) {}
