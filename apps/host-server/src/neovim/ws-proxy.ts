import { Schema } from "effect"
import { WebSocket, type RawData } from "ws"
import { ToolUseId } from "@yaade/rpc"
import type { HostRuntime } from "../host-runtime.js"
import type { NeovimUiLease } from "./host.js"

export const MAX_NEOVIM_MESSAGE_BYTES = 2 * 1024 * 1024

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  return Buffer.from(data)
}

function closeSocket(ws: WebSocket, code: number, reason: string): void {
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    ws.close(code, reason)
  }
}

/** Binary-only bridge between one browser UI lease and one Neovim socket. */
export async function handleNeovimSocket(
  runtime: HostRuntime,
  ws: WebSocket,
  toolUseIdValue: string,
  generation: number,
): Promise<void> {
  let toolUseId: ToolUseId
  try {
    toolUseId = Schema.decodeUnknownSync(ToolUseId)(toolUseIdValue)
  } catch {
    closeSocket(ws, 1008, "invalid ToolUse id")
    return
  }
  const use = runtime.toolSessions.getToolUse(toolUseId)
  if (
    !use ||
    use.kind !== "neovim" ||
    use.archivedAt ||
    use.output.kind !== "neovim" ||
    use.output.generation !== generation ||
    use.status === "failed" ||
    use.status === "cancelled" ||
    use.status === "disconnected"
  ) {
    closeSocket(ws, 1008, "stale or unavailable Neovim runtime")
    return
  }

  let lease: NeovimUiLease | undefined
  try {
    lease = await runtime.neovim.acquireUi(toolUseId, generation)
  } catch {
    closeSocket(ws, 1013, "Neovim server is not ready")
    return
  }
  const socket = lease.socket
  if (ws.readyState !== WebSocket.OPEN) {
    lease.release()
    return
  }
  let closed = false
  const close = (code?: number, reason?: string) => {
    if (closed) return
    closed = true
    lease?.release()
    if (code !== undefined) closeSocket(ws, code, reason ?? "Neovim channel closed")
    else if (ws.readyState !== WebSocket.CLOSED) ws.close()
    socket.destroy()
  }

  socket.on("data", chunk => {
    if (closed) return
    if (chunk.length > MAX_NEOVIM_MESSAGE_BYTES || ws.bufferedAmount + chunk.length > MAX_NEOVIM_MESSAGE_BYTES) {
      close(1013, "Neovim channel backpressure limit")
      return
    }
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(chunk, { binary: true }, error => {
          if (error) close(1013, "Neovim WebSocket write failed")
        })
      }
    } catch {
      close()
    }
  })
  socket.once("end", () => close())
  socket.once("close", () => close())
  socket.once("error", () => close(1013, "Neovim socket error"))
  ws.on("message", (data, isBinary) => {
    if (closed) return
    if (!isBinary) {
      close(1003, "Neovim channel requires binary messages")
      return
    }
    const bytes = rawDataToBuffer(data)
    if (bytes.length > MAX_NEOVIM_MESSAGE_BYTES || socket.writableLength + bytes.length > MAX_NEOVIM_MESSAGE_BYTES) {
      close(1013, "Neovim channel backpressure limit")
      return
    }
    if (!socket.write(bytes)) {
      if (socket.writableLength > MAX_NEOVIM_MESSAGE_BYTES) {
        close(1013, "Neovim channel backpressure limit")
      }
    }
  })
  ws.once("close", () => close())
  ws.once("error", () => close())
}
