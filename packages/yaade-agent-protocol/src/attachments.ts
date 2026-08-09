import { Schema } from "effect"

export class AgentAttachment extends Schema.Class<AgentAttachment>(
  "AgentAttachment",
)({
  id: Schema.String,
  name: Schema.String,
  mediaType: Schema.String,
  size: Schema.Number,
  source: Schema.Union(
    Schema.Struct({
      type: Schema.Literal("workspace-resource"),
      uri: Schema.String,
    }),
    Schema.Struct({
      type: Schema.Literal("temporary-upload"),
      storageKey: Schema.String,
    }),
  ),
  createdAt: Schema.String,
}) {}
