import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Effect, ManagedRuntime, Schema } from "effect";
import { WebSocketServer, WebSocket } from "ws";
import { fileUriToPath } from "@yaade/shared"
import {
  decodeHostRouteArgs,
  HostRpcRequest,
  InvalidRpcPayloadError,
  PathOutsideRootsError,
  encodeTerminalDataFrame,
  encodeTerminalStreamV3,
  TerminalSemanticPatch,
  TerminalSemanticSnapshot,
  terminalAttachControlResult,
  hostErrorHttpStatus,
  getHostRoute,
  hostErrorWire,
  tryDecodeTerminalWsAck,
  tryDecodeTerminalWsCommand,
  ScopeDeniedError,
  type HostRpcError,
} from "@yaade/rpc";
import type { HostEvent } from "./events.js";
import type { HostConfig } from "./config.js";
import { dispatch } from "./dispatch.js";
import { makeHostLayers, type HostLayerServices } from "./effect/layers.js";
import { HostRuntimeTag } from "./effect/tags.js";
import {
  buildRuntimeSnapshot,
  shutdownRuntime,
  type HostRuntime,
} from "./host-runtime.js";
import { pathAllowed } from "./sandbox.js";
import {
  isAllowedCorsOrigin,
  isAllowedWebSocketOrigin,
  isAuthorizedRequest,
  isLoopbackHostname,
  requestAuthToken,
  tokensEqual,
} from "./security.js";
import {
  makeHostTokenPrincipal,
  makeLocalDevelopmentPrincipal,
  makePairedDevicePrincipal,
  RequestPrincipalRegistry,
  type RequestPrincipal,
} from "./principal.js"
import { principalMayInvoke, principalMayUseCapability } from "./route-policy.js";
import { httpRouteCapability } from "./http-route-policy.js";
import { diagnosticBundle } from "./diagnostics.js";
import { ClientSocketWriter } from "./ws/client-socket-writer.js";
import { TerminalFlowControl } from "./ws/terminal-flow-control.js";
import {
  removeDaemonRuntimeManifest,
  writeDaemonRuntimeManifest,
} from "./runtime-manifest.js";

const VERSION = "0.0.1";
const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;
/** Bound concurrent /api/v1/rpc handlers to avoid stampede spikes. */
const MAX_INFLIGHT_RPC = 32;
const MAX_WS_COMMAND_QUEUE = 64;
const MAX_WS_PAYLOAD_BYTES = 1024 * 1024;
const configuredTerminalFlowBytes = Number(
  process.env.YAADE_TERMINAL_UNACKNOWLEDGED_BYTES,
);
const MAX_TERMINAL_UNACKNOWLEDGED_BYTES =
  Number.isSafeInteger(configuredTerminalFlowBytes) &&
  configuredTerminalFlowBytes >= 64 * 1024
    ? configuredTerminalFlowBytes
    : 8 * 1024 * 1024;
const LEGACY_PROTOCOL_SOCKETS = new WeakSet<WebSocket>();
const DEVICE_EVENT_SOCKETS = new WeakMap<WebSocket, { deviceId: string }>();
const ACTIVE_EVENT_SOCKETS = new Set<WebSocket>();
const CLIENT_SOCKETS = new Map<string, WebSocket>();
const PENDING_AUTH_SOCKETS = new Set<WebSocket>();
const MAX_PENDING_AUTH_SOCKETS = 64;
const SOCKET_WRITERS = new WeakMap<WebSocket, ClientSocketWriter>();

function socketWriter(ws: WebSocket): ClientSocketWriter {
  const existing = SOCKET_WRITERS.get(ws);
  if (existing) return existing;
  const writer = new ClientSocketWriter({
    get readyState() {
      return ws.readyState;
    },
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
    send(data, cb) {
      // Compress low-rate JSON control frames, but never binary terminal
      // traffic. Deflating rapid semantic/output frames serializes them behind
      // zlib and can make a healthy browser look like a slow consumer.
      ws.send(
        typeof data === "string" ? data : Buffer.from(data),
        { compress: typeof data === "string" },
        cb,
      );
    },
    close(code, reason) {
      ws.close(code, reason);
    },
    terminate() {
      ws.terminate();
    },
  });
  SOCKET_WRITERS.set(ws, writer);
  return writer;
}

function sendSocketFrame(ws: WebSocket, data: string | Uint8Array): boolean {
  return socketWriter(ws).enqueueReliable(data);
}

function sendReliableSocketJson(ws: WebSocket, value: unknown): boolean {
  return socketWriter(ws).enqueueReliable(JSON.stringify(value));
}

function enqueueSemanticResyncNotices(
  writer: ClientSocketWriter,
  runtime: Pick<HostRuntime, "terminal"> | undefined,
  satisfiedTerminalId?: string,
): void {
  for (const terminalId of writer.consumeResyncRequired()) {
    // A full snapshot queued for this terminal already satisfies any patch
    // replacement marker. Sending another resync notice would create an
    // attach/snapshot loop, especially when a grid exceeds the frame budget.
    if (terminalId === satisfiedTerminalId) continue
    const inspected = runtime?.terminal.inspect(terminalId)
    const snapshot = runtime?.terminal.readSemanticSnapshot(terminalId)
    if (!inspected?.terminalEpoch || !snapshot) continue
    try {
      writer.enqueueReliable(
        encodeTerminalStreamV3({
          type: "terminal.resync-required",
          terminalId,
          terminalEpoch: inspected.terminalEpoch,
          latestRevision: snapshot.revision,
        }),
      )
    } catch {
      // A later semantic update or explicit attach will request the same
      // authoritative snapshot; never let one malformed render frame break
      // reliable control traffic for the socket.
    }
  }
}

function enqueueSemanticSnapshot(
  writer: ClientSocketWriter,
  runtime: Pick<HostRuntime, "terminal" | "identity">,
  terminalId: string,
): void {
  const inspected = runtime.terminal.inspect(terminalId)
  const snapshot = runtime.terminal.readSemanticSnapshot(terminalId)
  if (!inspected?.terminalEpoch || !snapshot) return
  try {
    writer.enqueueSemanticRender(
      terminalId,
      encodeTerminalStreamV3({
        type: "terminal.snapshot",
        terminalId,
        ownerEpoch: runtime.identity.serverEpoch,
        terminalEpoch: inspected.terminalEpoch,
        revision: snapshot.revision,
        snapshot,
      }),
    )
    enqueueSemanticResyncNotices(writer, runtime, terminalId)
  } catch {
    // Raw replay remains available when an individual semantic snapshot cannot
    // be encoded within the negotiated frame limit.
  }
}

