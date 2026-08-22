import { Context } from "effect"
import type { HostRuntime } from "../host-runtime.js"

/** The single runtime value shared by HTTP and WebSocket dispatch. */
export class HostRuntimeTag extends Context.Tag("yaade/HostRuntime")<HostRuntimeTag, HostRuntime>() {}
