#!/usr/bin/env tsx
/**
 * Deterministic Claude Agent SDK stream-json peer used by E2E specs.
 *
 * TypeScript port of the Rust `yaade-mock-claude-sdk` binary
 * (apps/server/src/bin/yaade-mock_claude_sdk.rs). Emits the same
 * `control_request` / `control_response` / `stream_event` / `result` envelopes.
 *
 * Usage: tsx packages/yaade-host-server/mocks/mock-claude-sdk.ts
 */

type JsonPrimitive = string | number | boolean | null | undefined
type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
type JsonObject = { [key: string]: JsonValue }

function send(value: JsonObject): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function success(requestId: string, response: JsonValue): void {
  send({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response },
  })
}

function asString(value: JsonValue): string | undefined {
  return typeof value === "string" ? value : undefined
}

function pointer(root: JsonValue, segments: string[]): JsonValue {
  let current = root
  for (const segment of segments) {
    if (current === null || typeof current !== "object") return undefined
    current = (current as JsonObject)[segment]
  }
  return current
}

function main(): void {
  let initialized = false
  let sessionId = "11111111-1111-4111-8111-111111111111"
  let pendingPermission: string | null = null
  let turnCount = 0

  const handle = (line: string): void => {
    let message: JsonObject
    try {
      message = JSON.parse(line) as JsonObject
    } catch {
      return
    }

    switch (asString(message.type)) {
      case "control_request": {
        const requestId = asString(message.request_id) ?? "missing"
        const request = (message.request ?? null) as JsonValue
        const subtype =
          request && typeof request === "object"
            ? asString((request as JsonObject).subtype)
            : undefined
        switch (subtype) {
          case "initialize":
            initialized = true
            success(requestId, {
              commands: [{ name: "compact", description: "Compact context" }],
              models: [
                { value: "mock-haiku", displayName: "Mock Haiku" },
                { value: "mock-sonnet", displayName: "Mock Sonnet" },
                { value: "mock-opus", displayName: "Mock Opus" },
              ],
              model: "mock-sonnet",
              account: { email: "mock@example.com" },
            })
            break
          case "interrupt":
            success(requestId, {})
            send({
              type: "result",
              subtype: "error_during_execution",
              duration_ms: 1,
              duration_api_ms: 0,
              is_error: false,
              num_turns: 1,
              session_id: sessionId,
              errors: ["Interrupted by user"],
            })
            break
          case "set_permission_mode":
          case "set_model":
            success(requestId, {})
            break
          case "hold":
            pendingPermission = requestId
            break
          case "release": {
            success(requestId, { released: true })
            if (pendingPermission) {
              const held = pendingPermission
              pendingPermission = null
              success(held, { held: true })
            }
            break
          }
          case undefined:
            break
          default:
            send({
              type: "control_response",
              response: {
                subtype: "error",
                request_id: requestId,
                error: `unsupported control request: ${subtype}`,
              },
            })
            break
        }
        break
      }

      case "control_response": {
        const decision =
          asString(pointer(message, ["response", "response", "behavior"])) ?? "missing"
        send({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: `permission:${decision}` }],
          },
          session_id: sessionId,
        })
        send({
          type: "result",
          subtype: "success",
          duration_ms: 2,
          duration_api_ms: 1,
          is_error: false,
          num_turns: 1,
          session_id: sessionId,
          result: `permission:${decision}`,
          usage: { input_tokens: 2, output_tokens: 1 },
          total_cost_usd: 0.001,
        })
        break
      }

      case "user": {
        if (!initialized) break
        turnCount += 1
        const requested = asString(message.session_id)
        if (requested !== undefined && requested !== "default" && requested !== "") {
          sessionId = requested
        }
        const content = pointer(message, ["message", "content"])
        let text = ""
        const direct = asString(content)
        if (direct !== undefined) {
          text = direct
        } else if (Array.isArray(content)) {
          for (const block of content as JsonValue[]) {
            const blockText =
              block && typeof block === "object" ? asString((block as JsonObject).text) : undefined
            if (blockText !== undefined) {
              text = blockText
              break
            }
          }
        }

        send({
          type: "system",
          subtype: "init",
          session_id: sessionId,
          model: "mock-sonnet",
          permissionMode: "default",
          models: [
            { value: "mock-haiku", displayName: "Mock Haiku" },
            { value: "mock-sonnet", displayName: "Mock Sonnet" },
            { value: "mock-opus", displayName: "Mock Opus" },
          ],
          tools: ["Read", "Edit", "Bash"],
        })

        if (text === "permission") {
          send({
            type: "control_request",
            request_id: "permission-1",
            request: {
              subtype: "can_use_tool",
              tool_name: "Bash",
              input: { command: "echo hello" },
              tool_use_id: "tool-1",
              permission_suggestions: [
                {
                  type: "addRules",
                  rules: [{ toolName: "Bash", ruleContent: "echo:*" }],
                  behavior: "allow",
                  destination: "session",
                },
              ],
              title: "Claude wants to run a command",
              display_name: "Run command",
              description: "echo hello",
            },
          })
          break
        }
        if (text === "wait") break

        const responseText =
          text === "process-count" ? `process-turn:${turnCount}` : `mock:${text}`
        send({
          type: "stream_event",
          uuid: "assistant-1",
          session_id: sessionId,
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
        })
        send({
          type: "stream_event",
          uuid: "assistant-1",
          session_id: sessionId,
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: responseText },
          },
        })
        send({
          type: "stream_event",
          uuid: "assistant-1",
          session_id: sessionId,
          event: { type: "content_block_stop", index: 0 },
        })
        send({
          type: "assistant",
          uuid: "assistant-1",
          message: {
            role: "assistant",
            content: [{ type: "text", text: responseText }],
          },
          session_id: sessionId,
        })
        send({
          type: "result",
          subtype: "success",
          duration_ms: 2,
          duration_api_ms: 1,
          is_error: false,
          num_turns: 1,
          session_id: sessionId,
          result: responseText,
          usage: { input_tokens: 2, output_tokens: 1 },
          modelUsage: {
            "mock-sonnet": {
              inputTokens: 2,
              outputTokens: 1,
              contextWindow: 200000,
              costUSD: 0.001,
            },
          },
          total_cost_usd: 0.001,
        })
        break
      }

      default:
        break
    }
  }

  let buffer = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", chunk => {
    buffer += String(chunk)
    let index: number
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "")
      buffer = buffer.slice(index + 1)
      handle(line)
    }
  })
  process.stdin.on("end", () => {
    if (buffer.trim()) handle(buffer)
    process.exit(0)
  })
}

main()
