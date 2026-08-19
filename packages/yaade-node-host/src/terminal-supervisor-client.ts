import net from "node:net"
import {
  encodeSupervisorFrame,
  ensureTerminalSupervisor,
  SupervisorFrameReader,
  type SupervisorMessage,
} from "./terminal-supervisor.js"
import type {
  TerminalAttachSnapshot,
  TerminalCreateResult,
  TerminalInspectSnapshot,
  TerminalLaunch,
} from "./terminal.js"

type EmitFn = (channel: string, args: unknown[]) => void

export class SupervisedTerminalHost {
  private socket: net.Socket | null = null
  private readonly reader = new SupervisorFrameReader()
  private nextId = 1
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
    }
  >()
  private emit: EmitFn = () => {}

  static async connect(dataDir: string): Promise<SupervisedTerminalHost> {
    const { socketPath } = await ensureTerminalSupervisor(dataDir)
    const client = new SupervisedTerminalHost()
    await client.open(socketPath)
    return client
  }

  setEmit(emit: EmitFn): void {
    this.emit = emit
  }

  create(
    cwdUri: string,
    launch: TerminalLaunch | null | undefined,
    clientId: string,
  ): Promise<TerminalCreateResult> {
    return this.rpc("create", [cwdUri, launch ?? null, clientId]) as Promise<TerminalCreateResult>
  }

  write(id: string, data: string): Promise<null> {
    return this.rpc("write", [id, data]) as Promise<null>
  }

  writeBinary(id: string, dataBase64: string): Promise<null> {
    return this.rpc("writeBinary", [id, dataBase64]) as Promise<null>
  }

  resize(id: string, cols?: number, rows?: number): Promise<null> {
    return this.rpc("resize", [id, cols, rows]) as Promise<null>
  }

  acknowledgeData(
    id: string,
    charCount: number,
    clientId?: string,
  ): Promise<null> {
    return this.rpc("acknowledgeData", [id, charCount, clientId]) as Promise<null>
  }

  clearUnacknowledgedChars(id: string): Promise<null> {
    return this.rpc("clearUnacknowledgedChars", [id]) as Promise<null>
  }

  pauseForBackpressure(ids?: readonly string[]): Promise<null> {
    return this.rpc("pauseForBackpressure", [ids]) as Promise<null>
  }

  armLiveViewer(id: string, clientId: string): Promise<void> {
    return this.rpc("armLiveViewer", [id, clientId]) as Promise<void>
  }

  resumeForClient(clientId: string): Promise<void> {
    return this.rpc("resumeForClient", [clientId]) as Promise<void>
  }

  attach(
    id: string,
    clientId: string,
    afterSequence?: number,
  ): Promise<TerminalAttachSnapshot | null> {
    return this.rpc("attach", [id, clientId, afterSequence]) as Promise<
      TerminalAttachSnapshot | null
    >
  }

  markReplayReady(id: string, clientId: string): Promise<null> {
    return this.rpc("markReplayReady", [id, clientId]) as Promise<null>
  }

  hasViewer(id: string, clientId: string): Promise<boolean> {
    return this.rpc("hasViewer", [id, clientId]) as Promise<boolean>
  }

  readOutput(
    id: string,
    maxBytes?: number,
  ): Promise<{ output: string; truncated: boolean } | null> {
    return this.rpc("readOutput", [id, maxBytes]) as Promise<{
      output: string
      truncated: boolean
    } | null>
  }

  inspect(id: string): Promise<TerminalInspectSnapshot | null> {
    return this.rpc("inspect", [id]) as Promise<TerminalInspectSnapshot | null>
  }

  listRunning(): Promise<TerminalInspectSnapshot[]> {
    return this.rpc("listRunning", []) as Promise<TerminalInspectSnapshot[]>
  }

  getCwd(id: string): Promise<string | null> {
    return this.rpc("getCwd", [id]) as Promise<string | null>
  }

  getForegroundProcess(id: string, fresh = false): Promise<string | null> {
    return this.rpc("getForegroundProcess", [id, fresh]) as Promise<string | null>
  }

  waitForExit(
    id: string,
  ): Promise<{ exitCode: number | null; signal?: string }> {
    return this.rpc("waitForExit", [id]) as Promise<{
      exitCode: number | null
      signal?: string
    }>
  }

  dispose(id: string): Promise<null> {
    return this.rpc("dispose", [id]) as Promise<null>
  }

  stopAll(): Promise<void> {
    return this.rpc("stopAll", []) as Promise<void>
  }

  async disconnect(): Promise<void> {
    const socket = this.socket
    this.socket = null
    if (!socket) return
    await new Promise<void>((resolve) => {
      socket.end(() => resolve())
      setTimeout(resolve, 250).unref?.()
    })
  }

  async shutdownSupervisor(): Promise<void> {
    try {
      await this.rpc("shutdown", [])
    } catch {
      /* supervisor may exit before the response is fully flushed */
    }
    await this.disconnect()
  }

  private async open(socketPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect({ path: socketPath })
      this.socket = socket
      socket.on("connect", () => resolve())
      socket.on("error", reject)
      socket.on("data", (chunk) => {
        let messages: SupervisorMessage[]
        try {
          messages = this.reader.push(chunk)
        } catch (error) {
          this.rejectAll(error instanceof Error ? error : new Error(String(error)))
          return
        }
        for (const message of messages) {
          if (message.kind === "event") {
            this.emit(message.channel, message.args)
            continue
          }
          if (message.kind !== "res") continue
          const pending = this.pending.get(message.id)
          if (!pending) continue
          this.pending.delete(message.id)
          if (message.ok) pending.resolve(message.value)
          else pending.reject(new Error(message.error ?? "supervisor error"))
        }
      })
      socket.on("close", () => {
        this.rejectAll(new Error("pty supervisor disconnected"))
      })
    })
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  private rpc(op: string, args: unknown[]): Promise<unknown> {
    const socket = this.socket
    if (!socket || socket.destroyed) {
      return Promise.reject(new Error("pty supervisor is not connected"))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      socket.write(encodeSupervisorFrame({ kind: "req", id, op, args }))
    })
  }
}
