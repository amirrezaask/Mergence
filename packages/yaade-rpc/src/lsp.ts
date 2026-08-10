import { Schema } from "effect"

const StringArray = Schema.Array(Schema.String)
const StringRecord = Schema.Record({ key: Schema.String, value: Schema.String })
const CandidateArgs = Schema.Record({ key: Schema.String, value: StringArray })

/** A host-owned language-server definition. Repository files cannot add commands. */
export class LanguageServerDefinition extends Schema.Class<LanguageServerDefinition>(
  "LanguageServerDefinition",
)({
  id: Schema.String,
  languages: StringArray,
  commandCandidates: StringArray,
  args: StringArray,
  environment: StringRecord,
  candidateArgs: CandidateArgs,
  rootMarkers: StringArray,
  priority: Schema.Number,
  initializationOptions: Schema.optional(Schema.Unknown),
  settings: Schema.optional(Schema.Unknown),
  enabled: Schema.Boolean,
}) {}

/** Stable output of the single host resolution request for a document. */
export class ResolvedLanguageServerTarget extends Schema.Class<ResolvedLanguageServerTarget>(
  "ResolvedLanguageServerTarget",
)({
  serverId: Schema.String,
  projectRootUri: Schema.String,
  workspaceRootUri: Schema.String,
  /** Directory used as the language-server process cwd. */
  processCwdUri: Schema.optional(Schema.String),
  languageIds: StringArray,
  initializationOptions: Schema.optional(Schema.Unknown),
  settings: Schema.optional(Schema.Unknown),
  catalogVersion: Schema.Number,
}) {}

export class LspResolveRequest extends Schema.Class<LspResolveRequest>("LspResolveRequest")({
  languageId: Schema.String,
  fileUri: Schema.String,
  workspaceRootUri: Schema.String,
  /** Optional process cwd; protocol workspaceRootUri remains authoritative. */
  processCwdUri: Schema.optional(Schema.String),
}) {}

export class LspStartResult extends Schema.Class<LspStartResult>("LspStartResult")({
  id: Schema.String,
  transportUrl: Schema.String,
  target: ResolvedLanguageServerTarget,
  error: Schema.optional(Schema.String),
}) {}

export const LspLogLevel = Schema.Literal("debug", "info", "warning", "error")
export type LspLogLevel = Schema.Schema.Type<typeof LspLogLevel>

export const LspLogStream = Schema.Literal("host", "stdout", "stderr")
export type LspLogStream = Schema.Schema.Type<typeof LspLogStream>

export class LspLogEntry extends Schema.Class<LspLogEntry>("LspLogEntry")({
  timestamp: Schema.Number,
  level: LspLogLevel,
  stream: LspLogStream,
  serverId: Schema.String,
  projectRootUri: Schema.String,
  sessionId: Schema.optional(Schema.String),
  message: Schema.String,
}) {}

export const LspLifecycleKind = Schema.Literal(
  "starting",
  "ready",
  "stopped",
  "crashed",
  "restarting",
  "configuration-changed",
  "configuration-invalid",
)
export type LspLifecycleKind = Schema.Schema.Type<typeof LspLifecycleKind>

export class LspLifecycleEvent extends Schema.Class<LspLifecycleEvent>("LspLifecycleEvent")({
  kind: LspLifecycleKind,
  timestamp: Schema.Number,
  serverId: Schema.optional(Schema.String),
  projectRootUri: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  attempt: Schema.optional(Schema.Number),
  message: Schema.optional(Schema.String),
  transportUrl: Schema.optional(Schema.String),
  target: Schema.optional(ResolvedLanguageServerTarget),
  settingsOnly: Schema.optional(Schema.Boolean),
  settings: Schema.optional(Schema.Unknown),
}) {}

export class LspLogRequest extends Schema.Class<LspLogRequest>("LspLogRequest")({
  serverId: Schema.optional(Schema.String),
  projectRootUri: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
}) {}
