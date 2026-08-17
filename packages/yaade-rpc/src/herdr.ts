import { Schema } from "effect"

export const HerdrAgentStatus = Schema.Literal(
  "idle",
  "working",
  "blocked",
  "done",
  "unknown",
)
export type HerdrAgentStatus = Schema.Schema.Type<typeof HerdrAgentStatus>

export class HerdrScrollState extends Schema.Class<HerdrScrollState>("HerdrScrollState")({
  offset_from_bottom: Schema.Number,
  max_offset_from_bottom: Schema.Number,
  viewport_rows: Schema.Number,
}) {}

export class HerdrWorkspace extends Schema.Class<HerdrWorkspace>("HerdrWorkspace")({
  workspace_id: Schema.String,
  number: Schema.Number,
  label: Schema.String,
  focused: Schema.Boolean,
  pane_count: Schema.Number,
  tab_count: Schema.Number,
  active_tab_id: Schema.String,
  agent_status: HerdrAgentStatus,
}) {}

export class HerdrTab extends Schema.Class<HerdrTab>("HerdrTab")({
  tab_id: Schema.String,
  workspace_id: Schema.String,
  number: Schema.Number,
  label: Schema.String,
  focused: Schema.Boolean,
  pane_count: Schema.Number,
  agent_status: HerdrAgentStatus,
}) {}

export class HerdrPane extends Schema.Class<HerdrPane>("HerdrPane")({
  pane_id: Schema.String,
  terminal_id: Schema.String,
  workspace_id: Schema.String,
  tab_id: Schema.String,
  cwd: Schema.String,
  foreground_cwd: Schema.optional(Schema.String),
  focused: Schema.Boolean,
  revision: Schema.Number,
  terminal_title: Schema.String,
  terminal_title_stripped: Schema.String,
  agent: Schema.optional(Schema.String),
  agent_status: HerdrAgentStatus,
  scroll: HerdrScrollState,
}) {}

export class HerdrLayoutPane extends Schema.Class<HerdrLayoutPane>("HerdrLayoutPane")({
  pane_id: Schema.String,
  focused: Schema.Boolean,
  rect: Schema.Struct({
    x: Schema.Number,
    y: Schema.Number,
    width: Schema.Number,
    height: Schema.Number,
  }),
}) {}

export class HerdrLayout extends Schema.Class<HerdrLayout>("HerdrLayout")({
  workspace_id: Schema.String,
  tab_id: Schema.String,
  focused_pane_id: Schema.String,
  zoomed: Schema.Boolean,
  area: Schema.Struct({
    x: Schema.Number,
    y: Schema.Number,
    width: Schema.Number,
    height: Schema.Number,
  }),
  panes: Schema.Array(HerdrLayoutPane),
  splits: Schema.Array(Schema.Unknown),
}) {}

export class HerdrSnapshot extends Schema.Class<HerdrSnapshot>("HerdrSnapshot")({
  version: Schema.String,
  protocol: Schema.Number,
  focused_workspace_id: Schema.optional(Schema.String),
  focused_tab_id: Schema.optional(Schema.String),
  focused_pane_id: Schema.optional(Schema.String),
  workspaces: Schema.Array(HerdrWorkspace),
  tabs: Schema.Array(HerdrTab),
  panes: Schema.Array(HerdrPane),
  layouts: Schema.Array(HerdrLayout),
  agents: Schema.Array(Schema.Unknown),
}) {}

export class HerdrSnapshotResponse extends Schema.Class<HerdrSnapshotResponse>("HerdrSnapshotResponse")({
  type: Schema.Literal("session_snapshot"),
  snapshot: HerdrSnapshot,
}) {}

export class HerdrCommand extends Schema.Class<HerdrCommand>("HerdrCommand")({
  method: Schema.String,
  params: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
}) {}

export class HerdrTerminalHandle extends Schema.Class<HerdrTerminalHandle>("HerdrTerminalHandle")({
  id: Schema.String,
  paneId: Schema.String,
  terminalId: Schema.String,
  title: Schema.String,
}) {}
