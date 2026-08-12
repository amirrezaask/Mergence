import {
  getCliAgentDriver,
  type AgentProvider as CliAgentProvider,
} from "@yaade/agents"

export type ProviderNotificationLaunch = {
  command: string
  args: string[]
  driver: "hook" | "osc" | "plugin"
  env: Record<string, string>
}

export type ProviderNotificationLaunchContext = {
  sessionId: string
  origin: string
  projectRoot?: string
}

function asCliProvider(provider: string): CliAgentProvider {
  if (
    provider === "claude" ||
    provider === "codex" ||
    provider === "cursor" ||
    provider === "opencode" ||
    provider === "grok" ||
    provider === "pi"
  ) {
    return provider
  }
  return "codex"
}

function ingestUrl(
  provider: CliAgentProvider,
  context: ProviderNotificationLaunchContext,
): string {
  const url = new URL("/api/v1/notifications/ingest", context.origin)
  url.searchParams.set("provider", provider)
  url.searchParams.set("sessionId", context.sessionId)
  return url.toString()
}

/**
 * Session-scoped provider notification / hook wiring via CliAgentDriver.
 * Never edits a user's global provider config for Claude (uses --settings).
 * Codex/Cursor/OpenCode may merge project-local hook files via host RPC.
 */
export async function notificationLaunchForProvider(
  provider: string,
  command: string,
  context: ProviderNotificationLaunchContext,
): Promise<ProviderNotificationLaunch> {
  const cliProvider = asCliProvider(provider)
  const url = ingestUrl(cliProvider, context)
  const driver = getCliAgentDriver(cliProvider)
  const installed = await driver.installHooks({
    sessionId: context.sessionId,
    projectRoot: context.projectRoot ?? ".",
    ingestUrl: url,
    provider: cliProvider,
    origin: context.origin,
  })
  return {
    command,
    args: installed.launchArgs,
    driver: installed.driver,
    env: installed.env,
  }
}

/** Sync helper for call sites that already have launch args built. */
export function notificationLaunchForProviderSync(
  provider: string,
  command: string,
  context: ProviderNotificationLaunchContext,
): ProviderNotificationLaunch {
  const cliProvider = asCliProvider(provider)
  const url = ingestUrl(cliProvider, context)
  if (cliProvider === "claude") {
    const handler = { type: "http", url, timeout: 5 }
    const entry = { hooks: [handler] }
    const matcherEntry = { matcher: "", ...entry }
    const settings = JSON.stringify({
      hooks: {
        SessionStart: [entry],
        SessionEnd: [entry],
        UserPromptSubmit: [entry],
        PreToolUse: [matcherEntry],
        PostToolUse: [matcherEntry],
        PostToolUseFailure: [matcherEntry],
        PermissionRequest: [matcherEntry],
        Notification: [matcherEntry],
        SubagentStart: [entry],
        SubagentStop: [entry],
        PreCompact: [entry],
        PostCompact: [entry],
        Stop: [entry],
        StopFailure: [entry],
      },
    })
    return {
      command,
      args: ["--settings", settings],
      driver: "hook",
      env: {
        YAADE_SESSION_ID: context.sessionId,
        YAADE_INGEST_URL: url,
        YAADE_PROVIDER: cliProvider,
      },
    }
  }
  if (cliProvider === "codex") {
    const script =
      'curl --silent --show-error --max-time 5 --request POST --header "content-type: application/json" --data-binary "$1" "$0" >/dev/null'
    return {
      command,
      args: [
        "-c",
        "features.codex_hooks=true",
        "-c",
        `notify=${JSON.stringify(["sh", "-c", script, url])}`,
      ],
      driver: "hook",
      env: {
        YAADE_SESSION_ID: context.sessionId,
        YAADE_INGEST_URL: url,
        YAADE_PROVIDER: cliProvider,
      },
    }
  }
  if (cliProvider === "cursor") {
    return {
      command,
      args: ["--trust"],
      driver: "hook",
      env: {
        YAADE_SESSION_ID: context.sessionId,
        YAADE_INGEST_URL: url,
        YAADE_PROVIDER: cliProvider,
      },
    }
  }
  return {
    command,
    args: [],
    driver: cliProvider === "opencode" ? "plugin" : "osc",
    env: {
      YAADE_SESSION_ID: context.sessionId,
      YAADE_INGEST_URL: url,
      YAADE_PROVIDER: cliProvider,
    },
  }
}
