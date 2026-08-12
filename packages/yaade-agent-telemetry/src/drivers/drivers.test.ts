import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { claudeDriver } from "../drivers/claude.js"
import { codexDriver } from "../drivers/codex.js"
import { cursorDriver } from "../drivers/cursor.js"
import { opencodeDriver } from "../drivers/opencode.js"
import { piDriver } from "../drivers/pi.js"
import type { NativeHookInput } from "../types/driver.js"

function input(
  provider: NativeHookInput["provider"],
  payload: unknown,
): NativeHookInput {
  return {
    payload,
    sessionId: "ghar-sess",
    processId: "pty-1",
    provider,
    receivedAt: "2026-01-01T12:00:00.000Z",
    projectId: "proj",
    cwd: "/tmp/proj",
  }
}

describe("claudeDriver.normalizeHookEvent", () => {
  it("maps SessionStart with native session id", () => {
    const events = claudeDriver.normalizeHookEvent(
      input("claude", {
        hook_event_name: "SessionStart",
        session_id: "claude-abc",
        source: "startup",
      }),
    )
    assert.equal(events.length, 1)
    assert.equal(events[0]?.kind, "session.started")
    assert.equal(events[0]?.nativeSessionId, "claude-abc")
  })

  it("maps prompt to prompt + turn.started", () => {
    const events = claudeDriver.normalizeHookEvent(
      input("claude", {
        hook_event_name: "UserPromptSubmit",
        session_id: "claude-abc",
        prompt_id: "p1",
      }),
    )
    assert.equal(events.map((e) => e.kind).join(","), "prompt.submitted,turn.started")
  })

  it("maps tool lifecycle", () => {
    const start = claudeDriver.normalizeHookEvent(
      input("claude", {
        hook_event_name: "PreToolUse",
        session_id: "s",
        tool_name: "Read",
        tool_use_id: "tu1",
        tool_input: { file_path: "src/a.ts" },
      }),
    )
    assert.ok(start.some((e) => e.kind === "tool.started"))
    assert.ok(start.some((e) => e.kind === "file.touched"))
    const done = claudeDriver.normalizeHookEvent(
      input("claude", {
        hook_event_name: "PostToolUse",
        session_id: "s",
        tool_name: "Read",
        tool_use_id: "tu1",
      }),
    )
    assert.equal(done[0]?.kind, "tool.completed")
    const fail = claudeDriver.normalizeHookEvent(
      input("claude", {
        hook_event_name: "PostToolUseFailure",
        session_id: "s",
        tool_name: "Bash",
        tool_use_id: "tu2",
      }),
    )
    assert.equal(fail[0]?.kind, "tool.failed")
  })

  it("maps permission request and denial", () => {
    const req = claudeDriver.normalizeHookEvent(
      input("claude", {
        hook_event_name: "PermissionRequest",
        session_id: "s",
        tool_name: "Bash",
        permission_id: "perm1",
      }),
    )
    assert.equal(req[0]?.kind, "permission.requested")
    const denied = claudeDriver.normalizeHookEvent(
      input("claude", {
        hook_event_name: "PermissionDenied",
        session_id: "s",
        permission_id: "perm1",
      }),
    )
    assert.equal(denied[0]?.kind, "permission.resolved")
    assert.equal(denied[0]?.permission?.status, "denied")
  })

  it("maps turn completion, subagent, compaction, session end", () => {
    assert.equal(
      claudeDriver.normalizeHookEvent(
        input("claude", { hook_event_name: "Stop", session_id: "s" }),
      )[0]?.kind,
      "turn.completed",
    )
    assert.equal(
      claudeDriver.normalizeHookEvent(
        input("claude", {
          hook_event_name: "SubagentStart",
          session_id: "s",
          agent_id: "a1",
        }),
      )[0]?.kind,
      "subagent.started",
    )
    assert.equal(
      claudeDriver.normalizeHookEvent(
        input("claude", {
          hook_event_name: "SubagentStop",
          session_id: "s",
          agent_id: "a1",
        }),
      )[0]?.kind,
      "subagent.completed",
    )
    assert.equal(
      claudeDriver.normalizeHookEvent(
        input("claude", { hook_event_name: "PreCompact", session_id: "s" }),
      )[0]?.kind,
      "compaction.started",
    )
    assert.equal(
      claudeDriver.normalizeHookEvent(
        input("claude", { hook_event_name: "PostCompact", session_id: "s" }),
      )[0]?.kind,
      "compaction.completed",
    )
    assert.equal(
      claudeDriver.normalizeHookEvent(
        input("claude", { hook_event_name: "SessionEnd", session_id: "s" }),
      )[0]?.kind,
      "session.ended",
    )
  })

  it("installHooks includes SessionStart", async () => {
    const result = await claudeDriver.installHooks({
      sessionId: "s",
      projectRoot: "/tmp",
      ingestUrl: "http://127.0.0.1:4747/api/v1/notifications/ingest?provider=claude&sessionId=s",
      provider: "claude",
      origin: "http://127.0.0.1:4747",
    })
    assert.equal(result.launchArgs[0], "--settings")
    assert.ok(String(result.launchArgs[1]).includes("SessionStart"))
    assert.ok(String(result.launchArgs[1]).includes("PreToolUse"))
  })
})

