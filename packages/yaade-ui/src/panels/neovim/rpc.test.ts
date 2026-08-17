import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Decoder, Encoder } from "@msgpack/msgpack"
import {
  MAX_PENDING_REQUESTS,
  MAX_RPC_FRAME_BYTES,
  MsgpackRpcClient,
  RpcRemoteError,
} from "./rpc.js"

function decoded(bytes: Uint8Array): unknown {
  return new Decoder().decode(bytes)
}

describe("Neovim Msgpack-RPC", () => {
  it("decodes fragmented and coalesced responses and notifications", async () => {
    const encoder = new Encoder()
    const notifications: string[] = []
    let client: MsgpackRpcClient
    client = new MsgpackRpcClient({
      send: bytes => {
        const request = decoded(bytes)
        if (!Array.isArray(request)) throw new Error("bad request")
        const response = encoder.encode([1, request[1], null, { ok: true }])
        const notification = encoder.encode([2, "redraw", [["flush"]]])
        const combined = new Uint8Array(response.byteLength + notification.byteLength)
        combined.set(response)
        combined.set(notification, response.byteLength)
        client.receive(combined.slice(0, 2))
        client.receive(combined.slice(2))
      },
      onNotification: notification => notifications.push(notification.method),
    })
    const response = await client.request("nvim_get_api_info", [])
    assert.deepEqual(response, { ok: true })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(notifications, ["redraw"])
    client.close()
  })

  it("routes remote errors and replies to server requests", async () => {
    const encoder = new Encoder()
    const sent: unknown[] = []
    const client = new MsgpackRpcClient({
      send: bytes => sent.push(decoded(bytes)),
      onServerRequest: request => ({ method: request.method }),
    })
    const failed = client.request("broken", [])
    const request = sent.shift()
    if (!Array.isArray(request)) throw new Error("missing request")
    client.receive(encoder.encode([1, request[1], [0, "broken"], null]))
    await assert.rejects(failed, RpcRemoteError)
    client.receive(encoder.encode([0, 91, "client_method", []]))
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(sent.at(-1), [1, 91, null, { method: "client_method" }])
    client.close()
  })

  it("bounds pending requests, receive bytes, and request timeouts", async () => {
    const client = new MsgpackRpcClient({ send: () => undefined, requestTimeoutMs: 10 })
    const timedOut = client.request("slow", [])
    await assert.rejects(timedOut, /timed out/)

    const pending = Array.from({ length: MAX_PENDING_REQUESTS }, () => client.request("pending", []))
    await assert.rejects(client.request("overflow", []), /queue is full/)
    client.receive(new Uint8Array(MAX_RPC_FRAME_BYTES + 1))
    const results = await Promise.allSettled(pending)
    assert.equal(results.every(result => result.status === "rejected"), true)
    await assert.rejects(client.request("closed", []), /closed/)
  })

  it("returns an RPC error for an unsupported server request", async () => {
    const encoder = new Encoder()
    const sent: unknown[] = []
    const client = new MsgpackRpcClient({ send: bytes => sent.push(decoded(bytes)) })
    client.receive(encoder.encode([0, 91, "nvim_ui_event", []]))
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(sent, [[1, 91, [0, "Unsupported Neovim server request: nvim_ui_event"], null]])
    client.close()
  })

  it("closes on malformed messages", async () => {
    const errors: string[] = []
    const client = new MsgpackRpcClient({
      send: () => undefined,
      onError: error => errors.push(error.message),
    })
    client.receive(new Encoder().encode([1, 1, null]))
    await client.decoding()
    assert.match(errors.join("\n"), /Malformed Neovim RPC response/)
  })
})
