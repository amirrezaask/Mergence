export {
  normalizeAgentId,
  agentCliDriverId,
  agentDriverIdForMode,
} from "./model.js"

export type {
  AgentProvider,
  AgentEventKind,
  AgentToolCategory,
  AgentEvent,
} from "./types/events.js"

export type {
  AgentSessionStatus,
  AgentSessionSnapshot,
  AgentSnapshotInternal,
} from "./types/snapshot.js"

export type {
  AgentDriverCapabilities,
  AgentDriverDetection,
  HookInstallationContext,
  HookInstallationResult,
  NativeHookInput,
  CliAgentDriver,
} from "./types/driver.js"

export {
  makeAgentEventId,
  derivedTurnId,
  stableHash,
} from "./ids.js"

export {
  redactCommandPreview,
  sanitizeMetadataValue,
} from "./redaction.js"

export {
  describeAgentActivity,
  formatDurationMs,
} from "./activity/describe.js"

export {
  isAgentActivityUiEvent,
  filterAgentActivityUiEvents,
} from "./activity/ui-events.js"

export {
  reduceAgentEvent,
  clearAgentSessionUnread,
  publicAgentSnapshot,
} from "./reduce/reduce-agent-event.js"

export type {
  AgentNotificationKind,
  AgentNotification,
  NotificationProjectionContext,
} from "./notifications/project.js"

export {
  projectAgentNotification,
  shouldDeliverDesktopNotification,
} from "./notifications/project.js"

export {
  getCliAgentDriver,
  listCliAgentDrivers,
  claudeDriver,
  codexDriver,
  cursorDriver,
  opencodeDriver,
  grokDriver,
  piDriver,
} from "./drivers/registry.js"

export {
  makeProcessStartedEvent,
  makeProcessExitedEvent,
} from "./process-events.js"

export { classifyGenericTool } from "./drivers/helpers.js"