describe("codexDriver.normalizeHookEvent", () => {
  it("maps session start and native turn id", () => {
    const events = codexDriver.normalizeHookEvent(
      input("codex", {
        hook_event_name: "SessionStart",
        "thread-id": "thr-1",
        source: "startup",
      }),
    )
    assert.equal(events[0]?.kind, "session.started")
    assert.equal(events[0]?.nativeSessionId, "thr-1")

    const prompt = codexDriver.normalizeHookEvent(
      input("codex", {
        hook_event_name: "UserPromptSubmit",
        "thread-id": "thr-1",
        "turn-id": "turn-9",
      }),
    )
    assert.ok(prompt.some((e) => e.kind === "turn.started"))
    assert.equal(
      prompt.find((e) => e.kind === "turn.started")?.turn?.nativeId,
      "turn-9",
    )
  })

  it("maps tool, permission, stop, subagent, compaction", () => {
    assert.equal(
      codexDriver.normalizeHookEvent(
        input("codex", {
          hook_event_name: "PreToolUse",
          "thread-id": "t",
          tool_name: "Bash",
          tool_call_id: "c1",
        }),
      )[0]?.kind,
      "tool.started",
    )
    assert.equal(
      codexDriver.normalizeHookEvent(
        input("codex", {
          hook_event_name: "PermissionRequest",
          "thread-id": "t",
          id: "p1",
        }),
      )[0]?.kind,
      "permission.requested",
    )
    assert.equal(
      codexDriver.normalizeHookEvent(
        input("codex", {
          "thread-id": "t",
          "turn-id": "turn-1",
          "last-assistant-message": "done",
        }),
      )[0]?.kind,
      "turn.completed",
    )
    assert.equal(
      codexDriver.normalizeHookEvent(
        input("codex", {
          hook_event_name: "SubagentStart",
          "thread-id": "t",
          agent_id: "a",
        }),
      )[0]?.kind,
      "subagent.started",
    )
    assert.equal(
      codexDriver.normalizeHookEvent(
        input("codex", {
          hook_event_name: "PostCompact",
          "thread-id": "t",
        }),
      )[0]?.kind,
      "compaction.completed",
    )
  })

  it("reports Bash-oriented fileEvents unsupported", () => {
    assert.equal(codexDriver.getCapabilities().fileEvents, "unsupported")
  })
})