function runtimeOwnerEpoch(runtime: HostRuntime): string {
  return runtime.identity.serverEpoch;
}

function logUnexpectedWebSocketClose(details: {
  readonly code: number;
  readonly reason: string;
  readonly bufferedBytes: number;
  readonly pendingBytes: number;
  readonly terminalId: string | null;
  readonly ownerEpoch: string | null;
}): void {
  if (details.code === 1000 || details.code === 1001) return;
  console.warn(
    JSON.stringify({
      event: "yaade.websocket.close",
      code: details.code,
      reason: details.reason,
      bufferedBytes: details.bufferedBytes,
      pendingBytes: details.pendingBytes,
      terminalId: details.terminalId,
      ownerEpoch: details.ownerEpoch,
    }),
  );
}

function disposeSocketWriter(
  runtime: HostRuntime,
  ws: WebSocket,
  attachedTerminals: Set<string>,
  code?: number,
  reasonBuf?: Buffer,
): void {
  const writer = SOCKET_WRITERS.get(ws);
  const terminalId =
    [...attachedTerminals][0] ?? writer?.currentTerminalId ?? null;
  logUnexpectedWebSocketClose({
    code: code ?? 1006,
    reason: reasonBuf?.toString("utf8") ?? "",
    bufferedBytes: ws.bufferedAmount,
    pendingBytes: writer?.pendingBytes ?? 0,
    terminalId,
    ownerEpoch: runtimeOwnerEpoch(runtime),
  });
  writer?.dispose();
  SOCKET_WRITERS.delete(ws);
}

async function releaseClosedWriter(
  runtime: HostRuntime,
  terminalId: string,
  clientId: string,
): Promise<void> {
  const writer = await Promise.resolve(runtime.terminal.currentWriterLease(terminalId))
  if (!writer || writer.connectionId === clientId) return
  const socket = CLIENT_SOCKETS.get(writer.connectionId)
  if (socket && socket.readyState !== WebSocket.OPEN) {
    await Promise.resolve(runtime.terminal.releaseConnection(writer.connectionId))
  }
}

function closeDeviceEventSockets(deviceId: string): void {
  for (const socket of ACTIVE_EVENT_SOCKETS) {
    if (DEVICE_EVENT_SOCKETS.get(socket)?.deviceId === deviceId && socket.readyState === WebSocket.OPEN) {
      socket.close(4003, "access revoked");
    }
  }
}

function originDenied(origin: string | undefined, bindHost: string, corsOrigins: readonly string[]): boolean {
  if (!origin) return false;
  if (!isAllowedCorsOrigin(origin, corsOrigins)) return true;
  if (isLoopbackHostname(bindHost)) return false;
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && !isLoopbackHostname(url.hostname);
  } catch {
    return true;
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function runHostRpc(
  managed: ManagedRuntime.ManagedRuntime<HostLayerServices, never>,
  channel: string,
  args: unknown[],
  principal: RequestPrincipal,
  signal?: AbortSignal,
): Promise<{ ok: true; value: unknown } | { ok: false; error: HostRpcError }> {
  return managed.runPromise(
    dispatch(channel, args, principal, signal).pipe(
      Effect.map((value) => ({ ok: true as const, value })),
      Effect.catchAll((error) => Effect.succeed({ ok: false as const, error })),
    ),
  );
}

export async function startHostServer(
  config: HostConfig,
  options?: { eventHubCapacity?: number },
): Promise<{
  runtime: HostRuntime;
  close: () => Promise<void>;
  port: number;
}> {
  const hostLayer = makeHostLayers(config, options);
  /** Keeps the Layer scope open for the process lifetime (TerminalHost acquireRelease). */
  const managed = ManagedRuntime.make(hostLayer);
  const runtime = await managed.runPromise(
    Effect.gen(function* () {
      return yield* HostRuntimeTag;
    }),
  );
  const requestPrincipalRegistry = new RequestPrincipalRegistry();
  let inflightRpc = 0;

  const server = createServer(async (req, res) => {
    try {
      await handleHttp(runtime, managed, req, res, {
        getInflightRpc: () => inflightRpc,
        beginRpc: () => {
          if (inflightRpc >= MAX_INFLIGHT_RPC) return false;
          inflightRpc += 1;
          return true;
        },
        endRpc: () => {
          inflightRpc = Math.max(0, inflightRpc - 1);
        },
        principalRegistry: requestPrincipalRegistry,
      });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      sendJson(res, status, {
        error: {
          code: "OPERATION_FAILED",
          message: String(error),
          details: {},
        },
      });
    }
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_PAYLOAD_BYTES,
    // Compression is negotiated for JSON control traffic only. Binary terminal
    // frames opt out per send so zlib cannot block the socket writer hot path.
    perMessageDeflate: {
      threshold: 1024,
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
    },
  });

  server.on("upgrade", (req, socket, head) => {
    if (
      !isAllowedWebSocketOrigin(
        req.headers.origin,
        req.headers.host,
        runtime.config.corsOrigins,
      )
    ) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );
    const protocol = url.searchParams.get("protocol");
    if (url.pathname === "/ws" && protocol && protocol !== "1" && protocol !== "2") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.close(4002, "incompatible protocol");
      });
      return;
    }
    if (
      !isRuntimeAuthorized(runtime, req, url) &&
      protocol !== "2"
    ) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (url.pathname === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleEventSocket(runtime, managed, ws, url, requestPrincipalRegistry);
      });
      return;
    }
    socket.destroy();
  });

  const boundPort = await listenPreferringPort(
    server,
    config.host,
    config.port,
  );
  config.port = boundPort;

  writeDaemonRuntimeManifest(config.dataDir, runtime.identity, boundPort);
  console.log(
    `[host-server] listening on http://${config.host}:${config.port}`,
  );

  let closePromise: Promise<void> | null = null;
  const close = () => {
    closePromise ??= (async () => {
      await shutdownRuntime(runtime);
      const serverClosed = new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      server.closeAllConnections?.();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await serverClosed;
      removeDaemonRuntimeManifest(config.dataDir, runtime.identity.serverEpoch);
      await managed.dispose();
    })();
    return closePromise;
  };

  return { runtime, close, port: boundPort };
}

const PORT_FALLBACK_ATTEMPTS = 50;

function isAddrInUse(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EADDRINUSE"
  );
}

function listenOnPort(
  server: ReturnType<typeof createServer>,
  port: number,
  host: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.listen(port, host, onListening);
  });
}

async function closeServerQuietly(
  server: ReturnType<typeof createServer>,
): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function boundListenPort(
  server: ReturnType<typeof createServer>,
  fallback: number,
): number {
  const address = server.address();
  return address && typeof address === "object" ? address.port : fallback;
}

