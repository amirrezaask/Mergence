import { toSocket, WebSocketMessageReader, WebSocketMessageWriter } from "vscode-ws-jsonrpc"
import type { MessageReader, MessageWriter } from "vscode-jsonrpc/browser.js"

export function resolveLspWebSocketUrl(transportUrl: string): string {
  if (/^wss?:\/\//i.test(transportUrl)) return transportUrl
  if (typeof window === "undefined") {
    throw new Error("Relative LSP WebSocket URLs require a browser environment")
  }
  const path = transportUrl.startsWith("/") ? transportUrl : `/${transportUrl}`
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
  return `${protocol}//${window.location.host}${path}`
}

export type WebSocketTransports = {
  webSocket: WebSocket
  reader: MessageReader
  writer: MessageWriter
}

export const LSP_WEBSOCKET_CONNECT_TIMEOUT_MS = 10_000

export async function createWebSocketTransports(
  transportUrl: string,
  timeoutMs = LSP_WEBSOCKET_CONNECT_TIMEOUT_MS,
): Promise<WebSocketTransports> {
  const url = resolveLspWebSocketUrl(transportUrl)
  const webSocket = await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url)
    let settled = false
    const finish = (result: { socket: WebSocket } | { error: Error }) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      socket.removeEventListener("open", onOpen)
      socket.removeEventListener("error", onError)
      socket.removeEventListener("close", onClose)
      if ("error" in result) {
        try {
          socket.close()
        } catch {
          /* already closed */
        }
        reject(result.error)
      } else {
        resolve(result.socket)
      }
    }
    const onOpen = () => finish({ socket })
    const onError = () => finish({ error: new Error(`WebSocket failed: ${url}`) })
    const onClose = () => finish({ error: new Error(`WebSocket closed before connecting: ${url}`) })
    const timer = window.setTimeout(
      () => finish({ error: new Error(`WebSocket connection timed out: ${url}`) }),
      timeoutMs,
    )
    socket.addEventListener("open", onOpen)
    socket.addEventListener("error", onError)
    socket.addEventListener("close", onClose)
  })
  const socket = toSocket(webSocket)
  return {
    webSocket,
    reader: new WebSocketMessageReader(socket),
    writer: new WebSocketMessageWriter(socket),
  }
}
