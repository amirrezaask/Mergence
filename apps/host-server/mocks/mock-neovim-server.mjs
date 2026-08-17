#!/usr/bin/env node
import net from "node:net"
import process from "node:process"
import { Decoder, Encoder } from "@msgpack/msgpack"

const listenIndex = process.argv.indexOf("--listen")
const endpoint = listenIndex >= 0 ? process.argv[listenIndex + 1] : undefined
if (process.argv.includes("--version")) {
  process.stdout.write("NVIM v0.13.0\nBuild type: Release\n")
  process.exit(0)
}
if (!endpoint) {
  process.stderr.write("mock-neovim-server: missing --listen endpoint\n")
  process.exit(2)
}

const encoder = new Encoder()
const connections = new Set()
let dimensions = { cols: 80, rows: 24 }
let inputLog = ""
let cursor = { row: 4, col: 0 }
let focused = false
const requestStats = {
  input: 0,
  paste: 0,
  resize: 0,
  focus: 0,
  mouse: 0,
  location: 0,
}

function isArray(value) {
  return Array.isArray(value)
}
function numberAt(value, index, fallback = 0) {
  const next = value[index]
  return typeof next === "number" && Number.isFinite(next) ? Math.trunc(next) : fallback
}
function stringAt(value, index, fallback = "") {
  const next = value[index]
  return typeof next === "string" ? next : fallback
}
function send(socket, value) {
  if (!socket.destroyed) socket.write(encoder.encode(value))
}
function redraw(socket, events) {
  // Neovim's redraw event wire shape is [event_name, [args...]].
  send(socket, [2, "redraw", events.map(event => [event[0], event.slice(1)])])
}
function boundedText(value, max = 120) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}
function lineCells(value, highlight = 1) {
  return Array.from(value, character => [character, highlight, 1])
}
function displayInput(value) {
  return value
    .replaceAll("\u000b", "<C-K>")
    .replaceAll("\u001b", "<Esc>")
    .replaceAll("\r", "<CR>")
    .replaceAll("\n", "<NL>")
}
function initialEvents() {
  return [
    ["grid_resize", 1, dimensions.cols, dimensions.rows],
    ["default_colors_set", 0xffffff, 0x10151f, 0x7f8ea3, 0, 0],
    ["hl_attr_define", 1, { foreground: 0x9cc7ff, background: 0x10151f }, {}, [{ kind: "syntax", hi_name: "Normal" }]],
    ["hl_attr_define", 2, { foreground: 0x79d6b2, background: 0x10151f, italic: true }, {}, [{ kind: "syntax", hi_name: "String" }]],
    ["grid_clear", 1],
    ["grid_line", 1, 0, 0, lineCells("YAADE Neovim  •  WebGL2", 1), false],
    ["grid_line", 1, 2, 0, lineCells("Native redraws, a durable host process, and a crisp GPU surface.", 2), false],
    ["grid_line", 1, 4, 0, lineCells("Type here to send input to the mock server.", 1), false],
    ["grid_cursor_goto", 1, cursor.row, cursor.col],
    ["mode_info_set", true, [{ cursor_shape: "block", cell_percentage: 100, blinkwait: 700, blinkon: 400, blinkoff: 250 }]],
    ["mode_change", "normal", 0],
    ["mouse_on"],
    ["flush"],
  ]
}
function textEvents(text, row = 6) {
  return [
    ["grid_line", 1, row, 0, lineCells(boundedText(text), 1), false],
    ["grid_cursor_goto", 1, cursor.row, cursor.col],
    ["flush"],
  ]
}
function tenThousandCellEvents() {
  const cols = 200
  const rows = 50
  const cells = Array.from({ length: cols }, (_, index) => [String.fromCharCode(97 + (index % 26)), 1, 1])
  return [
    ["grid_resize", 1, cols, rows],
    ["grid_clear", 1],
    ...Array.from({ length: rows }, (_, row) => ["grid_line", 1, row, 0, cells, false]),
    ["grid_cursor_goto", 1, 0, 0],
    ["flush"],
  ]
}
function metadata() {
  return {
    version: { major: 0, minor: 13, patch: 0, api_level: 12, api_compatible: 0, api_prerelease: false },
    functions: [
      { name: "nvim_get_api_info" },
      { name: "nvim_set_client_info" },
      { name: "nvim_ui_attach" },
      { name: "nvim_ui_try_resize" },
      { name: "nvim_input" },
      { name: "nvim_paste" },
      { name: "nvim_input_mouse" },
      { name: "nvim_cmd" },
      { name: "nvim_win_set_cursor" },
      { name: "nvim_buf_get_lines" },
      { name: "nvim_ui_set_focus" },
      { name: "nvim_ui_detach" },
      { name: "nvim_replace_termcodes" },
      { name: "nvim_exec_lua" },
    ],
    ui_events: ["grid_resize", "grid_clear", "grid_line", "grid_cursor_goto", "flush", "hl_attr_define", "default_colors_set", "mode_info_set", "mode_change", "set_title", "bell", "visual_bell"],
    ui_options: ["rgb", "ext_linegrid", "ext_hlstate"],
  }
}
function respond(socket, id, error, result) {
  if (typeof id !== "number") return
  send(socket, [1, id, error, result])
}
function parseRequest(message) {
  if (!isArray(message) || message.length < 3) return null
  const type = numberAt(message, 0)
  if (type !== 0 && type !== 2) return null
  const id = type === 0 ? message[1] : null
  const method = type === 0 ? message[2] : message[1]
  const rawArgs = type === 0 ? message[3] : message[2]
  if (type === 0 && typeof id !== "number") return null
  if (typeof method !== "string") return null
  const args = isArray(rawArgs) ? rawArgs : []
  return { id, method, args }
}
function handleRequest(state, request) {
  const { socket } = state
  switch (request.method) {
    case "nvim_get_api_info":
      respond(socket, request.id, null, [1, metadata()])
      return
    case "nvim_set_client_info":
    case "nvim_ui_attach":
      respond(socket, request.id, null, null)
      if (request.method === "nvim_ui_attach") {
        dimensions = { cols: Math.max(1, numberAt(request.args, 0, 80)), rows: Math.max(1, numberAt(request.args, 1, 24)) }
        state.attached = true
        redraw(socket, initialEvents())
      }
      return
    case "nvim_ui_try_resize":
      requestStats.resize += 1
      dimensions = { cols: Math.max(1, numberAt(request.args, 0, dimensions.cols)), rows: Math.max(1, numberAt(request.args, 1, dimensions.rows)) }
      respond(socket, request.id, null, null)
      redraw(socket, [
        ["grid_resize", 1, dimensions.cols, dimensions.rows],
        ["grid_clear", 1],
        ...textEvents(`resize ${dimensions.cols}×${dimensions.rows}`, 1),
      ])
      return
    case "nvim_input": {
      requestStats.input += 1
      const text = stringAt(request.args, 0)
      if (text === "__YAADE_EXIT__") {
        respond(socket, request.id, null, text.length)
        setImmediate(() => process.exit(0))
        return
      }
      if (text === "__YAADE_FAIL__") {
        process.stderr.write("mock requested failure\n")
        setImmediate(() => process.exit(17))
        return
      }
      if (text === "__YAADE_BENCH_10K__") {
        redraw(socket, tenThousandCellEvents())
        return
      }
      inputLog += text
      respond(socket, request.id, null, text.length)
      redraw(socket, textEvents(`input: ${boundedText(displayInput(inputLog))}`))
      return
    }
    case "nvim_paste": {
      requestStats.paste += 1
      const text = stringAt(request.args, 0)
      inputLog += text
      respond(socket, request.id, null, true)
      redraw(socket, textEvents(`paste: ${boundedText(inputLog)}`))
      return
    }
    case "nvim_input_mouse":
      requestStats.mouse += 1
      respond(socket, request.id, null, true)
      redraw(socket, textEvents(`mouse: ${stringAt(request.args, 0)} ${stringAt(request.args, 1)}`))
      return
    case "nvim_cmd": {
      requestStats.location += 1
      const command = request.args[0]
      const args = command && typeof command === "object" && !Array.isArray(command) && Array.isArray(command.args) ? command.args : []
      const target = typeof args[0] === "string" ? args[0] : ""
      respond(socket, request.id, null, null)
      redraw(socket, textEvents(`opened: ${boundedText(target)}`))
      return
    }
    case "nvim_win_set_cursor": {
      requestStats.location += 1
      const position = request.args[1]
      if (Array.isArray(position)) {
        cursor = { row: Math.max(0, numberAt(position, 0) - 1), col: Math.max(0, numberAt(position, 1)) }
      }
      respond(socket, request.id, null, null)
      redraw(socket, [["grid_cursor_goto", 1, cursor.row, cursor.col], ["flush"]])
      return
    }
    case "nvim_buf_get_lines":
      respond(socket, request.id, null, ["éclair"])
      return
    case "nvim_ui_set_focus":
      requestStats.focus += 1
      focused = Boolean(request.args[0])
      respond(socket, request.id, null, null)
      return
    case "nvim_ui_detach":
      state.attached = false
      respond(socket, request.id, null, null)
      return
    case "nvim_replace_termcodes":
      respond(socket, request.id, null, stringAt(request.args, 0))
      return
    case "nvim_exec_lua":
      respond(socket, request.id, null, "mock visual selection")
      return
    default:
      respond(socket, request.id, [0, `mock method unavailable: ${request.method}`], null)
  }
}