/** Bind `preferredPort`, or the next free ports, instead of failing on EADDRINUSE. */
async function listenPreferringPort(
  server: ReturnType<typeof createServer>,
  host: string,
  preferredPort: number,
  maxAttempts = PORT_FALLBACK_ATTEMPTS,
): Promise<number> {
  if (preferredPort === 0) {
    await listenOnPort(server, 0, host);
    const bound = boundListenPort(server, 0);
    if (bound === 0) {
      throw new Error("Could not determine bound host-server port");
    }
    return bound;
  }

  let port = preferredPort;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await listenOnPort(server, port, host);
      const bound = boundListenPort(server, port);
      if (bound !== preferredPort) {
        console.warn(
          `[host-server] port ${preferredPort} busy; listening on ${bound}`,
        );
      }
      return bound;
    } catch (error) {
      if (!isAddrInUse(error)) throw error;
      await closeServerQuietly(server);
      port += 1;
    }
  }
  throw new Error(
    `Could not bind host-server near port ${preferredPort} after ${maxAttempts} attempts`,
  );
}

type RpcGate = {
  getInflightRpc: () => number;
  beginRpc: () => boolean;
  endRpc: () => void;
  principalRegistry: RequestPrincipalRegistry;
};

function isRuntimeAuthorized(
  runtime: HostRuntime,
  req: IncomingMessage,
  url: URL,
): boolean {
  if (isAuthorizedRequest(req, runtime.config.authToken, url)) return true
  const token = requestAuthToken(req, url)
  return Boolean(token && runtime.devices.session(token))
}

function principalForToken(
  runtime: HostRuntime,
  token: string | null,
  connectionId: string,
  registry?: RequestPrincipalRegistry,
  correlationId?: string | null,
): RequestPrincipal | null {
  const principal = runtime.config.authToken && token && tokensEqual(runtime.config.authToken, token)
    ? makeHostTokenPrincipal(connectionId)
    : token
      ? (() => {
          const session = runtime.devices.session(token)
          return session
            ? makePairedDevicePrincipal(session.deviceId, session.scopes, connectionId)
            : null
        })()
      : !runtime.config.authToken && isLoopbackHostname(runtime.config.host)
        ? makeLocalDevelopmentPrincipal(connectionId)
        : null
  return principal && registry
    ? registry.resolve(principal, correlationId ?? null)
    : principal
}

function principalForRequest(
  runtime: HostRuntime,
  req: IncomingMessage,
  url: URL,
  connectionId = randomUUID(),
  registry?: RequestPrincipalRegistry,
  correlationId?: string | null,
): RequestPrincipal | null {
  const principal = principalForToken(runtime, requestAuthToken(req, url), connectionId)
  return principal && registry
    ? registry.resolve(principal, correlationId ?? null)
    : principal
}

