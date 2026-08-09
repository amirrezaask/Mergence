import { DriverId, ProviderId, type AgentDriverDescriptor } from "@yaade/agent-protocol"
import { Schema } from "effect"

export type AcpDriverProfile = {
  readonly descriptor: AgentDriverDescriptor
  readonly command: string
  readonly executableCandidates: ReadonlyArray<string>
  readonly args: ReadonlyArray<string>
  readonly env?: Readonly<Record<string, string>>
  readonly detection?: {
    readonly versionArgs: ReadonlyArray<string>
    readonly authStatusArgs?: ReadonlyArray<string>
    readonly loginRemedy?: string
  }
  readonly vendorElicitationMethods?: ReadonlyArray<string>
  /** Vendor RPC that returns the full model catalog after session open. */
  readonly listAvailableModelsMethod?: string
  readonly allowImageContent?: boolean
}

function profile(
  providerId: string,
  driverId: string,
  name: string,
  command: string,
  args: ReadonlyArray<string>,
  priority = 100,
): AcpDriverProfile {
  return {
    descriptor: {
      id: Schema.decodeUnknownSync(DriverId)(driverId),
      providerId: Schema.decodeUnknownSync(ProviderId)(providerId),
      name,
      integration: "acp",
      integrationVersion: "1",
      priority,
      supportsRemoteHost: true,
    },
    command,
    executableCandidates: [command],
    args,
  }
}

export function cursorAcpProfile(command = "agent"): AcpDriverProfile {
  const base = profile("cursor", "cursor:acp", "Cursor ACP", command, ["acp"], 200)
  return {
    ...base,
    executableCandidates: command === "agent" ? ["agent", "cursor-agent"] : [command],
    detection: {
      versionArgs: ["--version"],
      authStatusArgs: ["status"],
      loginRemedy: "Run agent login",
    },
    vendorElicitationMethods: ["cursor/ask_question"],
    listAvailableModelsMethod: "cursor/list_available_models",
    allowImageContent: true,
  }
}

export function grokAcpProfile(command = "grok"): AcpDriverProfile {
  return profile("grok", "grok:acp", "Grok ACP", command, ["acp"], 190)
}

export function opencodeAcpProfile(command = "opencode"): AcpDriverProfile {
  return profile("opencode", "opencode:acp", "OpenCode ACP", command, ["acp"], 120)
}

export function mockAcpProfile(
  command: string,
  args: ReadonlyArray<string>,
): AcpDriverProfile {
  return profile("mock-acp", "mock-acp:acp", "Mock ACP", command, args, 1_000)
}
