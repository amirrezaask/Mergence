import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import WebSocket from "ws"
import { startHostHarness } from "./test-support/host-harness.js"

test("unauthenticated websocket admission is globally bounded", async () => {
  const harness = await startHostHarness({ token: "secret" })
  const sockets: WebSocket[] = []
  let resolveLimited: ((value: { code: number; reason: string }) => void) | undefined
  const limited = new Promise<{ code: number; reason: string }>(resolve => {
    resolveLimited = resolve
  })
  try {
    for (let index = 0; index < 65; index += 1) {
      const socket = harness.connect(`/ws?protocol=2&clientId=pending-${index}`)
      socket.on("close", (code, reason) => {
        if (code === 1013) {
          resolveLimited?.({ code, reason: reason.toString("utf8") })
        }
      })
      sockets.push(socket)
    }
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error("no socket was rejected by the admission limit")),
        3_000,
      )
    })
    const rejected = await Promise.race([limited, timeout])
    if (timeoutHandle) clearTimeout(timeoutHandle)
    assert.deepEqual(rejected, {
      code: 1013,
      reason: "too many unauthenticated connections",
    })
  } finally {
    for (const socket of sockets) socket.terminate()
    await harness.close()
  }
})