function runtimeHealth(runtime: HostRuntime) {
  let databaseStatus: "healthy" | "degraded" = "healthy";
  try {
    runtime.db.session().prepare("SELECT 1").get();
  } catch {
    databaseStatus = "degraded";
  }
  let storageStatus: "healthy" | "degraded" = "healthy";
  let storageMessage = "runtime storage is available";
  try {
    fs.accessSync(runtime.config.dataDir, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    storageStatus = "degraded";
    storageMessage = "runtime storage probe failed";
  }
  const eventLoopStatus = "healthy" as const
  const eventLoopMessage = "health request served on the HTTP event loop";
  const degraded = databaseStatus === "degraded" || storageStatus === "degraded";
  const unhealthy = databaseStatus === "degraded";
  return {
    status: unhealthy ? "unhealthy" : degraded ? "degraded" : "healthy",
    database: { status: databaseStatus, message: databaseStatus === "healthy" ? "SQLite WAL is available" : "SQLite probe failed" },
    eventLoop: { status: eventLoopStatus, message: eventLoopMessage },
    storage: { status: storageStatus, message: storageMessage },
    connectedClients: ACTIVE_EVENT_SOCKETS.size,
    runningTerminals: runtime.muxSessions.listSessions(false).reduce(
      (count, session) => count + runtime.muxSessions.listMuxTerminals(session.id).filter(terminal => terminal.status === "running").length,
      0,
    ),
  } as const;
}

function serverCapabilities(runtime: HostRuntime) {
  const platform = process.platform === "win32"
    ? "windows"
    : process.platform === "darwin"
      ? "darwin"
      : "linux";
  return {
    serverId: runtime.identity.serverId,
    serverEpoch: runtime.identity.serverEpoch,
    protocolVersions: [1, 2],
    preferredProtocolVersion: 2,
    runtimeVersion: runtime.identity.runtimeVersion,
    platform,
    features: {
      runtimeSnapshot: true,
      terminalCheckpoints: runtime.config.features.terminalCheckpoints,
      writerLeases: true,
      deviceAuthentication: true,
      persistedTerminalHistory: false,
    },
    limits: {
      maxTerminals: 64,
      maxReplayBytes: 2 * 1024 * 1024,
      maxWsPayloadBytes: MAX_WS_PAYLOAD_BYTES,
    },
  };
}

async function handleHttp(
  runtime: HostRuntime,
  managed: ManagedRuntime.ManagedRuntime<HostLayerServices, never>,
  req: IncomingMessage,
  res: ServerResponse,
  rpcGate: RpcGate,
): Promise<void> {
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`,
  );
  const { pathname } = url;
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  const corsAllowed = isAllowedCorsOrigin(origin, runtime.config.corsOrigins);
  if (origin && corsAllowed) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "Origin");
    res.setHeader("access-control-allow-headers", "content-type, authorization, x-yaade-token");
    res.setHeader("access-control-allow-methods", "GET, POST, PUT, OPTIONS");
  }
  if (req.method === "OPTIONS" && pathname.startsWith("/api")) {
    res.writeHead(corsAllowed ? 204 : 403);
    res.end();
    return;
  }

  if (
    pathname.startsWith("/api") &&
    originDenied(origin, runtime.config.host, runtime.config.corsOrigins ?? [])
  ) {
    sendJson(res, 403, {
      error: {
        code: "ORIGIN_DENIED",
        message: "origin is not allowed",
        details: {},
      },
    });
    return;
  }

  if (req.method === "GET" && pathname === "/health") {
    sendJson(res, 200, {
      status: "ok",
      version: VERSION,
      identity: runtime.identity,
      health: runtimeHealth(runtime),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/v1/security/pair") {
    try {
      const body = await readJson(req)
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid pairing body")
      const record = body as Record<string, unknown>
      const paired = runtime.devices.pair({
        code: typeof record.code === "string" ? record.code : "",
        deviceId: typeof record.deviceId === "string" ? record.deviceId : undefined,
        name: typeof record.name === "string" ? record.name : "",
        publicKey: record.publicKey,
        algorithm: typeof record.algorithm === "string" ? record.algorithm : "Ed25519",
        scopes: Array.isArray(record.scopes)
          ? record.scopes.filter((scope): scope is "observe" | "control" | "admin" =>
              scope === "observe" || scope === "control" || scope === "admin",
            )
          : undefined,
      })
      sendJson(res, 201, paired)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, message.includes("too many") ? 429 : 400, {
        error: {
          code: message.includes("too many") ? "RATE_LIMITED" : "PAIRING_FAILED",
          message,
          details: {},
        },
      })
    }
    return
  }

  if (req.method === "POST" && pathname === "/api/v1/security/challenge") {
    try {
      const body = await readJson(req)
      const deviceId =
        body && typeof body === "object" && !Array.isArray(body) && typeof (body as Record<string, unknown>).deviceId === "string"
          ? (body as Record<string, unknown>).deviceId as string
          : ""
      sendJson(res, 200, runtime.devices.challenge(deviceId))
    } catch (error) {
      sendJson(res, 401, {
        error: { code: "DEVICE_AUTH_FAILED", message: error instanceof Error ? error.message : String(error), details: {} },
      })
    }
    return
  }

  if (req.method === "POST" && pathname === "/api/v1/security/session") {
    try {
      const body = await readJson(req)
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid session body")
      const record = body as Record<string, unknown>
      const session = runtime.devices.authenticate({
        deviceId: typeof record.deviceId === "string" ? record.deviceId : "",
        nonce: typeof record.nonce === "string" ? record.nonce : "",
        signature: typeof record.signature === "string" ? record.signature : "",
      })
      sendJson(res, 200, session)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, message.includes("too many") ? 429 : 401, {
        error: {
          code: message.includes("too many") ? "RATE_LIMITED" : "DEVICE_AUTH_FAILED",
          message,
          details: {},
        },
      })
    }
    return
  }

  if (
    pathname.startsWith("/api") &&
    !isRuntimeAuthorized(runtime, req, url)
  ) {
    sendJson(res, 401, {
      error: {
        code: "UNAUTHORIZED",
        message: "host token required",
        details: {},
      },
    });
    return;
  }

  const httpCapability = httpRouteCapability(pathname, req.method ?? "GET")
  if (httpCapability) {
    const principal = principalForRequest(runtime, req, url, randomUUID())
    if (!principal || !principalMayUseCapability(principal, httpCapability)) {
      sendJson(res, 403, {
        error: {
          code: "SCOPE_DENIED",
          message: `route requires ${httpCapability} capability`,
          details: {},
        },
      })
      return
    }
  }

  if (req.method === "POST" && pathname === "/api/v1/security/pairing-code") {
    const principal = principalForRequest(
      runtime,
      req,
      url,
      randomUUID(),
      rpcGate.principalRegistry,
      "security:pairing-code",
    )
    if (!principal || !principalMayUseCapability(principal, "local-admin")) {
      sendJson(res, 403, {
        error: {
          code: "SCOPE_DENIED",
          message: "admin pairing requires a local administrator",
          details: {},
        },
      })
      return
    }
    try {
      sendJson(res, 201, runtime.devices.createPairingCode())
    } catch (error) {
      sendJson(res, 400, {
        error: { code: "PAIRING_FAILED", message: error instanceof Error ? error.message : String(error), details: {} },
      })
    }
    return
  }

  if (req.method === "GET" && pathname === "/api/v1/security/devices") {
    const principal = principalForRequest(
      runtime,
      req,
      url,
      randomUUID(),
      rpcGate.principalRegistry,
      "security:devices",
    )
    if (!principal || !principalMayUseCapability(principal, "admin")) {
      sendJson(res, 403, {
        error: { code: "SCOPE_DENIED", message: "admin scope required", details: {} },
      })
      return
    }
    sendJson(res, 200, runtime.devices.list())
    return
  }

  const revokeDevice = /^\/api\/v1\/security\/devices\/([^/]+)$/.exec(pathname)
  if (req.method === "DELETE" && revokeDevice) {
    const principal = principalForRequest(
      runtime,
      req,
      url,
      randomUUID(),
      rpcGate.principalRegistry,
      "security:revoke-device",
    )
    if (!principal || !principalMayUseCapability(principal, "admin")) {
      sendJson(res, 403, {
        error: { code: "SCOPE_DENIED", message: "admin scope required", details: {} },
      })
      return
    }
    const deviceId = decodeURIComponent(revokeDevice[1] ?? "")
    runtime.devices.revoke(deviceId)
    closeDeviceEventSockets(deviceId)
    res.writeHead(204)
    res.end()
    return
  }

  if (req.method === "POST" && pathname === "/api/v1/security/session/rotate") {
    const token = requestAuthToken(req, url)
    try {
      if (!token) throw new Error("unknown session")
      sendJson(res, 200, runtime.devices.rotate(token))
    } catch (error) {
      sendJson(res, 401, {
        error: {
          code: "DEVICE_AUTH_FAILED",
          message: error instanceof Error ? error.message : String(error),
          details: {},
        },
      })
    }
    return
  }

  if (req.method === "GET" && pathname === "/api/v1/system") {
    sendJson(res, 200, {
      name: "YAADE",
      version: VERSION,
      protocolVersion: 2,
      identity: runtime.identity,
      capabilities: serverCapabilities(runtime),
      serverId: runtime.identity.serverId,
      serverEpoch: runtime.identity.serverEpoch,
      launchConfig: runtime.config.launchConfig,
      homeDir: runtime.homeDir,
      machineHostname: runtime.machineHostname,
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/v1/diagnostics") {
    sendJson(
      res,
      200,
      diagnosticBundle(
        {
          generatedAt: new Date().toISOString(),
          identity: runtime.identity,
          health: runtimeHealth(runtime),
          config: {
            host: runtime.config.host,
            port: runtime.config.port,
            features: runtime.config.features,
          },
          devices: runtime.devices.list().map(device => ({
            id: device.id,
            name: device.name,
            scopes: device.scopes,
            revokedAt: device.revokedAt,
          })),
          capabilities: serverCapabilities(runtime),
        },
        [runtime.config.authToken ?? ""],
      ),
    );
    return;
  }

  if (req.method === "POST" && pathname === "/api/v1/rpc") {
    if (!rpcGate.beginRpc()) {
      sendJson(res, 503, {
        error: {
          code: "HOST_BUSY",
          message: `too many in-flight RPCs (max ${MAX_INFLIGHT_RPC})`,
          details: { inflight: rpcGate.getInflightRpc() },
        },
      });
      return;
    }
    const requestAbort = new AbortController();
    const abortRequest = () =>
      requestAbort.abort(new Error("RPC request disconnected"));
    const abortOnResponseClose = () => {
      if (!res.writableEnded) abortRequest();
    };
    req.once("aborted", abortRequest);
    res.once("close", abortOnResponseClose);
    try {
      const body = await readJson(req);
      const decoded = Schema.decodeUnknownEither(HostRpcRequest)(body);
      if (decoded._tag === "Left") {
        const error = new InvalidRpcPayloadError({
          message: "invalid rpc body",
          cause: decoded.left,
        });
        const wire = hostErrorWire(error);
        sendJson(res, hostErrorHttpStatus(error), { error: wire });
        return;
      }
      const { channel, args, clientId } = decoded.right;
      const principal = principalForRequest(
        runtime,
        req,
        url,
        randomUUID(),
        rpcGate.principalRegistry,
        clientId,
      );
      if (!principal) {
        sendJson(res, 401, {
          error: {
            code: "UNAUTHORIZED",
            message: "request principal could not be resolved",
            details: {},
          },
        });
        return;
      }
      if (!principalMayInvoke(principal, channel)) {
        const error = new ScopeDeniedError({
          message: "principal does not have the capability for this operation",
          channel,
        });
        sendJson(res, hostErrorHttpStatus(error), { error: hostErrorWire(error) });
        return;
      }
      let rpcArgs: unknown[];
      try {
        rpcArgs = decodeHostRouteArgs(channel, [...args]);
      } catch (cause) {
        const error = new InvalidRpcPayloadError({
          message: `invalid arguments for host route ${channel}`,
          cause,
        });
        const wire = hostErrorWire(error);
        sendJson(res, hostErrorHttpStatus(error), { error: wire });
        return;
      }
      const pathError = validateRpcPaths(runtime.config, channel, rpcArgs);
      if (pathError) {
        const wire = hostErrorWire(pathError);
        sendJson(res, hostErrorHttpStatus(pathError), { error: wire });
        return;
      }
      const result = await runHostRpc(
        managed,
        channel,
        rpcArgs,
        principal,
        requestAbort.signal,
      );
      if (result.ok) {
        sendJson(res, 200, { value: result.value });
        return;
      }
      const wire = hostErrorWire(result.error);
      sendJson(res, hostErrorHttpStatus(result.error), { error: wire });
    } finally {
      req.removeListener("aborted", abortRequest);
      res.removeListener("close", abortOnResponseClose);
      rpcGate.endRpc();
    }
    return;
  }

  if (req.method === "GET" && runtime.config.staticDir) {
    if (serveStatic(runtime.config.staticDir, pathname, req, res)) return;
  }

  sendJson(res, 404, {
    error: { code: "NOT_FOUND", message: `no route ${pathname}`, details: {} },
  });
}

function handleEventSocket(
  runtime: HostRuntime,
  managed: ManagedRuntime.ManagedRuntime<HostLayerServices, never>,
  ws: WebSocket,
  url: URL,
  principalRegistry: RequestPrincipalRegistry,
): void {
  const protocol = url.searchParams.get("protocol");
  if (protocol && protocol !== "1" && protocol !== "2") {
    ws.close(4002, "incompatible protocol");
    return;
  }
  if (protocol === "2") {
    handleModernEventSocket(runtime, managed, ws, url, principalRegistry)
    return
  }
  const requestedClientId = url.searchParams.get("clientId")
  const principal = principalForToken(
    runtime,
    url.searchParams.get("token"),
    randomUUID(),
    principalRegistry,
    requestedClientId && /^[A-Za-z0-9-]{1,128}$/u.test(requestedClientId)
      ? requestedClientId
      : null,
  )
  if (!principal) {
    ws.close(4003, "authentication required")
    return
  }
  handleLegacyEventSocket(runtime, managed, ws, url, principal)
}

function handleLegacyEventSocket(
  runtime: HostRuntime,
  managed: ManagedRuntime.ManagedRuntime<HostLayerServices, never>,
  ws: WebSocket,
  url: URL,
  principal: RequestPrincipal,
): void {
  const since = Number(url.searchParams.get("since") ?? "0") || 0;
  if (url.searchParams.get("protocol") === "1") LEGACY_PROTOCOL_SOCKETS.add(ws);
  // The URL clientId is correlation data only. Authority identity comes from
  // the server-created connection principal.
  const clientId = principal.connectionId;
  // Subscribe before taking the replay snapshot. Events emitted while the
  // synchronous replay frames are being sent are buffered and delivered after
  // them; subscribing after replay creates a reconnect window that silently
  // drops state changes.
  let replaying = true;
  const pendingEvents: HostEvent[] = [];
  const attachedTerminals = new Set<string>();
  const unsubscribe = runtime.events.subscribe((event) => {
    if (event.channel === "terminal:data") {
      const id = String(event.args[0] ?? "");
      const known = attachedTerminals.has(id);
      if (!known) return;
    }
    if (replaying) {
      pendingEvents.push(event);
      return;
    }
    sendEventSocketMessage(ws, event, runtime, attachedTerminals);
  });
  const replay = runtime.events.replayWindow(since);
  if (replay.historyEvicted) {
    sendEventSocketMessage(ws, {
      protocolVersion: 1,
      sequence: replay.replayFloor - 1,
      channel: "protocol:replay-gap",
      args: [replay.replayFloor, replay.lastSequence],
    }, runtime, attachedTerminals);
  }
  for (const event of replay.events) {
    sendEventSocketMessage(ws, event, runtime, attachedTerminals);
  }
  replaying = false;
  for (const event of pendingEvents) {
    sendEventSocketMessage(ws, event, runtime, attachedTerminals);
  }
  pendingEvents.length = 0;
  ACTIVE_EVENT_SOCKETS.add(ws);
  CLIENT_SOCKETS.set(clientId, ws)
  if (principal.deviceId) DEVICE_EVENT_SOCKETS.set(ws, { deviceId: principal.deviceId });
  let commandTail = Promise.resolve();
  let commandQueue = 0;
  ws.on("message", (data) => {
    const text = typeof data === "string" ? data : wsDataToText(data);
    if (text === "ping") {
      sendSocketFrame(ws, "pong");
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return;
    }
    const cmd = tryDecodeTerminalWsCommand(raw);
    if (!cmd) return;
    const checksClosedWriter =
      cmd.op === "terminal:write" ||
      cmd.op === "terminal:writeBinary" ||
      cmd.op === "terminal:resize"
    if (commandQueue >= MAX_WS_COMMAND_QUEUE) {
      if (ws.readyState === WebSocket.OPEN) {
        sendReliableSocketJson(ws, {
          type: "terminal:result",
          requestId: cmd.requestId,
          ok: false,
          error: { code: "HOST_BUSY", message: "too many in-flight terminal commands" },
        });
      }
      return;
    }
    commandQueue += 1;
    if (cmd.op === "terminal:attach") {
      const id = cmd.args[0];
      if (typeof id === "string" && id) attachedTerminals.add(id);
    } else if (cmd.op === "terminal:detach") {
      const id = cmd.args[0]
      if (typeof id === "string" && id) attachedTerminals.delete(id)
    }
    const command = commandTail.then(async () => {
      if (checksClosedWriter && typeof cmd.args[0] === "string") {
        await releaseClosedWriter(runtime, cmd.args[0], clientId)
      }
      return runHostRpc(managed, cmd.op, cmd.args, principal)
    });
    commandTail = command.then(
      () => {
        commandQueue = Math.max(0, commandQueue - 1);
      },
      () => {
        commandQueue = Math.max(0, commandQueue - 1);
      },
    );
    void command.then((result) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (result.ok) {
        sendReliableSocketJson(ws, {
          type: "terminal:result",
          requestId: cmd.requestId,
          ok: true,
          value:
            cmd.op === "terminal:attach"
              ? terminalAttachControlResult(result.value)
              : result.value,
        });
        return;
      }
      const error = hostErrorWire(result.error);
      sendReliableSocketJson(ws, {
        type: "terminal:result",
        requestId: cmd.requestId,
        ok: false,
        error: { code: error.code, message: error.message },
      });
    });
  });
  ws.on("close", (code, reason) => {
    disposeSocketWriter(runtime, ws, attachedTerminals, code, reason);
    unsubscribe();
    LEGACY_PROTOCOL_SOCKETS.delete(ws);
    ACTIVE_EVENT_SOCKETS.delete(ws);
    DEVICE_EVENT_SOCKETS.delete(ws);
    if (CLIENT_SOCKETS.get(clientId) === ws) CLIENT_SOCKETS.delete(clientId)
    // Legacy sockets did not expose an explicit transfer command. Release
    // their writer on disconnect and promote an existing observer; this is a
    // compatibility policy, not an authorization bypass.
    void Promise.resolve(runtime.terminal.releaseConnection(clientId)).catch(() => undefined)
    void Promise.resolve(runtime.terminal.disconnectClient(clientId));
  });
}

/** Modern protocol authentication happens in-band, never in a reusable URL. */
function handleModernEventSocket(
  runtime: HostRuntime,
  managed: ManagedRuntime.ManagedRuntime<HostLayerServices, never>,
  ws: WebSocket,
  url: URL,
  principalRegistry: RequestPrincipalRegistry,
): void {
  const expectedToken = runtime.config.authToken
  const requestedClientId = url.searchParams.get("clientId")
  const correlationId = requestedClientId && /^[A-Za-z0-9-]{1,128}$/u.test(requestedClientId)
    ? requestedClientId
    : null
  if (!expectedToken) {
    const principal = principalForToken(
      runtime,
      null,
      randomUUID(),
      principalRegistry,
      correlationId,
    )
    if (!principal) {
      ws.close(4003, "authentication required")
      return
    }
    startModernEventSocket(runtime, managed, ws, url, principal)
    return
  }
  if (PENDING_AUTH_SOCKETS.size >= MAX_PENDING_AUTH_SOCKETS) {
    ws.close(1013, "too many unauthenticated connections")
    return
  }
  PENDING_AUTH_SOCKETS.add(ws)
  let authenticated = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  const finishPendingAuth = () => {
    PENDING_AUTH_SOCKETS.delete(ws)
    if (timeout) clearTimeout(timeout)
    timeout = undefined
  }
  ws.once("close", finishPendingAuth)
  timeout = setTimeout(() => {
    if (!authenticated) {
      finishPendingAuth()
      ws.close(4003, "authentication required")
    }
  }, 5_000)
  const authenticate = (data: WebSocket.RawData) => {
    const text = wsDataToText(data)
    let raw: unknown
    try { raw = JSON.parse(text) } catch { return }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return
    const record = raw as Record<string, unknown>
    if (record.type !== "protocol:auth" || typeof record.token !== "string") return
    if (
      !tokensEqual(expectedToken, record.token) &&
      !runtime.devices.session(record.token)
    ) {
      finishPendingAuth()
      ws.close(4003, "authentication failed")
      return
    }
    authenticated = true
    finishPendingAuth()
    ws.off("message", authenticate)
    const principal = principalForToken(
      runtime,
      record.token,
      randomUUID(),
      principalRegistry,
      correlationId,
    )
    if (!principal) {
      ws.close(4003, "authentication failed")
      return
    }
    startModernEventSocket(runtime, managed, ws, url, principal)
  }
  sendSocketFrame(ws, JSON.stringify({ type: "protocol:auth-required" }))
  ws.on("message", authenticate)
}

function startModernEventSocket(
  runtime: HostRuntime,
  managed: ManagedRuntime.ManagedRuntime<HostLayerServices, never>,
  ws: WebSocket,
  url: URL,
  principal: RequestPrincipal,
): void {
  // ClientId is only a namespaced correlation key. The registry maps it to a
  // server-generated identity after authentication; it never grants scope.
  const clientId = principal.connectionId;
  let synchronizing = true;
  const pendingEvents: HostEvent[] = [];
  const attachedTerminals = new Set<string>();
  const rawTerminals = new Set<string>();
  const semanticTerminals = new Set<string>();
  const terminalFlow = new TerminalFlowControl(
    MAX_TERMINAL_UNACKNOWLEDGED_BYTES,
    Math.min(
      24 * 1024 * 1024,
      MAX_TERMINAL_UNACKNOWLEDGED_BYTES * 3,
    ),
  );
  const send = (event: HostEvent) => {
    if (event.channel === "terminal:data") {
      const terminalId = String(event.args[0] ?? "");
      const output = String(event.args[1] ?? "");
      const sequence =
        typeof event.args[2] === "number" && Number.isSafeInteger(event.args[2])
          ? event.args[2]
          : 0;
      const decision = terminalFlow.reserve(
        terminalId,
        sequence,
        Buffer.byteLength(output, "utf8"),
      );
      if (!decision.accepted) {
        rawTerminals.delete(terminalId);
        sendReliableSocketJson(ws, {
          type: "terminal:replay-required",
          terminalId,
          sequence: decision.acknowledgedSequence,
        });
        return;
      }
    }
    sendEventSocketMessage(ws, event, runtime, attachedTerminals);
  };
  const unsubscribe = runtime.events.subscribe(event => {
    if (event.channel === "terminal:data") {
      const id = String(event.args[0] ?? "");
      if (!rawTerminals.has(id)) return;
    }
    if (event.channel === "terminal:semantic") {
      const id = String(event.args[0] ?? "");
      if (!semanticTerminals.has(id)) return;
    }
    if (synchronizing) pendingEvents.push(event);
    else send(event);
  });

  try {
    sendReliableSocketJson(ws, {
      type: "protocol:hello",
      identity: runtime.identity,
      capabilities: serverCapabilities(runtime),
    });
    const snapshot = buildRuntimeSnapshot(runtime);
    sendReliableSocketJson(ws, snapshot);
    const snapshotSequence = snapshot.cursor.sequence;
    synchronizing = false;
    for (const event of pendingEvents) {
      if (event.sequence > snapshotSequence) send(event);
    }
    pendingEvents.length = 0;
  } catch {
    unsubscribe();
    ws.close(1011, "snapshot failed");
    return;
  }

  ACTIVE_EVENT_SOCKETS.add(ws);
  CLIENT_SOCKETS.set(clientId, ws)
  if (principal.deviceId) DEVICE_EVENT_SOCKETS.set(ws, { deviceId: principal.deviceId });

  let commandTail = Promise.resolve();
  let commandQueue = 0;
  ws.on("message", data => {
    const text = typeof data === "string" ? data : wsDataToText(data);
    if (text === "ping") {
      sendSocketFrame(ws, "pong");
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return;
    }
    const ack = tryDecodeTerminalWsAck(raw);
    if (ack) {
      terminalFlow.acknowledge(ack.terminalId, ack.sequence);
      runtime.terminal.acknowledgeOutput(ack.terminalId, clientId, ack.sequence);
      return;
    }
    const cmd = tryDecodeTerminalWsCommand(raw);
    if (!cmd) return;
    const checksClosedWriter =
      cmd.op === "terminal:write" ||
      cmd.op === "terminal:writeBinary" ||
      cmd.op === "terminal:resize"
    if (commandQueue >= MAX_WS_COMMAND_QUEUE) {
      if (ws.readyState === WebSocket.OPEN) {
        sendReliableSocketJson(ws, {
          type: "terminal:result",
          requestId: cmd.requestId,
          ok: false,
          error: { code: "HOST_BUSY", message: "too many in-flight terminal commands" },
        });
      }
      return;
    }
    commandQueue += 1;
    if (cmd.op === "terminal:attach") {
      const id = cmd.args[0];
      if (typeof id === "string" && id) {
        attachedTerminals.add(id);
        const mode =
          cmd.args[2] === "raw" ||
          cmd.args[2] === "semantic" ||
          cmd.args[2] === "both"
            ? cmd.args[2]
            : "both";
        if (mode === "raw" || mode === "both") rawTerminals.add(id);
        if (mode === "semantic" || mode === "both") {
          semanticTerminals.add(id);
        }
        const sequence = cmd.args[1];
        if (rawTerminals.has(id)) {
          terminalFlow.reset(
            id,
            typeof sequence === "number" && Number.isSafeInteger(sequence)
              ? Math.max(0, sequence)
              : 0,
          );
        }
      }
    } else if (cmd.op === "terminal:detach") {
      const id = cmd.args[0]
      if (typeof id === "string" && id) {
        attachedTerminals.delete(id)
        rawTerminals.delete(id)
        semanticTerminals.delete(id)
        terminalFlow.delete(id)
      }
    }
    const command = commandTail.then(async () => {
      if (checksClosedWriter && typeof cmd.args[0] === "string") {
        await releaseClosedWriter(runtime, cmd.args[0], clientId)
      }
      return runHostRpc(managed, cmd.op, cmd.args, principal)
    });
    commandTail = command.then(
      () => { commandQueue = Math.max(0, commandQueue - 1) },
      () => { commandQueue = Math.max(0, commandQueue - 1) },
    );
    void command.then(result => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (result.ok) {
        sendReliableSocketJson(ws, {
          type: "terminal:result",
          requestId: cmd.requestId,
          ok: true,
          value:
            cmd.op === "terminal:attach"
              ? terminalAttachControlResult(result.value)
              : result.value,
        });
        if (
          cmd.op === "terminal:attach" &&
          typeof cmd.args[0] === "string" &&
          semanticTerminals.has(cmd.args[0])
        ) {
          enqueueSemanticSnapshot(socketWriter(ws), runtime, cmd.args[0])
        }
        return;
      }
      if (cmd.op === "terminal:attach" && typeof cmd.args[0] === "string") {
        attachedTerminals.delete(cmd.args[0])
        rawTerminals.delete(cmd.args[0])
        semanticTerminals.delete(cmd.args[0])
        terminalFlow.delete(cmd.args[0])
      }
      const error = hostErrorWire(result.error);
      sendReliableSocketJson(ws, {
        type: "terminal:result",
        requestId: cmd.requestId,
        ok: false,
        error: { code: error.code, message: error.message },
      });
    });
  });
  ws.on("close", (code, reason) => {
    disposeSocketWriter(runtime, ws, attachedTerminals, code, reason);
    unsubscribe();
    ACTIVE_EVENT_SOCKETS.delete(ws);
    DEVICE_EVENT_SOCKETS.delete(ws);
    if (CLIENT_SOCKETS.get(clientId) === ws) CLIENT_SOCKETS.delete(clientId)
    void Promise.resolve(runtime.terminal.releaseConnection(clientId)).catch(() => undefined)
    void Promise.resolve(runtime.terminal.disconnectClient(clientId));
  });
}

function sendEventSocketMessage(
  ws: WebSocket,
  event: HostEvent,
  _runtime?: Pick<HostRuntime, "terminal" | "identity">,
  _attachedTerminals?: Set<string>,
): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  const streamedTerminalId =
    event.channel === "terminal:data" || event.channel === "terminal:semantic"
      ? String(event.args[0] ?? "")
      : null
  if (
    streamedTerminalId &&
    _attachedTerminals &&
    !_attachedTerminals.has(streamedTerminalId)
  ) return
  if (event.channel === "terminal:semantic" && LEGACY_PROTOCOL_SOCKETS.has(ws)) return
  const wireEvent =
    LEGACY_PROTOCOL_SOCKETS.has(ws) && event.protocolVersion === 2
      ? {
          protocolVersion: 1,
          sequence: event.sequence,
          channel: event.channel,
          args: event.args,
        }
      : event;
  let data: string | Uint8Array = JSON.stringify(wireEvent);
  let terminalId: string | undefined;
  if (wireEvent.channel === "terminal:data") {
    terminalId = String(wireEvent.args[0] ?? "");
    const output = String(wireEvent.args[1] ?? "");
    const terminalSequence =
      typeof wireEvent.args[2] === "number" && Number.isFinite(wireEvent.args[2])
        ? wireEvent.args[2]
        : 0;
    try {
      data = encodeTerminalDataFrame(
        wireEvent.sequence,
        terminalSequence,
        terminalId,
        output,
      );
    } catch {
      // Keep the JSON event when a compatibility frame cannot be encoded.
    }
  }
  const writer = socketWriter(ws);
  if (terminalId && wireEvent.channel === "terminal:data") {
    writer.enqueueLegacyOutput(terminalId, data);
    return;
  }
  if (wireEvent.channel === "terminal:semantic") {
    const semanticId = String(wireEvent.args[0] ?? "")
    const revision = typeof wireEvent.args[1] === "number" ? wireEvent.args[1] : 0
    const terminalEpoch = String(wireEvent.args[2] ?? "")
    const update = wireEvent.args[3]
    if (semanticId && update && typeof update === "object" && !Array.isArray(update)) {
      try {
        const eventOwnerEpoch = wireEvent.args[4]
        const ownerEpoch =
          typeof eventOwnerEpoch === "string" && eventOwnerEpoch.length > 0
            ? eventOwnerEpoch
            : _runtime?.identity.serverEpoch ?? "local"
        if ("baseRevision" in update) {
          const patch = Schema.decodeUnknownSync(TerminalSemanticPatch)(update)
          const frame = encodeTerminalStreamV3({
            type: "terminal.patch",
            terminalId: semanticId,
            ownerEpoch,
            terminalEpoch,
            baseRevision: patch.baseRevision,
            revision,
            patch,
          })
          writer.enqueueSemanticRender(semanticId, frame)
          enqueueSemanticResyncNotices(writer, _runtime)
          return
        }
        const snapshot = Schema.decodeUnknownSync(TerminalSemanticSnapshot)(update)
        const frame = encodeTerminalStreamV3({
          type: "terminal.snapshot",
          terminalId: semanticId,
          ownerEpoch,
          terminalEpoch,
          revision,
          snapshot,
        })
        writer.enqueueSemanticRender(semanticId, frame)
        enqueueSemanticResyncNotices(writer, _runtime)
        return
      } catch {
        if (_runtime && semanticId) {
          enqueueSemanticSnapshot(writer, _runtime, semanticId)
        }
        return
      }
    }
  }
  writer.enqueueReliable(data);
}

function wsDataToText(data: WebSocket.RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function validateRpcPaths(
  config: HostConfig,
  channel: string,
  args: unknown[],
): PathOutsideRootsError | null {
  try {
    validateRpcPathsOrThrow(config, channel, args);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new PathOutsideRootsError({ message });
  }
}

function validateRpcPathsOrThrow(
  config: HostConfig,
  channel: string,
  args: unknown[],
): void {
  const route = getHostRoute(channel);
  if (!route) return;
  switch (route.pathPolicy.kind) {
    case "none":
      return;
    case "terminal-id-or-path": {
      const first = args[0];
      if (typeof first !== "string" || !first.startsWith("file:")) return;
      if (!pathAllowed(uriOrPath(first), config.allowedRoots)) {
        throw new Error("PATH_OUTSIDE_ALLOWED_ROOTS");
      }
      return;
    }
    case "allowed-root":
      for (const index of route.pathPolicy.indices) {
        const candidate = args[index];
        if (
          typeof candidate !== "string" ||
          !pathAllowed(uriOrPath(candidate), config.allowedRoots)
        ) {
          throw new Error("PATH_OUTSIDE_ALLOWED_ROOTS");
        }
      }
      return;
  }
}

function uriOrPath(value: string): string {
  return value.startsWith("file:") ? fileUriToPath(value) : value;
}

function acceptsEncoding(
  header: string | undefined,
  encoding: "br" | "gzip",
): boolean {
  if (!header) return false;
  const qualities = new Map<string, number>();
  for (const entry of header.toLowerCase().split(",")) {
    const [name, ...parameters] = entry.trim().split(";");
    if (!name) continue;
    let quality = 1;
    for (const parameter of parameters) {
      const match = /^q\s*=\s*(0(?:\.\d+)?|1(?:\.0+)?)$/.exec(parameter.trim());
      if (match) quality = Number(match[1]);
    }
    qualities.set(name, quality);
  }
  return (qualities.get(encoding) ?? qualities.get("*") ?? 0) > 0;
}

function serveStatic(
  root: string,
  pathname: string,
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const resolvedRoot = path.resolve(root);
  const abs = path.resolve(resolvedRoot, `.${rel}`);
  if (abs !== resolvedRoot && !abs.startsWith(`${resolvedRoot}${path.sep}`))
    return false;
  let filePath = abs;
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(resolvedRoot, "index.html");
    if (!fs.existsSync(filePath)) return false;
  }
  const ext = path.extname(filePath);
  const type =
    ext === ".html"
      ? "text/html"
      : ext === ".js"
        ? "text/javascript"
        : ext === ".css"
          ? "text/css"
          : ext === ".svg"
            ? "image/svg+xml"
            : ext === ".json"
              ? "application/json"
              : "application/octet-stream";
  const acceptEncoding =
    typeof req.headers["accept-encoding"] === "string"
      ? req.headers["accept-encoding"]
      : undefined;
  let servedPath = filePath;
  let contentEncoding: "br" | "gzip" | null = null;
  if (
    acceptsEncoding(acceptEncoding, "br") &&
    fs.existsSync(`${filePath}.br`)
  ) {
    servedPath = `${filePath}.br`;
    contentEncoding = "br";
  } else if (
    acceptsEncoding(acceptEncoding, "gzip") &&
    fs.existsSync(`${filePath}.gz`)
  ) {
    servedPath = `${filePath}.gz`;
    contentEncoding = "gzip";
  }
  const immutable =
    filePath.startsWith(path.join(resolvedRoot, "assets") + path.sep) &&
    /-[A-Za-z0-9_-]{8,}\.[^.]+$/.test(filePath);
  const headers: Record<string, string | number> = {
    "content-type": type,
    "content-length": fs.statSync(servedPath).size,
    "cache-control": immutable
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    vary: "Accept-Encoding",
  };
  if (contentEncoding) headers["content-encoding"] = contentEncoding;
  res.writeHead(200, headers);
  fs.createReadStream(servedPath).pipe(res);
  return true;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      throw new HttpError(413, "request body too large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}
