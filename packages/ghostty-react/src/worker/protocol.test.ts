import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import {
  GHOSTTY_RENDER_UPDATE_VERSION,
  type GhosttyRenderUpdate,
} from "../core.js"
import {
  TERMINAL_WORKER_PROTOCOL_VERSION,
  terminalRenderUpdateTransferList,
  validateTerminalWorkerCommand,
  validateTerminalWorkerEvent,
} from "./protocol.js"

const envelope = {
  version: TERMINAL_WORKER_PROTOCOL_VERSION,
  terminalId: "terminal-1",
  sequence: 1,
  generation: 1,
} as const

function packedUpdate(): GhosttyRenderUpdate {
  return {
    version: GHOSTTY_RENDER_UPDATE_VERSION,
    frameId: 1,
    generation: 1,
    cols: 1,
    rows: 1,
    full: true,
    foreground: 0xffffff,
    background: 0,
    cursor: 0xffffff,
    cursorX: 0,
    cursorY: 0,
    cursorVisible: true,
    cursorBlinking: false,
    cursorStyle: 1,
    dirtyRows: new Uint32Array([0]),
    rowFlags: new Uint8Array([0]),
    graphemeOffsets: new Uint32Array([0]),
    graphemeLengths: new Uint32Array([1]),
    foregrounds: new Uint32Array([0xffffff]),
    backgrounds: new Uint32Array([0]),
    styles: new Uint16Array([0]),
    graphemes: new Uint8Array([65]),
  }
}

test("validates every worker command family and rejects malformed envelopes", () => {
  const commands = [
    { ...envelope, type: "create", cols: 80, rows: 24, cellWidth: 8, cellHeight: 16, theme: { foreground: { r: 1, g: 2, b: 3 }, background: { r: 0, g: 0, b: 0 }, cursor: { r: 1, g: 2, b: 3 } } },
    { ...envelope, type: "write", data: "x" },
    { ...envelope, type: "writeReplay", chunks: ["x"] },
    { ...envelope, type: "resetAndWrite", data: "x" },
    { ...envelope, type: "resize", cols: 80, rows: 24, cellWidth: 8, cellHeight: 16 },
    { ...envelope, type: "setTheme", theme: {} },
    { ...envelope, type: "setFontMetrics", cellWidth: 8, cellHeight: 16 },
    { ...envelope, type: "key", action: "press", event: {} },
    { ...envelope, type: "paste", data: "x" },
    { ...envelope, type: "text", data: "x" },
    { ...envelope, type: "mouse", input: {} },
    { ...envelope, type: "setSelection", anchor: {}, end: {} },
    { ...envelope, type: "clearSelection" },
    { ...envelope, type: "selectAll" },
    { ...envelope, type: "selectWord", col: 0, row: 0 },
    { ...envelope, type: "selectLine", col: 0, row: 0 },
    { ...envelope, type: "scroll", delta: 1 },
    { ...envelope, type: "scrollToBottom" },
    { ...envelope, type: "viewportPointToScreen", col: 0, row: 0 },
    { ...envelope, type: "screenPointToViewport", col: 0, row: 0 },
    { ...envelope, type: "requestFullFrame" },
    { ...envelope, type: "dispose" },
  ]
  for (const command of commands) assert.equal(validateTerminalWorkerCommand(command), true)
  assert.equal(validateTerminalWorkerCommand({ ...envelope, version: 99, type: "dispose" }), false)
  assert.equal(validateTerminalWorkerCommand({ ...envelope, sequence: -1, type: "dispose" }), false)
  assert.equal(validateTerminalWorkerCommand({ ...envelope, type: "write", data: 1 }), false)
  assert.equal(validateTerminalWorkerCommand({ ...envelope, type: "unknown" }), false)
})

test("validates packed events and transfers ownership of every packed buffer", () => {
  const update = packedUpdate()
  const event = {
    ...envelope,
    type: "packedUpdate",
    update,
    state: {
      title: "",
      scrollbar: null,
      selectionText: "",
      viewportActive: true,
      mouseTracking: false,
      mouseAnyEventTracking: false,
      alternateScreen: false,
      applicationCursorKeys: false,
      synchronizedOutput: false,
    },
  }
  assert.equal(validateTerminalWorkerEvent(event), true)
  const transfer = terminalRenderUpdateTransferList(update)
  assert.equal(transfer.length, 8)
  structuredClone(event, { transfer })
  assert.equal(update.dirtyRows.buffer.byteLength, 0)
  assert.equal(validateTerminalWorkerEvent({ ...event, generation: 0 }), false)
  assert.equal(validateTerminalWorkerEvent({ ...envelope, type: "encodedInput", data: 1 }), false)
})
