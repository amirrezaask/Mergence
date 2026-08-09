#!/usr/bin/env tsx
/**
 * Deterministic newline-delimited JSON-RPC peer standing in for the Codex
 * app-server during tests.
 *
 * TypeScript port of the Rust `yaade-mock-line-rpc` binary
 * (apps/server/src/bin/yaade-mock_line_rpc.rs). Message shapes and control
 * flow are preserved so E2E specs observe identical behavior.
 *
 * Usage: tsx apps/host-server/mocks/mock-line-rpc.ts
 */

type JsonValue = unknown
type JsonObject = Record<string, JsonValue>

type PendingKind = "permission" | "wait"
type PendingTurn = { threadId: string; turnId: string; kind: PendingKind }

function write(message: JsonObject): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
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
  let heldResponse: { id: JsonValue; params: JsonValue } | null = null
  let pendingCodexTurn: PendingTurn | null = null
  let turnCount = 0
  let stopped = false

  const handle = async (line: string): Promise<void> => {
    let message: JsonObject
    try {
      message = JSON.parse(line) as JsonObject
    } catch {
      // The Rust binary aborts on unparsable input; mirror that failure mode.
      process.stderr.write("yaade-mock-line-rpc: invalid JSON line\n")
      process.exit(1)
      return
    }

    const method = asString(message.method)
    if (method === undefined) {
      if (asString(message.id) === "mock-codex-permission") {
        const pending = pendingCodexTurn
        if (pending && pending.kind === "permission") {
          pendingCodexTurn = null
          const decision = asString(pointer(message, ["result", "decision"])) ?? "missing"
          write({
            method: "item/agentMessage/delta",
            params: {
              threadId: pending.threadId,
              turnId: pending.turnId,
              itemId: "mock-message",
              delta: `permission ${decision}`,
            },
          })
          write({
            method: "turn/completed",
            params: {
              threadId: pending.threadId,
              turn: { id: pending.turnId, status: "completed" },
            },
          })
        }
      }
      return
    }

    const id = message.id
    const hasId = id !== undefined
    const params = (message.params ?? null) as JsonValue
    const paramsObject = (params && typeof params === "object" ? params : {}) as JsonObject

    switch (method) {
      case "initialize": {
        if (hasId) {
          write({
            id,
            result: {
              userAgent: "yaade-mock-line-rpc",
              codexHome: "/tmp/mock-codex-home",
              platformFamily: "unix",
              platformOs: "test",
            },
          })
        }
        break
      }

      case "initialized": {
        write({
          method: "mock/initialized",
          params: { receivedParams: message.params !== undefined },
        })
        break
      }

      case "thread/start":
      case "thread/resume": {
        if (hasId) {
          const threadId = asString(paramsObject.threadId) ?? "mock-codex-thread"
          write({
            id,
            result: {
              thread: { id: threadId },
              model: "mock-model",
              modelProvider: "mock",
            },
          })
        }
        break
      }

      case "model/list": {
        if (hasId) {
          const cursor = asString(paramsObject.cursor)
          if (!cursor) {
            write({
              id,
              result: {
                data: [
                  {
                    id: "mock-model",
                    model: "mock-model",
                    displayName: "Mock Model",
                    isDefault: true,
                    hidden: false,
                  },
                  {
                    id: "mock-model-fast",
                    model: "mock-model-fast",
                    displayName: "Mock Fast",
                    isDefault: false,
                    hidden: false,
                  },
                ],
                nextCursor: "page-2",
              },
            })
          } else {
            write({
              id,
              result: {
                data: [
                  {
                    id: "mock-model-deep",
                    model: "mock-model-deep",
                    displayName: "Mock Deep",
                    isDefault: false,
                    hidden: false,
                  },
                ],
                nextCursor: null,
              },
            })
          }
        }
        break
      }

      case "config/value/write": {
        if (hasId) write({ id, result: {} })
        break
      }

      case "turn/start": {
        if (!hasId) break
        turnCount += 1
        const threadId = asString(paramsObject.threadId) ?? "mock-codex-thread"
        const turnId = `mock-codex-turn-${turnCount}`
        write({ id, result: { turn: { id: turnId, status: "inProgress" } } })

        const input = Array.isArray(paramsObject.input) ? (paramsObject.input as JsonValue[]) : []
        let prompt = ""
        for (const entry of input) {
          const text =
            entry && typeof entry === "object" ? asString((entry as JsonObject).text) : undefined
          if (text !== undefined) {
            prompt = text
            break
          }
        }

        if (prompt === "request permission") {
          pendingCodexTurn = { threadId, turnId, kind: "permission" }
          write({
            id: "mock-codex-permission",
            method: "item/commandExecution/requestApproval",
            params: { threadId, turnId, itemId: "mock-command", reason: "test command" },
          })
          break
        }
        if (prompt === "wait") {
          pendingCodexTurn = { threadId, turnId, kind: "wait" }
          break
        }
        if (prompt === "tool") {
          write({
            method: "item/started",
            params: {
              threadId,
              turnId,
              item: {
                id: "mock-command",
                type: "commandExecution",
                command: ["/bin/echo", "hello"],
                status: "inProgress",
              },
            },
          })
          write({
            method: "item/completed",
            params: {
              threadId,
              turnId,
              item: {
                id: "mock-command",
                type: "commandExecution",
                command: ["/bin/echo", "hello"],
                status: "completed",
                aggregatedOutput: "hello",
              },
            },
          })
        }

        const responseText =
          prompt === "process-count" ? `process-turn:${turnCount}` : `mock:${prompt}`
        write({
          method: "item/agentMessage/delta",
          params: { threadId, turnId, itemId: "mock-message", delta: responseText },
        })
        write({
          method: "thread/tokenUsage/updated",
          params: {
            threadId,
            turnId,
            tokenUsage: {
              last: { totalTokens: 3 },
              total: { totalTokens: turnCount * 3 },
              modelContextWindow: 200000,
            },
          },
        })
        write({
          method: "turn/completed",
          params: { threadId, turn: { id: turnId, status: "completed" } },
        })
        break
      }

      case "turn/interrupt": {
        if (hasId) write({ id, result: {} })
        const pending = pendingCodexTurn
        if (pending) {
          pendingCodexTurn = null
          write({
            method: "turn/completed",
            params: {
              threadId: pending.threadId,
              turn: { id: pending.turnId, status: "interrupted" },
            },
          })
        }
        break
      }

      case "echo": {
        if (hasId) write({ id, result: params })
        break
      }

      case "remote_error": {
        if (hasId) {
          write({
            id,
            error: { code: -32042, message: "mock remote error", data: { retryable: false } },
          })
        }
        break
      }

      case "events": {
        write({ method: "mock/progress", params: { percent: 50 } })
        write({ id: "server-request-1", method: "mock/approve", params: { action: "read" } })
        if (hasId) write({ id, result: { queued: true } })
        break
      }

      case "delay": {
        const delayMs = typeof paramsObject.delayMs === "number" ? paramsObject.delayMs : 100
        await new Promise(resolve => setTimeout(resolve, delayMs))
        if (hasId) write({ id, result: { delayed: true } })
        break
      }

      case "hold": {
        if (hasId) {
          heldResponse = { id, params }
          write({ method: "mock/held", params: {} })
        }
        break
      }

      case "release": {
        if (hasId) write({ id, result: params })
        if (heldResponse) {
          write({ id: heldResponse.id, result: heldResponse.params })
          heldResponse = null
        }
        break
      }

      case "exit":
        stopped = true
        break

      default: {
        if (hasId) write({ id, error: { code: -32601, message: "method not found" } })
        break
      }
    }
  }

  // Lines drain one at a time so blocking handlers (`delay`) preserve the
  // sequential response ordering of the Rust binary.
  const queue: string[] = []
  let draining = false
  const drain = async (): Promise<void> => {
    if (draining) return
    draining = true
    while (!stopped && queue.length > 0) {
      await handle(queue.shift()!)
    }
    draining = false
    if (stopped) process.exit(0)
  }

  let buffer = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", chunk => {
    buffer += String(chunk)
    let index: number
    while ((index = buffer.indexOf("\n")) >= 0) {
      queue.push(buffer.slice(0, index).replace(/\r$/, ""))
      buffer = buffer.slice(index + 1)
    }
    void drain()
  })
  process.stdin.on("end", () => process.exit(0))
}

main()