describe("cursorDriver.normalizeHookEvent", () => {
  it("attaches prompt text for session title derivation", () => {
    const events = cursorDriver.normalizeHookEvent(
      input("cursor", {
        hook_event_name: "beforeSubmitPrompt",
        conversation_id: "c1",
        prompt: "Fix the sidebar title for Cursor",
      }),
    )
    const submitted = events.find(e => e.kind === "prompt.submitted")
    assert.equal(
      submitted?.metadata?.prompt,
      "Fix the sidebar title for Cursor",
    )
  })

  it("maps supported lifecycle and file edit", () => {
    assert.equal(
      cursorDriver.normalizeHookEvent(
        input("cursor", {
          hook_event_name: "sessionStart",
          session_id: "c1",
        }),
      )[0]?.kind,
      "session.started",
    )
    assert.equal(
      cursorDriver.normalizeHookEvent(
        input("cursor", {
          hook_event_name: "stop",
          session_id: "c1",
        }),
      )[0]?.kind,
      "turn.completed",
    )
    assert.equal(
      cursorDriver.normalizeHookEvent(
        input("cursor", {
          hook_event_name: "afterFileEdit",
          session_id: "c1",
          file_path: "x.ts",
        }),
      )[0]?.kind,
      "file.touched",
    )
  })

  it("does not invent permissions", () => {
    assert.equal(cursorDriver.getCapabilities().permissions, false)
    assert.equal(cursorDriver.getCapabilities().subagents, false)
    const events = cursorDriver.normalizeHookEvent(
      input("cursor", {
        hook_event_name: "PermissionRequest",
        session_id: "c1",
      }),
    )
    assert.equal(events.length, 0)
  })
})

describe("piDriver", () => {
  it("reports process-only capabilities and does not invent telemetry", async () => {
    assert.equal(piDriver.getCapabilities().sessionLifecycle, false)
    assert.deepEqual(
      piDriver.normalizeHookEvent(
        input("pi", { type: "session.started", session_id: "pi-1" }),
      ),
      [],
    )
    const install = await piDriver.installHooks({
      sessionId: "s",
      projectRoot: "/tmp",
      ingestUrl: "http://127.0.0.1:4747/api/v1/notifications/ingest?provider=pi&sessionId=s",
      provider: "pi",
      origin: "http://127.0.0.1:4747",
    })
    assert.equal(install.driver, "osc")
    assert.equal(install.env.YAADE_PROVIDER, "pi")
  })
})

describe("opencodeDriver.normalizeHookEvent", () => {
  it("maps session/tool/permission/file/child", () => {
    assert.equal(
      opencodeDriver.normalizeHookEvent(
        input("opencode", {
          event: { type: "session.created", properties: { sessionID: "ses_1" } },
        }),
      )[0]?.kind,
      "session.started",
    )
    assert.equal(
      opencodeDriver.normalizeHookEvent(
        input("opencode", {
          event: { type: "session.idle", properties: { sessionID: "ses_1" } },
        }),
      )[0]?.kind,
      "turn.completed",
    )
    assert.equal(
      opencodeDriver.normalizeHookEvent(
        input("opencode", {
          event: {
            type: "session.error",
            properties: { sessionID: "ses_1" },
          },
        }),
      )[0]?.kind,
      "turn.failed",
    )
    assert.equal(
      opencodeDriver.normalizeHookEvent(
        input("opencode", {
          event: {
            type: "tool.execute.before",
            properties: { sessionID: "ses_1", tool: "bash", callID: "c1" },
          },
        }),
      )[0]?.kind,
      "tool.started",
    )
    assert.equal(
      opencodeDriver.normalizeHookEvent(
        input("opencode", {
          event: {
            type: "permission.asked",
            properties: { sessionID: "ses_1", id: "p1", tool: "bash" },
          },
        }),
      )[0]?.kind,
      "permission.requested",
    )
    assert.equal(
      opencodeDriver.normalizeHookEvent(
        input("opencode", {
          event: {
            type: "permission.replied",
            properties: { sessionID: "ses_1", id: "p1", reply: "allow" },
          },
        }),
      )[0]?.permission?.status,
      "allowed",
    )
    assert.equal(
      opencodeDriver.normalizeHookEvent(
        input("opencode", {
          event: {
            type: "file.edited",
            properties: { sessionID: "ses_1", file: "a.ts" },
          },
        }),
      )[0]?.kind,
      "file.touched",
    )
    const child = opencodeDriver.normalizeHookEvent(
      input("opencode", {
        event: {
          type: "session.created",
          properties: { sessionID: "ses_child", parentID: "ses_1" },
        },
      }),
    )
    assert.ok(child.some((e) => e.kind === "subagent.started"))
    assert.equal(
      opencodeDriver.normalizeHookEvent(
        input("opencode", {
          event: {
            type: "session.compacted",
            properties: { sessionID: "ses_1" },
          },
        }),
      )[0]?.kind,
      "compaction.completed",
    )
  })
})
