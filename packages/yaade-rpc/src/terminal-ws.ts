/**
 * Hot-path terminal WebSocket framing.
 *
 * Outbound `terminal:data` uses a compact binary frame so flood paths avoid
 * JSON.stringify of multi-KiB PTY payloads. Client→host control (write/ack/
 * resize/ready) stays JSON — payloads are tiny.
 */

/** Host → client: binary `terminal:data` frame type byte. */
export const TERMINAL_DATA_FRAME_TYPE = 0x01 as const

type Utf8Encoder = { encode(input: string): Uint8Array }
type Utf8Decoder = { decode(input: Uint8Array): string }

function utf8Encode(text: string): Uint8Array {
  const Encoder = (
    globalThis as { TextEncoder?: new () => Utf8Encoder }
  ).TextEncoder
  if (!Encoder) throw new Error("TextEncoder unavailable")
  return new Encoder().encode(text)
}

function utf8Decode(bytes: Uint8Array): string {
  const Decoder = (
    globalThis as { TextDecoder?: new () => Utf8Decoder }
  ).TextDecoder
  if (!Decoder) throw new Error("TextDecoder unavailable")
  return new Decoder().decode(bytes)
}

/**
 * Binary layout (big-endian):
 *   u8  type (= TERMINAL_DATA_FRAME_TYPE)
 *   u32 eventSequence   (EventHub sequence for reconnect / since=)
 *   u32 terminalSequence (PTY entry sequence for attach dedupe)
 *   u16 idLen
 *   id bytes (utf8)
 *   data bytes (utf8, remainder)
 */
export function encodeTerminalDataFrame(
  eventSequence: number,
  terminalSequence: number,
  id: string,
  data: string,
): Uint8Array {
  const idBytes = utf8Encode(id)
  const dataBytes = utf8Encode(data)
  if (idBytes.length > 0xffff) {
    throw new Error("terminal id too long for binary frame")
  }
  const out = new Uint8Array(1 + 4 + 4 + 2 + idBytes.length + dataBytes.length)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  out[0] = TERMINAL_DATA_FRAME_TYPE
  view.setUint32(1, eventSequence >>> 0)
  view.setUint32(5, terminalSequence >>> 0)
  view.setUint16(9, idBytes.length)
  out.set(idBytes, 11)
  out.set(dataBytes, 11 + idBytes.length)
  return out
}

export type DecodedTerminalDataFrame = {
  eventSequence: number
  terminalSequence: number
  id: string
  data: string
}

export function decodeTerminalDataFrame(
  bytes: ArrayBuffer | ArrayBufferView,
): DecodedTerminalDataFrame | null {
  const buf =
    bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (buf.length < 11 || buf[0] !== TERMINAL_DATA_FRAME_TYPE) return null
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const eventSequence = view.getUint32(1)
  const terminalSequence = view.getUint32(5)
  const idLen = view.getUint16(9)
  if (11 + idLen > buf.length) return null
  const id = utf8Decode(buf.subarray(11, 11 + idLen))
  const data = utf8Decode(buf.subarray(11 + idLen))
  return { eventSequence, terminalSequence, id, data }
}

/** Client → host control ops over the event WebSocket (JSON text frames). */
export const TERMINAL_WS_HOT_OPS = [
  "terminal:write",
  "terminal:writeBinary",
  "terminal:ack",
  "terminal:resize",
  "terminal:ready",
] as const

export type TerminalWsHotOp = (typeof TERMINAL_WS_HOT_OPS)[number]

export type TerminalWsCommand = {
  op: TerminalWsHotOp
  args: unknown[]
}

export function isTerminalWsHotOp(value: unknown): value is TerminalWsHotOp {
  return (
    value === "terminal:write" ||
    value === "terminal:writeBinary" ||
    value === "terminal:ack" ||
    value === "terminal:resize" ||
    value === "terminal:ready"
  )
}

export function encodeTerminalWsCommand(op: TerminalWsHotOp, args: unknown[]): string {
  const cmd: TerminalWsCommand = { op, args }
  return JSON.stringify(cmd)
}

export function tryDecodeTerminalWsCommand(raw: unknown): TerminalWsCommand | null {
  if (raw === null || typeof raw !== "object") return null
  const obj = raw as Record<string, unknown>
  if (!isTerminalWsHotOp(obj.op) || !Array.isArray(obj.args)) return null
  return { op: obj.op, args: obj.args }
}
