import { Context, type PubSub } from "effect";
import type { PerfHost, TerminalHost } from "@yaade/node-host";
import type { NotificationStreamEvent } from "@yaade/shared";
import type { HostConfig } from "../config.js";
import type { EventHub } from "../events.js";
import type { HostRuntime } from "../host-runtime.js";
import type { NotificationService } from "../notifications/index.js";
import type { ProjectDatabase } from "../persistence.js";
import type { ToolSessionStore } from "../tool-session-store.js";
import type { ToolService } from "../tools/service.js";

export class HostConfigTag extends Context.Tag("yaade/HostConfig")<
  HostConfigTag,
  HostConfig
>() {}

export class EventHubTag extends Context.Tag("yaade/EventHub")<
  EventHubTag,
  EventHub
>() {}

export class ProjectDatabaseTag extends Context.Tag("yaade/ProjectDatabase")<
  ProjectDatabaseTag,
  ProjectDatabase
>() {}

export class NotificationServiceTag extends Context.Tag(
  "yaade/NotificationService",
)<NotificationServiceTag, NotificationService>() {}

/** Fan-out for structured notification stream events (before EventHub WS framing). */
export class NotificationEventPubSub extends Context.Tag(
  "yaade/NotificationEventPubSub",
)<NotificationEventPubSub, PubSub.PubSub<NotificationStreamEvent>>() {}

export { GitServiceTag, type GitService } from "./git.js";
export class TerminalHostTag extends Context.Tag("yaade/TerminalHost")<
  TerminalHostTag,
  TerminalHost
>() {}

export class ToolServiceTag extends Context.Tag("yaade/ToolService")<
  ToolServiceTag,
  ToolService
>() {}

export class ToolSessionStoreTag extends Context.Tag("yaade/ToolSessionStore")<
  ToolSessionStoreTag,
  ToolSessionStore
>() {}

export class PerfHostTag extends Context.Tag("yaade/PerfHost")<
  PerfHostTag,
  PerfHost
>() {}

export class HomeDirTag extends Context.Tag("yaade/HomeDir")<
  HomeDirTag,
  string
>() {}

/** Aggregate runtime for HTTP/WS handlers and dispatch. */
export class HostRuntimeTag extends Context.Tag("yaade/HostRuntime")<
  HostRuntimeTag,
  HostRuntime
>() {}