class ChunkQueue {
  #chunks = []
  #head = 0
  #waiters = []
  #closed = false
  push(chunk) {
    if (this.#closed) return
    const waiter = this.#waiters.shift()
    if (waiter) waiter({ value: chunk, done: false })
    else this.#chunks.push(chunk)
  }
  close() {
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true })
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      const chunk = this.#chunks[this.#head]
      if (chunk) {
        this.#head += 1
        if (this.#head >= 64 && this.#head * 2 >= this.#chunks.length) {
          this.#chunks.splice(0, this.#head)
          this.#head = 0
        }
        yield chunk
        continue
      }
      if (this.#closed) return
      const next = await new Promise(resolve => this.#waiters.push(resolve))
      if (next.done) return
      yield next.value
    }
  }
}

const server = net.createServer(socket => {
  const state = { socket, attached: false }
  connections.add(socket)
  socket.setNoDelay(true)
  const queue = new ChunkQueue()
  const decoder = new Decoder({ maxArrayLength: 4096, maxMapLength: 4096, maxStrLength: 2 * 1024 * 1024, maxBinLength: 2 * 1024 * 1024 })
  socket.on("data", chunk => queue.push(new Uint8Array(chunk)))
  socket.once("close", () => {
    queue.close()
    connections.delete(socket)
  })
  void (async () => {
    try {
      for await (const message of decoder.decodeStream(queue)) {
        const request = parseRequest(message)
        if (request) handleRequest(state, request)
      }
    } catch {
      socket.destroy()
    }
  })()
})

server.listen(endpoint, () => {
  process.stdout.write(`mock-neovim-listening ${endpoint}\n`)
})
function shutdown() {
  for (const socket of connections) socket.destroy()
  server.close(() => process.exit(0))
}
process.once("SIGTERM", shutdown)
process.once("SIGINT", shutdown)
