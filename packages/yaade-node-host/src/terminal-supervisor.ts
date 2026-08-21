import net from "node:net"
import type { GhosttyMouseInput } from "@yaade/ghostty-core"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import { TerminalHost, type TerminalLaunch } from "./terminal.js"
import {
  TerminalControlError,
  type TerminalMutationFence,
} from "./terminal-control.js"
import {
  captureProcessIdentity,
  matchesProcessIdentity,
  type ProcessIdentity,
} from "./process-identity.js"
import {
  runtimeRegistryDirectory,
  runtimeSocketPath,
  runtimeProcessIsAlive,
  TerminalRuntimeRegistry,
  runtimeSupports,
  type TerminalRuntimeManifest,
} from "./terminal-runtime-registry.js"
import type { RuntimeCapabilities } from "./terminal-protocol/schema.js"
import { SupervisorPeerWriter } from "./supervisor-peer-writer.js"
import type { TerminalHistoryPersistence } from "./terminal-recovery-store.js"
import {
  applySupervisorCommand,
  runtimeHello,
  supervisorErrorResponse,
  supervisorResponse,
  type SupervisorHelloIdentity,
} from "./terminal-protocol/apply-command.js"
import {
  encodeSupervisorProtocolMessage,
} from "./terminal-protocol/codec.js"
import {
  SUPERVISOR_PROTOCOL_MAX,
  SUPERVISOR_PROTOCOL_MIN,
  MAX_PENDING_REQUESTS,
  MAX_SUPERVISOR_FRAME_BYTES,
} from "./terminal-protocol/limits.js"
import {
  isRecord,
  isSupervisorCommand,
  type SupervisorCommand,
  type SupervisorEvent,
} from "./terminal-protocol/schema.js"

export type SupervisorManifest = {
  schemaVersion: 1
  supervisorId: string
  supervisorEpoch: string
  protocolVersion: number
  pid: number
  processIdentity: ProcessIdentity | null
  socketPath: string
  startedAt: string
}

export type SupervisorRpcError = {
  readonly code: string
  readonly terminalId: string
  readonly message: string
  readonly leaseId?: string
}

export type SupervisorMessage =
  | {
      kind: "req"
      id: number
      op: string
      args: unknown[]
      deadlineUnixMs?: number
      commandId?: string
    }
  | {
      kind: "res"
      id: number
      ok: boolean
      value?: unknown
      error?: string | SupervisorRpcError
    }
  | {
      kind: "event"
      channel: string
      args: unknown[]
    }

const UNIX_SOCKET_MAX_BYTES = 100

export function supervisorSocketPath(dataDir: string): string {
  if (process.platform === "win32") {
    const tag = dataDir.replace(/[^a-zA-Z0-9]/g, "").slice(-24) || "yaade"
    return `\\\\.\\pipe\\yaade-pty-${tag}`
  }
  const nested = path.join(path.resolve(dataDir), "pty-supervisor.sock")
  if (Buffer.byteLength(nested) <= UNIX_SOCKET_MAX_BYTES) return nested
  const digest = createHash("sha256").update(nested).digest("hex").slice(0, 16)
  return path.join(os.tmpdir(), `yd-pty-${digest}.sock`)
}

export function supervisorPidPath(dataDir: string): string {
  return path.join(dataDir, "pty-supervisor.pid")
}

export function supervisorManifestPath(dataDir: string): string {
  return path.join(dataDir, "pty-supervisor.json")
}

export function supervisorLockPath(dataDir: string): string {
  return path.join(dataDir, "pty-supervisor.lock")
}

export function encodeSupervisorFrame(message: SupervisorMessage): Buffer {
  const json = Buffer.from(JSON.stringify(message), "utf8")
  const header = Buffer.alloc(4)
  header.writeUInt32BE(json.byteLength, 0)
  return Buffer.concat([header, json])
}

export class SupervisorFrameReader {
  private buffer = Buffer.alloc(0)

  push(chunk: Buffer): unknown[] {
    if (this.buffer.byteLength + chunk.byteLength > MAX_SUPERVISOR_FRAME_BYTES + 4) {
      this.buffer = Buffer.alloc(0)
      throw new Error("supervisor frame too large")
    }
    this.buffer = Buffer.concat([this.buffer, chunk])
    const out: unknown[] = []
    while (this.buffer.byteLength >= 4) {
      const size = this.buffer.readUInt32BE(0)
      if (size > MAX_SUPERVISOR_FRAME_BYTES) {
        this.buffer = Buffer.alloc(0)
        throw new Error("supervisor frame too large")
      }
      if (this.buffer.byteLength < 4 + size) break
      const json = this.buffer.subarray(4, 4 + size)
      this.buffer = this.buffer.subarray(4 + size)
      let parsed: unknown
      try {
        parsed = JSON.parse(json.toString("utf8"))
      } catch {
        throw new Error("supervisor payload is not valid JSON")
      }
      out.push(parsed)
    }
    return out
  }
}

