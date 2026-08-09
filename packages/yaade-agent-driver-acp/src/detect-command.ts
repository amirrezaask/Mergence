import type { AgentDriverDetection, AgentDriverDetectionContext } from "@yaade/agent-driver"
import type { AcpDriverProfile } from "./profiles.js"

export type CommandProbeResult = {
  readonly exitCode: number | null
  readonly output: string
}

export type CommandProbe = (
  command: string,
  args: ReadonlyArray<string>,
  signal: AbortSignal,
) => Promise<CommandProbeResult>

export async function detectAcpCommand(
  profile: AcpDriverProfile,
  context: AgentDriverDetectionContext,
  probe: CommandProbe = (command, args) => context.commands.probe(command, args),
): Promise<AgentDriverDetection> {
  if (context.signal.aborted) return { available: false, reason: "aborted" }
  const command = await context.commands.resolveExecutable(profile.executableCandidates)
  if (!command) {
    return {
      available: false,
      reason: `${profile.executableCandidates.join(" or ")} was not found on PATH`,
    }
  }
  if (!profile.detection) {
    return { available: true, version: profile.descriptor.integrationVersion }
  }
  let version: CommandProbeResult
  try {
    version = await probe(command, profile.detection.versionArgs, context.signal)
  } catch (error) {
    return { available: false, reason: `version probe failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (version.exitCode !== 0) return { available: false, reason: "version probe failed" }
  if (profile.detection.authStatusArgs) {
    let auth: CommandProbeResult
    try {
      auth = await probe(command, profile.detection.authStatusArgs, context.signal)
    } catch (error) {
      if (context.signal.aborted) return { available: false, reason: "aborted" }
      return { available: false, reason: `${profile.detection.loginRemedy ?? "Authentication required"}: ${error instanceof Error ? error.message : String(error)}` }
    }
    const unauthenticated = auth.exitCode !== 0 || /not\s+(?:logged|signed)\s+in|unauthenticated|authentication required/i.test(auth.output)
    if (unauthenticated) {
      return { available: false, reason: profile.detection.loginRemedy ?? "Authentication required" }
    }
  }
  const parsedVersion = version.output.trim().split(/\s+/).find(part => /\d+\.\d+/.test(part))
  return { available: true, ...(parsedVersion ? { version: parsedVersion } : {}) }
}
