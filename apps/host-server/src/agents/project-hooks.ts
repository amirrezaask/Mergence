import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import type { AgentProvider } from "@yaade/agent-telemetry"

function atomicWrite(file: string, content: string, mode?: number): void {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(temporary, content, { encoding: "utf8", ...(mode ? { mode } : {}) })
  fs.renameSync(temporary, file)
}

function readJsonObject(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {}
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} must contain a JSON object`)
  }
  return parsed as Record<string, unknown>
}

/** Shared forwarder script invoked by Codex/Cursor project hooks. */
export function ensureHookForwarderScript(dataDir?: string): string {
  const root =
    dataDir ??
    process.env.JET_DATA_DIR ??
    path.join(os.homedir(), ".local", "share", "jet")
  const binDir = path.join(root, "bin")
  fs.mkdirSync(binDir, { recursive: true })
  const scriptPath = path.join(binDir, "yaade-hook-forward.sh")
  const script = `#!/bin/sh
# Yaade ADE hook forwarder — fire-and-forget; never block Cursor/Codex.
# Sync curl here made the IDE unusable (every tool/edit waited up to 5s).
set -eu
PROVIDER="\${YAADE_PROVIDER:-}"
SESSION_ID="\${YAADE_SESSION_ID:-}"
INGEST_URL="\${YAADE_INGEST_URL:-}"
QUEUE_DIR="\${YAADE_HOOK_QUEUE:-$HOME/.local/share/jet/hook-queue}"
# Drain stdin immediately so the provider can continue.
PAYLOAD="$(cat)"
if [ -z "$INGEST_URL" ] || [ -z "$PROVIDER" ] || [ -z "$SESSION_ID" ]; then
  exit 0
fi
BODY="$PAYLOAD"
(
  CODE=0
  curl --silent --show-error --max-time 2 --request POST \\
    --header "content-type: application/json" \\
    --data-binary "$BODY" \\
    "$INGEST_URL" >/dev/null || CODE=$?
  if [ "$CODE" -ne 0 ]; then
    mkdir -p "$QUEUE_DIR"
    TS="$(date +%s)"
    RAND="$(awk 'BEGIN{srand(); print int(rand()*100000)}')"
    printf '%s\\n' "{\\"meta\\":{\\"provider\\":\\"$PROVIDER\\",\\"sessionId\\":\\"$SESSION_ID\\",\\"ingestUrl\\":\\"$INGEST_URL\\"},\\"payload\\":$BODY}" \\
      > "$QUEUE_DIR/\${TS}-\${RAND}.json" || true
  fi
) >/dev/null 2>&1 &
exit 0
`
  atomicWrite(scriptPath, script, 0o755)
  return scriptPath
}

function mergeHookCommand(
  existing: unknown,
  forwarder: string,
): unknown[] {
  const list = Array.isArray(existing) ? [...existing] : []
  const already = list.some((entry) => {
    if (!entry || typeof entry !== "object") return false
    const cmd = (entry as { command?: string }).command
    return typeof cmd === "string" && cmd.includes("yaade-hook-forward")
  })
  if (!already) {
    list.push({ command: forwarder })
  }
  return list
}

/** Idempotent merge of Yaade forwarder into project `.codex/hooks.json`. */
export function installCodexProjectHooks(
  projectRoot: string,
  dataDir?: string,
): string {
  const forwarder = ensureHookForwarderScript(dataDir)
  const dir = path.join(projectRoot, ".codex")
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "hooks.json")
  const current = readJsonObject(file)
  const currentHooks = current.hooks
  if (currentHooks != null && (typeof currentHooks !== "object" || Array.isArray(currentHooks))) {
    throw new Error(`${file} hooks must be an object`)
  }
  const hooks = { ...((currentHooks as Record<string, unknown> | undefined) ?? {}) }
  const events = [
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
    "Stop",
  ]
  for (const ev of events) {
    const groups = Array.isArray(hooks[ev]) ? [...(hooks[ev] as unknown[])] : []
    const withoutYaade = groups.filter(group => {
      if (!group || typeof group !== "object") return true
      const commands = (group as { hooks?: unknown }).hooks
      return !Array.isArray(commands) || !commands.some(command =>
        command && typeof command === "object" &&
        typeof (command as { command?: unknown }).command === "string" &&
        (command as { command: string }).command.includes("yaade-hook-forward"),
      )
    })
    hooks[ev] = [...withoutYaade, { hooks: [{ command: forwarder }] }]
  }
  atomicWrite(file, JSON.stringify({ ...current, hooks }, null, 2))
  return file
}

/** Idempotent merge into project `.cursor/hooks.json`. */
export function installCursorProjectHooks(
  projectRoot: string,
  dataDir?: string,
): string {
  const forwarder = ensureHookForwarderScript(dataDir)
  const dir = path.join(projectRoot, ".cursor")
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "hooks.json")
  const current = readJsonObject(file)
  const currentHooks = current.hooks
  if (currentHooks != null && (typeof currentHooks !== "object" || Array.isArray(currentHooks))) {
    throw new Error(`${file} hooks must be an object`)
  }
  const hooks = { ...((currentHooks as Record<string, unknown[]> | undefined) ?? {}) }
  // High-signal only. afterFileEdit / shell hooks fire constantly and made
  // Cursor IDE unusable when this file is present in the project.
  const events = [
    "sessionStart",
    "sessionEnd",
    "beforeSubmitPrompt",
    "preToolUse",
    "postToolUse",
    "postToolUseFailure",
    "preCompact",
    "stop",
  ]
  const dropSpam = [
    "beforeShellExecution",
    "afterShellExecution",
    "afterFileEdit",
  ]
  for (const ev of dropSpam) {
    if (!Array.isArray(hooks[ev])) continue
    hooks[ev] = (hooks[ev] as unknown[]).filter(entry => {
      if (!entry || typeof entry !== "object") return true
      const cmd = (entry as { command?: string }).command
      return !(typeof cmd === "string" && cmd.includes("yaade-hook-forward"))
    })
    if ((hooks[ev] as unknown[]).length === 0) delete hooks[ev]
  }
  for (const ev of events) {
    hooks[ev] = mergeHookCommand(hooks[ev], forwarder) as unknown[]
  }
  atomicWrite(file, JSON.stringify({ ...current, version: 1, hooks }, null, 2))
  return file
}

/** Write OpenCode project plugin that POSTs events quickly. */
export function installOpenCodePlugin(
  projectRoot: string,
  _dataDir?: string,
): string {
  const dir = path.join(projectRoot, ".opencode", "plugin")
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "yaade-telemetry.js")
  const source = `// @yaade-telemetry-plugin v1
// Yaade ADE telemetry plugin — fire-and-forget, never block OpenCode.
export const YaadeTelemetry = async () => {
  return {
    event: async ({ event }) => {
      const url = process.env.YAADE_INGEST_URL
      if (!url) return
      const body = JSON.stringify({ event })
      // Do not await — OpenCode must not stall on Yaade availability.
      void fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(2000),
      }).catch(() => {})
    },
  }
}
`
  atomicWrite(file, source)
  return file
}

export function installProjectHooksForProvider(
  provider: AgentProvider,
  projectRoot: string,
  dataDir?: string,
): string[] {
  switch (provider) {
    case "codex":
      return [installCodexProjectHooks(projectRoot, dataDir)]
    case "cursor":
      return [installCursorProjectHooks(projectRoot, dataDir)]
    case "opencode":
      return [installOpenCodePlugin(projectRoot, dataDir)]
    default:
      return []
  }
}