function typedSupervisorEvent(
  channel: string,
  args: unknown[],
  ownerEpoch: string,
): SupervisorEvent | null {
  const terminalId = typeof args[0] === "string" ? args[0] : undefined
  if (channel === "terminal:data" && terminalId) {
    return {
      version: 2,
      kind: "event",
      event: "terminal.output",
      ownerEpoch,
      terminalId,
      payload: {
        data: typeof args[1] === "string" ? args[1] : "",
        sequence: typeof args[2] === "number" ? args[2] : 0,
      },
    }
  }
  if (channel === "terminal:semantic" && terminalId) {
    const terminalEpoch = typeof args[2] === "string" ? args[2] : undefined
    const revision = typeof args[1] === "number" ? args[1] : undefined
    if (!terminalEpoch || revision === undefined) return null
    return {
      version: 2,
      kind: "event",
      event: "terminal.semantic",
      ownerEpoch,
      terminalId,
      terminalEpoch,
      revision,
      payload: { snapshot: args[3] },
    }
  }
  if (channel === "terminal:exit" && terminalId) {
    return {
      version: 2,
      kind: "event",
      event: "terminal.exited",
      ownerEpoch,
      terminalId,
      payload: {
        exitCode: typeof args[1] === "number" ? args[1] : null,
        signal: typeof args[2] === "number" ? args[2] : null,
      },
    }
  }
  return null
}

function historyPersistence(): TerminalHistoryPersistence {
  const value = process.env.YAADE_TERMINAL_HISTORY
  if (value === "disabled" || value === "screen-only" || value === "screen-and-scrollback") {
    return value
  }
  return "screen-only"
}

function fenceArg(value: unknown): TerminalMutationFence {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TerminalControlError(
      "WRITER_LEASE_REQUIRED",
      "",
      "terminal mutation fence is required",
    )
  }
  const record = value as Record<string, unknown>
  if (
    typeof record.terminalId !== "string" ||
    typeof record.terminalEpoch !== "string" ||
    typeof record.leaseId !== "string" ||
    typeof record.leaseGeneration !== "number" ||
    typeof record.principalId !== "string" ||
    typeof record.connectionId !== "string" ||
    typeof record.commandId !== "string"
  ) {
    throw new TerminalControlError(
      "WRITER_LEASE_REQUIRED",
      typeof record.terminalId === "string" ? record.terminalId : "",
      "terminal mutation fence is required",
    )
  }
  return {
    terminalId: record.terminalId,
    terminalEpoch: record.terminalEpoch,
    leaseId: record.leaseId,
    leaseGeneration: record.leaseGeneration,
    principalId: record.principalId,
    connectionId: record.connectionId,
    commandId: record.commandId,
  }
}

function mouseInputArg(value: unknown, terminalId: string): GhosttyMouseInput {
  if (!isRecord(value)) {
    throw new TerminalControlError(
      "WRITER_LEASE_REQUIRED",
      terminalId,
      "structured mouse input is required",
    )
  }
  const action = value.action
  if (action !== "press" && action !== "release" && action !== "motion") {
    throw new TerminalControlError(
      "WRITER_LEASE_REQUIRED",
      terminalId,
      "structured mouse action is invalid",
    )
  }
  const numberField = (field: string): number => {
    const result = value[field]
    if (typeof result !== "number" || !Number.isFinite(result)) {
      throw new TerminalControlError(
        "WRITER_LEASE_REQUIRED",
        terminalId,
        `structured mouse field ${field} is invalid`,
      )
    }
    return result
  }
  const button = value.button === null
    ? null
    : typeof value.button === "number" && Number.isSafeInteger(value.button)
      ? value.button
      : undefined
  if (button === undefined || typeof value.anyButtonPressed !== "boolean") {
    throw new TerminalControlError(
      "WRITER_LEASE_REQUIRED",
      terminalId,
      "structured mouse button state is invalid",
    )
  }
  return {
    action,
    button,
    mods: numberField("mods"),
    x: numberField("x"),
    y: numberField("y"),
    screenWidth: numberField("screenWidth"),
    screenHeight: numberField("screenHeight"),
    cellWidth: numberField("cellWidth"),
    cellHeight: numberField("cellHeight"),
    paddingLeft: numberField("paddingLeft"),
    paddingRight: numberField("paddingRight"),
    paddingTop: numberField("paddingTop"),
    paddingBottom: numberField("paddingBottom"),
    anyButtonPressed: value.anyButtonPressed,
  }
}

function serializeSupervisorError(error: unknown): string | SupervisorRpcError {
  if (error instanceof TerminalControlError) {
    return {
      code: error.code,
      terminalId: error.terminalId,
      message: error.message,
      ...(error.leaseId ? { leaseId: error.leaseId } : {}),
    }
  }
  return error instanceof Error ? error.message : String(error)
}

