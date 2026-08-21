export type TerminalCheckpoint = {
  checkpointVersion: 1
  terminalEpoch: string
  sequence: number
  cols: number
  rows: number
  createdAt: string
  syntheticAnsi: string
}

export interface TerminalStateRecorder {
  reset(cols: number, rows: number): void
  resize(cols: number, rows: number): void
  write(data: string): void
  checkpoint(sequence: number): TerminalCheckpoint
  plainText(): string
  dispose(): void
}

const ESC = "\u001b"

/**
 * Small, bounded fallback recorder. It intentionally emits a conservative ANSI
 * screen reset rather than pretending to preserve unsupported VT modes. The
 * interface leaves room for a full headless parser without exposing cell data
 * to the host/client protocol.
 */
export class BasicTerminalStateRecorder implements TerminalStateRecorder {
  private cols: number
  private rows: number
  private cells: string[][]
  private cursorX = 0
  private cursorY = 0
  private alternate = false
  private cursorVisible = true
  private pending = ""
  private disposed = false

  constructor(
    cols: number,
    rows: number,
    private readonly terminalEpoch: string,
  ) {
    this.cols = Math.max(1, Math.trunc(cols))
    this.rows = Math.max(1, Math.trunc(rows))
    this.cells = this.makeCells()
  }

  reset(cols: number, rows: number): void {
    this.cols = Math.max(1, Math.trunc(cols))
    this.rows = Math.max(1, Math.trunc(rows))
    this.cells = this.makeCells()
    this.cursorX = 0
    this.cursorY = 0
    this.alternate = false
    this.pending = ""
  }

  resize(cols: number, rows: number): void {
    const nextCols = Math.max(1, Math.trunc(cols))
    const nextRows = Math.max(1, Math.trunc(rows))
    const next = Array.from({ length: nextRows }, (_, row) =>
      Array.from({ length: nextCols }, (_, column) =>
        this.cells[row]?.[column] ?? " ",
      ),
    )
    this.cols = nextCols
    this.rows = nextRows
    this.cells = next
    this.cursorX = Math.min(this.cursorX, nextCols - 1)
    this.cursorY = Math.min(this.cursorY, nextRows - 1)
  }

  write(data: string): void {
    if (this.disposed) return
    const input = this.pending + data
    this.pending = ""
    let index = 0
    while (index < input.length) {
      const character = input[index]!
      if (character !== ESC) {
        this.writeCharacter(character)
        index += 1
        continue
      }
      if (input[index + 1] === "]") {
        const end = input.indexOf("\u0007", index + 2)
        if (end < 0) {
          this.pending = input.slice(index)
          break
        }
        index = end + 1
        continue
      }
      if (input[index + 1] !== "[") {
        if (index + 1 >= input.length) this.pending = input.slice(index)
        else index += 2
        continue
      }
      const end = this.findCsiEnd(input, index + 2)
      if (end < 0) {
        this.pending = input.slice(index)
        break
      }
      this.applyCsi(input.slice(index + 2, end), input[end]!)
      index = end + 1
    }
  }

  plainText(): string {
    return this.cells.map(line => line.join("").replace(/\s+$/u, "")).join("\n")
  }

  checkpoint(sequence: number): TerminalCheckpoint {
    const body = this.plainText().replace(/\n/g, "\r\n")
    const cursor = `${ESC}[${this.cursorY + 1};${this.cursorX + 1}H`
    const mode = this.alternate ? `${ESC}[?1049h` : `${ESC}[?1049l`
    const cursorVis = this.cursorVisible ? `${ESC}[?25h` : `${ESC}[?25l`
    return {
      checkpointVersion: 1,
      terminalEpoch: this.terminalEpoch,
      sequence,
      cols: this.cols,
      rows: this.rows,
      createdAt: new Date().toISOString(),
      syntheticAnsi: `${ESC}[0m${ESC}[2J${ESC}[H${mode}${cursorVis}${body}${cursor}`,
    }
  }

  dispose(): void {
    this.disposed = true
    this.pending = ""
    this.cells = []
  }

  private makeCells(): string[][] {
    return Array.from({ length: this.rows }, () =>
      Array.from({ length: this.cols }, () => " "),
    )
  }

  private findCsiEnd(data: string, start: number): number {
    for (let index = start; index < data.length; index += 1) {
      const code = data.charCodeAt(index)
      if (code >= 0x40 && code <= 0x7e) return index
    }
    return -1
  }

  private applyCsi(body: string, final: string): void {
    const privateMode = body.startsWith("?")
    const values = body.replace(/^\?/, "").split(";").map(value => {
      const parsed = Number(value)
      return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0
    })
    const first = values[0] ?? 0
    if (privateMode && first === 25 && (final === "h" || final === "l")) {
      this.cursorVisible = final === "h"
      return
    }
    if (privateMode && (first === 1049 || first === 47) && (final === "h" || final === "l")) {
      this.alternate = final === "h"
      if (this.alternate) {
        this.cells = this.makeCells()
        this.cursorX = 0
        this.cursorY = 0
      }
      return
    }
    switch (final) {
      case "H":
      case "f":
        this.cursorY = Math.min(Math.max((values[0] || 1) - 1, 0), this.rows - 1)
        this.cursorX = Math.min(Math.max((values[1] || 1) - 1, 0), this.cols - 1)
        return
      case "A":
        this.cursorY = Math.max(0, this.cursorY - (first || 1))
        return
      case "B":
        this.cursorY = Math.min(this.rows - 1, this.cursorY + (first || 1))
        return
      case "C":
        this.cursorX = Math.min(this.cols - 1, this.cursorX + (first || 1))
        return
      case "D":
        this.cursorX = Math.max(0, this.cursorX - (first || 1))
        return
      case "J":
        if (first === 2 || first === 3) this.cells = this.makeCells()
        else if (first === 0) {
          for (let y = this.cursorY; y < this.rows; y += 1) {
            const start = y === this.cursorY ? this.cursorX : 0
            this.cells[y]!.fill(" ", start)
          }
        }
        return
      case "K":
        if (first === 2) this.cells[this.cursorY]!.fill(" ")
        else if (first === 0) this.cells[this.cursorY]!.fill(" ", this.cursorX)
        return
      case "m":
        return
      default:
        return
    }
  }

  private writeCharacter(character: string): void {
    if (character === "\r") {
      this.cursorX = 0
      return
    }
    if (character === "\n") {
      this.cursorY += 1
      if (this.cursorY >= this.rows) {
        this.cells.shift()
        this.cells.push(Array.from({ length: this.cols }, () => " "))
        this.cursorY = this.rows - 1
      }
      return
    }
    if (character === "\b") {
      this.cursorX = Math.max(0, this.cursorX - 1)
      return
    }
    if (character < " ") return
    this.cells[this.cursorY]![this.cursorX] = character
    this.cursorX += 1
    if (this.cursorX >= this.cols) {
      this.cursorX = 0
      this.cursorY += 1
      if (this.cursorY >= this.rows) {
        this.cells.shift()
        this.cells.push(Array.from({ length: this.cols }, () => " "))
        this.cursorY = this.rows - 1
      }
    }
  }
}
