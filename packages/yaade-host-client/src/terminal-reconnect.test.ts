import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import type { YaadeHostTransport } from "./transport.js"
import { createYaadeApi } from "./create-yaade-api.js"

type AttachResult = {
  id: string
  outputChunks: string[]
  output: string
  lastSequence: number
  replayNeedsQueryResponses?: boolean
  replayTruncated?: boolean
  status: "running"
}

class FakeTransport implements YaadeHostTransport {
  readonly calls: Array<{ channel: string; args: unknown[]; via: "http" | "realtime" }> = []
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  private readonly attachResults: AttachResult[] = []

  queueAttach(result: AttachResult): void {
    this.attachResults.push(result)
  }

  emit(channel: string, ...args: unknown[]): void {
    this.listeners.get(channel)?.forEach(listener => listener(...args))
  }

  private shiftAttach<T>(): T {
    const result = this.attachResults.shift()
    if (!result) throw new Error("missing attach result")
    return result as T
  }

  async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    this.calls.push({ channel, args, via: "http" })
    if (channel !== "terminal:attach") throw new Error(`unexpected ${channel}`)
    return this.shiftAttach()
  }

  invokeRealtime<T>(channel: string, ...args: unknown[]): Promise<T> | null {
    this.calls.push({ channel, args, via: "realtime" })
    if (channel !== "terminal:attach") throw new Error(`unexpected ${channel}`)
    return Promise.resolve(this.shiftAttach())
  }

  on(channel: string, listener: (...args: unknown[]) => void): () => void {
    const listeners = this.listeners.get(channel) ?? new Set()
    listeners.add(listener)
    this.listeners.set(channel, listeners)
    return () => listeners.delete(listener)
  }
}

test("reconnect delta-replays mounted terminals before buffered live data", async () => {
  const transport = new FakeTransport()
  transport.queueAttach({
    id: "pty-1",
    outputChunks: ["initial"],
    output: "",
    lastSequence: 2,
    status: "running",
  })
  const api = createYaadeApi(transport)
  const terminal = api.terminal
  assert.ok(terminal)
  transport.emit("connection:status", "connected")
  await terminal.attach("pty-1")

  const output: string[] = []
  const replayFlags: boolean[] = []
  const replayQueryFlags: boolean[] = []
  const replayTruncatedFlags: boolean[] = []
  terminal.onData(
    "pty-1",
    (data, replay, replayNeedsQueryResponses, replayTruncated) => {
      output.push(data)
      replayFlags.push(replay === true)
      replayQueryFlags.push(replayNeedsQueryResponses === true)
      replayTruncatedFlags.push(replayTruncated === true)
    },
  )
  transport.emit("terminal:data", "pty-1", "live-3", 3)
  transport.emit("connection:status", "disconnected")

  transport.queueAttach({
    id: "pty-1",
    outputChunks: ["replay-4"],
    output: "",
    lastSequence: 4,
    replayNeedsQueryResponses: true,
    replayTruncated: true,
    status: "running",
  })
  transport.emit("connection:status", "connected")
  transport.emit("terminal:data", "pty-1", "live-5", 5)
  await new Promise<void>(resolve => setImmediate(resolve))

  assert.deepEqual(output, ["live-3", "replay-4", "live-5"])
  assert.deepEqual(replayFlags, [false, true, false])
  assert.deepEqual(replayQueryFlags, [false, true, false])
  assert.deepEqual(replayTruncatedFlags, [false, true, false])
  assert.deepEqual(transport.calls.at(-1), {
    channel: "terminal:attach",
    args: ["pty-1", 3],
    via: "realtime",
  })
})