function connectionIdsForLegacyRequest(op: string, args: unknown[]): string[] {
  const ids: string[] = []
  const add = (value: unknown) => {
    if (typeof value === "string" && value.length > 0 && value.length <= 256) {
      ids.push(value)
    }
  }
  switch (op) {
    case "acquireLease":
    case "renewLease":
    case "releaseLease":
    case "forceTakeover":
      add(args[3])
      break
    case "transferLease":
      add(args[4])
      add(args[6])
      break
    case "writeFenced":
    case "writeBinaryFenced":
      add(isRecord(args[2]) ? args[2].connectionId : undefined)
      break
    case "resizeFenced":
      add(isRecord(args[3]) ? args[3].connectionId : undefined)
      break
    case "disposeFenced":
      add(isRecord(args[1]) ? args[1].connectionId : undefined)
      break
    case "releaseConnection":
      add(args[0])
      break
  }
  return ids
}

function connectionIdsForCommand(command: SupervisorCommand): string[] {
  const payload = command.payload
  const ids: string[] = []
  const add = (value: unknown) => {
    if (typeof value === "string" && value.length > 0 && value.length <= 256) {
      ids.push(value)
    }
  }
  if (
    command.operation === "acquireLease" ||
    command.operation === "renewLease" ||
    command.operation === "releaseLease" ||
    command.operation === "forceTakeover"
  ) add(payload.connectionId)
  else if (command.operation === "transferLease") {
    add(payload.connectionId)
    add(payload.targetConnectionId)
  } else if (
    command.operation === "sendInput" ||
    command.operation === "sendPaste" ||
    command.operation === "sendFocus" ||
    command.operation === "sendMouse" ||
    command.operation === "resize" ||
    command.operation === "dispose"
  ) {
    add(isRecord(payload.fence) ? payload.fence.connectionId : undefined)
  } else if (command.operation === "releaseConnection") add(payload.connectionId)
  return ids
}

function requestClientId(op: string, args: unknown[]): string | null {
  if (op === "create") return typeof args[2] === "string" ? args[2] : null
  if (
    op === "attach" ||
    op === "armLiveViewer" ||
    op === "markReplayReady" ||
    op === "hasViewer"
  ) {
    return typeof args[1] === "string" ? args[1] : null
  }
  if (op === "acknowledgeData") return typeof args[2] === "string" ? args[2] : null
  if (op === "resumeForClient") return typeof args[0] === "string" ? args[0] : null
  return null
}

