import { Context } from "effect"
import type { TerminalHost } from "@yaade/node-host"
import type { HostConfig } from "../config.js"
import type { EventHub } from "../events.js"
import type { HostRuntime } from "../host-runtime.js"
import type { RuntimeDatabase } from "../runtime-database.js"
import type { MuxSessionStore } from "../mux-store.js"
import type { TerminalService } from "../terminal-runtime/service.js"

export class HostConfigTag extends Context.Tag("yaade/HostConfig")<HostConfigTag, HostConfig>() {}
export class EventHubTag extends Context.Tag("yaade/EventHub")<EventHubTag, EventHub>() {}
export class RuntimeDatabaseTag extends Context.Tag("yaade/RuntimeDatabase")<RuntimeDatabaseTag, RuntimeDatabase>() {}
export class TerminalHostTag extends Context.Tag("yaade/TerminalHost")<TerminalHostTag, TerminalHost>() {}
export class TerminalServiceTag extends Context.Tag("yaade/TerminalService")<TerminalServiceTag, TerminalService>() {}
export class MuxSessionStoreTag extends Context.Tag("yaade/MuxSessionStore")<MuxSessionStoreTag, MuxSessionStore>() {}
export class HomeDirTag extends Context.Tag("yaade/HomeDir")<HomeDirTag, string>() {}
export class HostRuntimeTag extends Context.Tag("yaade/HostRuntime")<HostRuntimeTag, HostRuntime>() {}