function applyOp(
  host: TerminalHost,
  op: string,
  args: unknown[],
  identity: SupervisorHelloIdentity,
): unknown {
  switch (op) {
    case "create":
      return host.create(
        String(args[0] ?? ""),
        (args[1] as TerminalLaunch | null | undefined) ?? null,
        String(args[2] ?? "supervisor"),
        typeof args[3] === "string" ? args[3] : undefined,
      )
    case "write":
      return host.write(String(args[0] ?? ""), String(args[1] ?? ""))
    case "writeBinary":
      return host.writeBinary(String(args[0] ?? ""), String(args[1] ?? ""))
    case "resize":
      return host.resize(
        String(args[0] ?? ""),
        typeof args[1] === "number" ? args[1] : undefined,
        typeof args[2] === "number" ? args[2] : undefined,
      )
    case "acquireLease":
      return host.acquireLease(
        String(args[0] ?? ""),
        String(args[1] ?? ""),
        String(args[2] ?? ""),
        String(args[3] ?? ""),
        args[4] === "observer" ? "observer" : "writer",
      )
    case "renewLease":
      return host.renewLease(
        String(args[0] ?? ""),
        String(args[1] ?? ""),
        String(args[2] ?? ""),
        String(args[3] ?? ""),
        String(args[4] ?? ""),
      )
    case "releaseLease":
      return host.releaseLease(
        String(args[0] ?? ""),
        String(args[1] ?? ""),
        String(args[2] ?? ""),
        String(args[3] ?? ""),
        String(args[4] ?? ""),
      )
    case "releaseConnection":
      return host.releaseConnection(String(args[0] ?? ""))
    case "forceTakeover":
      return host.forceTakeover(
        String(args[0] ?? ""),
        String(args[1] ?? ""),
        String(args[2] ?? ""),
        String(args[3] ?? ""),
      )
    case "listLeases":
      return host.listLeases(String(args[0] ?? ""))
    case "currentWriterLease":
      return host.currentWriterLease(String(args[0] ?? ""))
    case "transferLease":
      return host.transferLease(
        String(args[0] ?? ""),
        String(args[1] ?? ""),
        String(args[2] ?? ""),
        String(args[3] ?? ""),
        String(args[4] ?? ""),
        String(args[5] ?? ""),
        String(args[6] ?? ""),
      )
    case "writeFenced":
      return host.writeFenced(
        String(args[0] ?? ""),
        String(args[1] ?? ""),
        fenceArg(args[2]),
      )
    case "writeBinaryFenced":
      return host.writeBinaryFenced(
        String(args[0] ?? ""),
        String(args[1] ?? ""),
        fenceArg(args[2]),
      )
    case "resizeFenced":
      return host.resizeFenced(
        String(args[0] ?? ""),
        typeof args[1] === "number" ? args[1] : undefined,
        typeof args[2] === "number" ? args[2] : undefined,
        fenceArg(args[3]),
      )
    case "pasteFenced":
      return host.pasteFenced(
        String(args[0] ?? ""),
        String(args[1] ?? ""),
        fenceArg(args[2]),
      )
    case "focusFenced":
      return host.focusFenced(
        String(args[0] ?? ""),
        args[1] === true,
        fenceArg(args[2]),
      )
    case "mouseFenced": {
      const terminalId = String(args[0] ?? "")
      return host.mouseFenced(
        terminalId,
        mouseInputArg(args[1], terminalId),
        fenceArg(args[2]),
      )
    }
    case "disposeFenced":
      return host.disposeFenced(String(args[0] ?? ""), fenceArg(args[1]))
    case "acknowledgeData":
      return host.acknowledgeData(
        String(args[0] ?? ""),
        typeof args[1] === "number" ? args[1] : Number(args[1] ?? 0),
        typeof args[2] === "string" ? args[2] : undefined,
      )
    case "clearUnacknowledgedChars":
      return host.clearUnacknowledgedChars(String(args[0] ?? ""))
    case "pauseForBackpressure":
      host.pauseForBackpressure(
        Array.isArray(args[0]) ? args[0].map(String) : undefined,
      )
      return null
    case "armLiveViewer":
      host.armLiveViewer(String(args[0] ?? ""), String(args[1] ?? ""))
      return null
    case "resumeForClient":
      host.resumeForClient(String(args[0] ?? ""))
      return null
    case "resumeAllLiveViewers":
      host.resumeAllLiveViewers()
      return null
    case "attach":
      return host.attach(
        String(args[0] ?? ""),
        String(args[1] ?? ""),
        typeof args[2] === "number" ? args[2] : undefined,
      )
    case "markReplayReady":
      return host.markReplayReady(String(args[0] ?? ""), String(args[1] ?? ""))
    case "hasViewer":
      return host.hasViewer(String(args[0] ?? ""), String(args[1] ?? ""))
    case "readOutput":
      return host.readOutput(
        String(args[0] ?? ""),
        typeof args[1] === "number" ? args[1] : undefined,
      )
    case "inspect":
      return host.inspect(String(args[0] ?? ""))
    case "listRunning":
      return host.listRunning()
    case "dispose":
      return host.dispose(String(args[0] ?? ""))
    case "stopAll":
      host.stopAll()
      return null
    case "getCwd":
      return host.getCwd(String(args[0] ?? ""))
    case "getForegroundProcess":
      return host.getForegroundProcess(
        String(args[0] ?? ""),
        args[1] === true,
      )
    case "waitForExit":
      return host.waitForExit(String(args[0] ?? ""))
    case "ping":
      return { ok: true, pid: process.pid, persistenceDegraded: host.persistenceDegraded }
    case "forceCheckpoint":
      return host.forceCheckpoint(String(args[0] ?? ""))
    case "injectCheckpoint":
      return host.injectCheckpoint(String(args[0] ?? ""), args[1])
    case "dropClients":
      return { ok: true }
    case "handshake": {
      const hello = runtimeHello(identity)
      return {
        protocolVersion: hello.protocolMax >= 2 ? 2 : 1,
        protocolMin: hello.protocolMin,
        protocolMax: hello.protocolMax,
        supervisorId: identity.supervisorId,
        supervisorEpoch: identity.supervisorEpoch,
        ownerId: hello.ownerId,
        pid: process.pid,
        capabilities: hello.capabilities,
      }
    }
    case "shutdown":
      host.stopAll()
      return null
    default:
      throw new Error(`unknown supervisor op: ${op}`)
  }
}

export async function listenTerminalSupervisor(
  socketPath: string,
  options?: {
    onShutdown?: () => void
    dataDir?: string
    manifestPath?: string
    semanticState?: boolean
    ownerId?: string
    protocolMax?: number
    capabilities?: RuntimeCapabilities
  },
): Promise<{
  host: TerminalHost
  close: () => Promise<void>
  manifest: SupervisorManifest
}> {
  const capabilities: RuntimeCapabilities = options?.capabilities ?? {
    semanticTerminalState: options?.semanticState === true,
    authoritativeLeases: true,
    structuredInput: options?.semanticState === true,
    historyPaging: options?.semanticState === true,
    subscriptions: true,
    draining: true,
  }
  const supervisorId = randomUUID()
  const supervisorEpoch = randomUUID()
  const host = new TerminalHost({
    flowControl: false,
    semanticState: options?.semanticState === true,
    recovery: options?.dataDir && options?.semanticState
      ? {
          dataDir: options.dataDir,
          ownerId: options.ownerId ?? supervisorId,
          ownerEpoch: supervisorEpoch,
          persistence: historyPersistence(),
        }
      : undefined,
  })
  const clients = new Set<net.Socket>()
  const peerWriters = new Map<net.Socket, SupervisorPeerWriter>()
  const clientIdsBySocket = new Map<net.Socket, Set<string>>()
  // A host connection is the lifetime boundary for its browser principals.
  // Releasing these owner-side leases on socket close makes a host restart
  // immediately recoverable instead of waiting for lease expiry.
  const connectionIdsBySocket = new Map<net.Socket, Set<string>>()
  const pendingBySocket = new Map<net.Socket, number>()
  const manifest: SupervisorManifest = {
    schemaVersion: 1,
    supervisorId,
    supervisorEpoch,
    protocolVersion: options?.protocolMax && options.protocolMax >= 2 ? 2 : 1,
    pid: process.pid,
    processIdentity: captureProcessIdentity(process.pid),
    socketPath,
    startedAt: new Date().toISOString(),
  }
  const helloIdentity: SupervisorHelloIdentity = {
    supervisorId: manifest.supervisorId,
    supervisorEpoch: manifest.supervisorEpoch,
    ownerId: options?.ownerId,
    capabilities,
    protocolMin: SUPERVISOR_PROTOCOL_MIN,
    protocolMax: options?.protocolMax ?? (options?.semanticState ? SUPERVISOR_PROTOCOL_MAX : 1),
  }
  const protocolByClient = new Map<net.Socket, 1 | 2>()
  host.setEmit((channel, args) => {
    const legacyFrame = encodeSupervisorFrame({ kind: "event", channel, args })
    const typedEvent = typedSupervisorEvent(channel, args, supervisorEpoch)
    const terminalId =
      channel === "terminal:data" || channel === "terminal:semantic"
        ? String(args[0] ?? "")
        : null
    for (const client of [...clients]) {
      const writer = peerWriters.get(client)
      if (!writer || client.destroyed) {
        clients.delete(client)
        writer?.close()
        continue
      }
      const useTyped = protocolByClient.get(client) === 2 && typedEvent !== null
      const frame = useTyped
        ? encodeSupervisorProtocolMessage(typedEvent)
        : legacyFrame
      const accepted =
        useTyped && typedEvent?.event === "terminal.semantic" && terminalId
          ? writer.enqueueSemanticRender(terminalId, frame)
          : (useTyped && typedEvent?.event === "terminal.output") || terminalId
            ? writer.enqueueLegacyOutput(terminalId ?? "", frame)
            : writer.enqueueReliable(frame)
      if (!accepted) clients.delete(client)
    }
    if (clients.size === 0) host.resumeAllLiveViewers()
  })
  const server = net.createServer((socket) => {
    clients.add(socket)
    peerWriters.set(socket, new SupervisorPeerWriter(socket))
    clientIdsBySocket.set(socket, new Set())
    connectionIdsBySocket.set(socket, new Set())
    protocolByClient.set(socket, 1)
    const reader = new SupervisorFrameReader()
    const write = (message: SupervisorMessage) => {
      peerWriters.get(socket)?.enqueueReliable(encodeSupervisorFrame(message))
    }
    const writeV2 = (message: ReturnType<typeof supervisorResponse>) => {
      peerWriters.get(socket)?.enqueueReliable(encodeSupervisorProtocolMessage(message))
    }
    socket.on("data", (chunk) => {
      let messages: unknown[]
      try {
        messages = reader.push(chunk)
      } catch {
        socket.destroy()
        return
      }
      for (const raw of messages) {
        if (isSupervisorCommand(raw)) {
          protocolByClient.set(socket, 2)
          for (const connectionId of connectionIdsForCommand(raw)) {
            connectionIdsBySocket.get(socket)?.add(connectionId)
          }
          const pending = pendingBySocket.get(socket) ?? 0
          if (pending >= MAX_PENDING_REQUESTS) {
            writeV2(supervisorErrorResponse(raw.requestId, new Error("PENDING_REQUEST_LIMIT")))
            socket.destroy()
            continue
          }
          pendingBySocket.set(socket, pending + 1)
          void Promise.resolve()
            .then(() => applySupervisorCommand(host, raw, helloIdentity))
            .then(value => {
              writeV2(supervisorResponse(raw.requestId, value))
              if (raw.operation === "shutdown") options?.onShutdown?.()
            })
            .catch((error: unknown) => {
              writeV2(supervisorErrorResponse(raw.requestId, error))
            })
            .finally(() => {
              pendingBySocket.set(socket, Math.max(0, (pendingBySocket.get(socket) ?? 1) - 1))
            })
          continue
        }
        if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("kind" in raw)) continue
        const message = raw as SupervisorMessage
        if (message.kind !== "req") continue
        for (const connectionId of connectionIdsForLegacyRequest(message.op, message.args)) {
          connectionIdsBySocket.get(socket)?.add(connectionId)
        }
        const pending = pendingBySocket.get(socket) ?? 0
        if (pending >= MAX_PENDING_REQUESTS) {
          write({ kind: "res", id: message.id, ok: false, error: "PENDING_REQUEST_LIMIT" })
          socket.destroy()
          continue
        }
        pendingBySocket.set(socket, pending + 1)
        const clientId = requestClientId(message.op, message.args)
        if (clientId) clientIdsBySocket.get(socket)?.add(clientId)
        void Promise.resolve()
          .then(() =>
            applyOp(host, message.op, message.args, helloIdentity),
          )
          .then((value) => {
            write({ kind: "res", id: message.id, ok: true, value })
            if (message.op === "dropClients") {
              host.resumeAllLiveViewers()
              for (const client of clients) client.destroy()
              return
            }
            if (message.op === "shutdown") {
              host.stopAll()
              options?.onShutdown?.()
            }
          })
          .catch((error: unknown) => {
            write({
              kind: "res",
              id: message.id,
              ok: false,
              error: serializeSupervisorError(error),
            })
          })
          .finally(() => {
            pendingBySocket.set(
              socket,
              Math.max(0, (pendingBySocket.get(socket) ?? 1) - 1),
            )
          })
      }
    })
    socket.on("error", () => {
      socket.destroy()
    })
    socket.on("close", () => {
      const ids = clientIdsBySocket.get(socket)
      const connectionIds = connectionIdsBySocket.get(socket)
      clientIdsBySocket.delete(socket)
      connectionIdsBySocket.delete(socket)
      protocolByClient.delete(socket)
      clients.delete(socket)
      peerWriters.get(socket)?.close()
      peerWriters.delete(socket)
      pendingBySocket.delete(socket)
      if (connectionIds) {
        for (const connectionId of connectionIds) host.releaseConnection(connectionId)
      }
      if (ids) {
        for (const clientId of ids) host.resumeForClient(clientId)
      }
      if (clients.size === 0) host.resumeAllLiveViewers()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, () => resolve())
  })
  if (process.platform !== "win32") {
    try { fs.chmodSync(socketPath, 0o600) } catch { /* best effort */ }
  }
  const manifestPath = options?.manifestPath ??
    (options?.dataDir ? supervisorManifestPath(options.dataDir) : null)
  if (manifestPath) writeSupervisorManifest(manifestPath, manifest)
  const close = async () => {
    host.stopAll()
    for (const client of clients) client.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (manifestPath) removeSupervisorManifest(manifestPath, manifest)
  }
  return { host, close, manifest }
}

function writeSupervisorManifest(
  manifestPath: string,
  manifest: SupervisorManifest,
): void {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
  const temporary = `${manifestPath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(manifest), { mode: 0o600 })
  try {
    fs.chmodSync(temporary, 0o600)
  } catch {
    /* Windows does not expose Unix mode bits. */
  }
  fs.renameSync(temporary, manifestPath)
}

/** Test/support export; production callers should use ensureTerminalSupervisor. */
export function readSupervisorManifestForTests(manifestPath: string): SupervisorManifest | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
    const record = raw as Record<string, unknown>
    if (
      record.schemaVersion !== 1 ||
      typeof record.supervisorId !== "string" ||
      typeof record.supervisorEpoch !== "string" ||
      typeof record.protocolVersion !== "number" ||
      typeof record.pid !== "number" ||
      typeof record.socketPath !== "string" ||
      typeof record.startedAt !== "string"
    ) return null
    const processIdentity = record.processIdentity
    return {
      schemaVersion: 1,
      supervisorId: record.supervisorId,
      supervisorEpoch: record.supervisorEpoch,
      protocolVersion: record.protocolVersion,
      pid: record.pid,
      processIdentity:
        processIdentity && typeof processIdentity === "object"
          ? (processIdentity as ProcessIdentity)
          : null,
      socketPath: record.socketPath,
      startedAt: record.startedAt,
    }
  } catch {
    return null
  }
}

const readSupervisorManifest = readSupervisorManifestForTests

function removeSupervisorManifest(
  manifestPath: string,
  expected: SupervisorManifest,
): void {
  const current = readSupervisorManifest(manifestPath)
  if (!current || current.supervisorEpoch !== expected.supervisorEpoch) return
  try {
    fs.unlinkSync(manifestPath)
  } catch {
    /* already removed */
  }
}

async function acquireSupervisorLock(
  lockPath: string,
): Promise<import("node:fs/promises").FileHandle | null> {
  try {
    const handle = await fs.promises.open(lockPath, "wx", 0o600)
    await handle.writeFile(
      JSON.stringify({
        pid: process.pid,
        processIdentity: captureProcessIdentity(process.pid),
        createdAt: new Date().toISOString(),
      }),
      "utf8",
    )
    return handle
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? error.code
      : undefined
    if (code !== "EEXIST") throw error
    try {
      const stat = await fs.promises.stat(lockPath)
      const raw: unknown = JSON.parse(await fs.promises.readFile(lockPath, "utf8"))
      const record = raw && typeof raw === "object" && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : null
      const identity = record?.processIdentity
      const identityRecord = identity && typeof identity === "object" && !Array.isArray(identity)
        ? identity as ProcessIdentity
        : null
      const stale = identityRecord
        ? !matchesProcessIdentity(identityRecord)
        : Date.now() - stat.mtimeMs > 30_000
      if (stale) fs.unlinkSync(lockPath)
    } catch {
      /* Another starter may be writing or removing the lock. */
    }
    return null
  }
}

async function waitForSupervisor(
  socketPath: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await canPingSupervisor(socketPath)) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return false
}

export type SupervisorGenerationOptions = {
  readonly runtimeVersion?: string
  readonly requiredProtocol?: number
  readonly requiredCapabilities?: Partial<RuntimeCapabilities>
}

function supervisorManifestIsCompatible(
  manifest: TerminalRuntimeManifest,
): boolean {
  const executablePath = manifest.processIdentity?.executablePath
  if (!executablePath) return true
  // Bun-hosted supervisors lose their PTY child to SIGHUP on macOS. They can
  // remain connected for old metadata, but must not be selected for creates.
  return path.basename(executablePath).toLowerCase() !== "bun"
}

export async function ensureTerminalSupervisorGeneration(
  dataDir: string,
  options: SupervisorGenerationOptions = {},
): Promise<{ socketPath: string; spawned: boolean; manifest: TerminalRuntimeManifest }> {
  fs.mkdirSync(dataDir, { recursive: true })
  const registry = new TerminalRuntimeRegistry(dataDir)
  registry.pruneStale()
  const runtimeVersion = options.runtimeVersion ?? "generation-v1"
  const requiredProtocol = options.requiredProtocol ?? 1
  const findCandidate = (): TerminalRuntimeManifest | null =>
    registry.listManifests().find(manifest =>
      (manifest.processIdentity === null || runtimeProcessIsAlive(manifest)) &&
      supervisorManifestIsCompatible(manifest) &&
      manifest.runtimeVersion === runtimeVersion &&
      runtimeSupports(manifest, requiredProtocol, options.requiredCapabilities),
    ) ?? null
  const existing = findCandidate()
  if (existing) return { socketPath: existing.socketPath, spawned: false, manifest: existing }

  const lockPath = path.join(runtimeRegistryDirectory(dataDir), "generation.lock")
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  let lock = await acquireSupervisorLock(lockPath)
  while (!lock) {
    const candidate = findCandidate()
    if (candidate) return { socketPath: candidate.socketPath, spawned: false, manifest: candidate }
    await new Promise(resolve => setTimeout(resolve, 50))
    lock = await acquireSupervisorLock(lockPath)
  }
  try {
    const candidate = findCandidate()
    if (candidate) return { socketPath: candidate.socketPath, spawned: false, manifest: candidate }
    const ownerId = `runtime-${randomUUID().replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 48)}`
    const ownerDirectory = path.join(runtimeRegistryDirectory(dataDir), ownerId)
    const socketPath = runtimeSocketPath(dataDir, ownerId)
    const pidPath = path.join(ownerDirectory, "runtime.pid")
    const manifestPath = path.join(ownerDirectory, "manifest.json")
    fs.mkdirSync(ownerDirectory, { recursive: true })
    spawnSupervisorProcess(dataDir, socketPath, pidPath, null, {
      ownerId,
      runtimeManifestPath: manifestPath,
    })
    if (!(await waitForSupervisor(socketPath, 8_000))) {
      throw new Error("pty supervisor generation did not become ready")
    }
    const deadline = Date.now() + 8_000
    let manifest: TerminalRuntimeManifest | null = null
    while (Date.now() < deadline) {
      manifest = registry.readManifest(manifestPath)
      if (manifest) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    if (!manifest) throw new Error("pty supervisor generation manifest is unavailable")
    if (!runtimeSupports(manifest, requiredProtocol, options.requiredCapabilities)) {
      throw new Error("pty supervisor generation lacks the requested capabilities")
    }
    return { socketPath, spawned: true, manifest }
  } finally {
    await lock.close()
    try { fs.unlinkSync(lockPath) } catch { /* another starter may have cleaned it */ }
  }
}

export async function ensureTerminalSupervisor(
  dataDir: string,
): Promise<{ socketPath: string; spawned: boolean; manifest: SupervisorManifest | null }> {
  fs.mkdirSync(dataDir, { recursive: true })
  const socketPath = supervisorSocketPath(dataDir)
  const pidPath = supervisorPidPath(dataDir)
  const manifestPath = supervisorManifestPath(dataDir)
  const lockPath = supervisorLockPath(dataDir)

  if (await canPingSupervisor(socketPath)) {
    return { socketPath, spawned: false, manifest: readSupervisorManifest(manifestPath) }
  }

  // A live manifest with a temporarily slow socket is still an owned runtime;
  // do not start a competing supervisor merely because one ping timed out.
  const existing = readSupervisorManifest(manifestPath)
  if (existing) {
    if (
      existing.processIdentity &&
      matchesProcessIdentity(existing.processIdentity)
    ) {
      if (await waitForSupervisor(socketPath, 8_000)) {
        return { socketPath, spawned: false, manifest: readSupervisorManifest(manifestPath) }
      }
      throw new Error("pty supervisor is alive but did not accept a handshake")
    }
    // A legacy/migrated manifest without an OS identity cannot be proven
    // stale. Waiting is safer than unlinking a socket owned by a live process.
    if (!existing.processIdentity) {
      if (await waitForSupervisor(socketPath, 8_000)) {
        return { socketPath, spawned: false, manifest: readSupervisorManifest(manifestPath) }
      }
      throw new Error("pty supervisor identity is unavailable")
    }
  }

  let lock = await acquireSupervisorLock(lockPath)
  while (!lock) {
    if (await canPingSupervisor(socketPath)) {
      return { socketPath, spawned: false, manifest: readSupervisorManifest(manifestPath) }
    }
    await new Promise(resolve => setTimeout(resolve, 50))
    lock = await acquireSupervisorLock(lockPath)
  }

  let spawned = false
  try {
    if (await canPingSupervisor(socketPath)) {
      return { socketPath, spawned: false, manifest: readSupervisorManifest(manifestPath) }
    }
    // The lock closes the stale-owner race. Only remove paths after the
    // manifest has been proved stale or malformed.
    try { fs.unlinkSync(socketPath) } catch { /* no stale Unix socket */ }
    try { fs.unlinkSync(manifestPath) } catch { /* no stale manifest */ }
    spawnSupervisorProcess(dataDir, socketPath, pidPath, manifestPath)
    spawned = true
    if (await waitForSupervisor(socketPath, 8_000)) {
      return { socketPath, spawned, manifest: readSupervisorManifest(manifestPath) }
    }
    throw new Error("pty supervisor did not become ready")
  } finally {
    await lock.close()
    try { fs.unlinkSync(lockPath) } catch { /* another starter may have cleaned it */ }
  }
}

async function canPingSupervisor(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ path: socketPath })
    const reader = new SupervisorFrameReader()
    const timeout = setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, 400)
    socket.on("connect", () => {
      socket.write(
        encodeSupervisorFrame({ kind: "req", id: 1, op: "ping", args: [] }),
      )
    })
    socket.on("data", (chunk) => {
      try {
        const messages = reader.push(chunk)
        if (messages.some((message) => {
          if (message === null || typeof message !== "object" || Array.isArray(message)) return false
          if (!("kind" in message) || !("ok" in message)) return false
          return (message.kind === "res" || message.kind === "response") && message.ok === true
        })) {
          clearTimeout(timeout)
          socket.end()
          resolve(true)
        }
      } catch {
        clearTimeout(timeout)
        socket.destroy()
        resolve(false)
      }
    })
    socket.on("error", () => {
      clearTimeout(timeout)
      resolve(false)
    })
  })
}

function resolveSupervisorArgs(
  socketPath: string,
  pidPath: string,
  manifestPath: string | null,
  generation?: { readonly ownerId: string; readonly runtimeManifestPath: string },
): string[] | null {
  const entry = fileURLToPath(new URL("./pty-supervisor-bin.ts", import.meta.url))
  const compiled = entry.replace(/\.ts$/, ".js")
  const packaged = path.join(path.dirname(fileURLToPath(import.meta.url)), "pty-supervisor.mjs")
  const runTs = path.resolve(path.dirname(entry), "../../../scripts/run-ts.mjs")
  const script = fs.existsSync(packaged)
    ? [packaged]
    : fs.existsSync(runTs) && fs.existsSync(entry)
      ? [runTs, entry]
      : fs.existsSync(compiled)
        ? [compiled]
        : null
  if (!script) return null
  const args = [
    ...script,
    "--socket",
    socketPath,
    "--pid-file",
    pidPath,
  ]
  if (manifestPath) args.push("--manifest", manifestPath)
  if (generation) {
    args.push("--owner-id", generation.ownerId, "--runtime-manifest", generation.runtimeManifestPath)
  }
  return args
}

function supervisorExecutable(): string {
  const configured = process.env.YAADE_NODE_EXECUTABLE ?? process.env.npm_node_execpath
  if (configured) return configured
  if (typeof process.versions.bun !== "string") return process.execPath

  // Bun can host the server, but node-pty children spawned by a Bun-hosted
  // supervisor receive an immediate SIGHUP on macOS. Keep the supervisor on
  // Node so PTY process groups have the same behavior in dev and production.
  const lookup = process.platform === "win32" ? "where.exe" : "which"
  try {
    const result = spawnSync(lookup, ["node"], { encoding: "utf8" })
    if (result.status === 0) {
      const executable = result.stdout
        .split(/\r?\n/u)
        .map(value => value.trim())
        .find(value => value.length > 0)
      if (executable) return executable
    }
  } catch {
    /* Fall through to the current runtime when Node cannot be located. */
  }
  return process.execPath
}

function spawnSupervisorProcess(
  dataDir: string,
  socketPath: string,
  pidPath: string,
  manifestPath: string | null,
  generation?: { readonly ownerId: string; readonly runtimeManifestPath: string },
): ChildProcess {
  const args = resolveSupervisorArgs(socketPath, pidPath, manifestPath, generation)
  if (!args) {
    throw new Error("cannot spawn pty supervisor: Vite+ TypeScript runner is unavailable")
  }
  const logPath = process.env.YAADE_PTY_SUPERVISOR_LOG ?? path.join(dataDir, "supervisor.log")
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  const logFd = fs.openSync(logPath, "a")
  const child = spawn(supervisorExecutable(), args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, YAADE_PTY_SUPERVISOR_DATA_DIR: dataDir },
  })
  fs.closeSync(logFd)
  child.unref()
  return child
}
