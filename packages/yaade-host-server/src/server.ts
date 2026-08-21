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
import {
  MAX_READ_BYTES,
  MAX_TEXT_FILE_BYTES,
  uriToPath,
  readTextFile,
  writeTextFile,
} from "@yaade/node-host";
import {
  decodeHostRouteArgs,
  FileChangedError,
  HostRpcRequest,
  InvalidRpcPayloadError,
  PathOutsideRootsError,
  PayloadTooLargeError,
  encodeTerminalDataFrame,
  hostErrorHttpStatus,
  getHostRoute,
  hostErrorWire,
  tryDecodeTerminalWsCommand,
  ScopeDeniedError,
  type HostRpcError,
  type TextFileWriteOptions,
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
import { pathAllowed, pathStaysWithin } from "./sandbox.js";
import {
  isAllowedCorsOrigin,
  isAllowedWebSocketOrigin,
  isAuthorizedRequest,
  isLoopbackHostname,
  requestAuthToken,
  tokensEqual,
} from "./security.js";
import { deviceMayInvoke } from "./device-scopes.js";
import { diagnosticBundle } from "./diagnostics.js";
import { normalizeProviderHookRequest } from "./notifications/index.js";
import {
  removeDaemonRuntimeManifest,
  writeDaemonRuntimeManifest,
} from "./runtime-manifest.js";

const VERSION = "0.0.1";
const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;
/** Slow clients get paused, then closed 1013 if they stay behind. */
const MAX_WEBSOCKET_BUFFERED_BYTES = 2 * 1024 * 1024;
const SOFT_WEBSOCKET_BUFFERED_BYTES = 512 * 1024;
/** Bound concurrent /api/v1/rpc handlers to avoid stampede spikes. */
const MAX_INFLIGHT_RPC = 32;
const MAX_WS_COMMAND_QUEUE = 64;
const MAX_WS_PAYLOAD_BYTES = 1024 * 1024;
const LEGACY_PROTOCOL_SOCKETS = new WeakSet<WebSocket>();
const DEVICE_EVENT_SOCKETS = new WeakMap<WebSocket, { deviceId: string }>();
const ACTIVE_EVENT_SOCKETS = new Set<WebSocket>();

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
  clientId: string,
  signal?: AbortSignal,
): Promise<{ ok: true; value: unknown } | { ok: false; error: HostRpcError }> {
  return managed.runPromise(
    dispatch(channel, args, clientId, signal).pipe(
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
  close: (options?: { killPtys?: boolean }) => Promise<void>;
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
        handleEventSocket(runtime, managed, ws, url);
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
  const close = (options?: { killPtys?: boolean }) => {
    closePromise ??= (async () => {
      await shutdownRuntime(runtime, {
        killPtys: options?.killPtys ?? config.killPtysOnShutdown,
      });
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

function runtimeHealth(runtime: HostRuntime) {
  const supervisorState =
    "connectionState" in runtime.terminal
      ? String(runtime.terminal.connectionState)
      : "healthy";
  const supervisorStatus =
    supervisorState === "healthy"
      ? "healthy"
      : supervisorState === "connecting" || supervisorState === "reconnecting"
        ? "degraded"
        : "unhealthy";
  const supervisorMessage =
    supervisorState === "reconnecting"
      ? "Supervisor reconnecting"
      : supervisorState === "incompatible"
        ? "incompatible supervisor protocol"
        : supervisorState;
  return {
    status: supervisorStatus === "healthy" ? "healthy" : "degraded",
    database: { status: "healthy", message: "SQLite WAL is available" },
    supervisor: { status: supervisorStatus, message: supervisorMessage },
    eventLoop: { status: "healthy", message: "HTTP event loop is responsive" },
    storage: { status: "healthy", message: "runtime storage is available" },
    connectedClients: 0,
    runningTerminals: runtime.terminalInstances.listLive().length,
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
      nativeAgentResume: runtime.config.features.nativeAgentResume,
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

  if (req.method === "POST" && pathname === "/api/v1/security/pairing-code") {
    if (!isAuthorizedRequest(req, runtime.config.authToken, url)) {
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
    sendJson(res, 200, runtime.devices.list())
    return
  }

  const revokeDevice = /^\/api\/v1\/security\/devices\/([^/]+)$/.exec(pathname)
  if (req.method === "DELETE" && revokeDevice) {
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
            ptySupervisor: runtime.config.ptySupervisor,
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

  if (pathname === "/api/v1/fs/text-file") {
    const uri = url.searchParams.get("uri");
    if (!uri || !uri.startsWith("file://")) {
      sendJson(res, 400, {
        error: {
          code: "INVALID_URI",
          message: "absolute file:// uri is required",
          details: {},
        },
      });
      return;
    }

    if (req.method === "GET") {
      try {
        const result = await readTextFile(uri);
        res.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "content-length": Buffer.byteLength(result.content, "utf8"),
          "cache-control": "no-store",
          "x-yaade-file-version": result.version,
          "x-yaade-file-size": result.size,
        });
        res.end(result.content);
      } catch (error) {
        sendTextFileError(res, error);
      }
      return;
    }

    if (req.method === "PUT") {
      let filePath: string;
      try {
        filePath = uriToPath(uri);
      } catch {
        sendJson(res, 400, {
          error: {
            code: "INVALID_URI",
            message: "invalid file uri",
            details: {},
          },
        });
        return;
      }
      if (!pathAllowed(filePath, runtime.config.allowedRoots)) {
        sendJson(res, 403, {
          error: {
            code: "PATH_OUTSIDE_ALLOWED_ROOTS",
            message: "text file path outside allowed roots",
            details: {},
          },
        });
        return;
      }

      const expectedVersion = url.searchParams.get("expectedVersion");
      const create = url.searchParams.get("create") === "1";
      if (create === (expectedVersion !== null)) {
        sendJson(res, 400, {
          error: {
            code: "INVALID_WRITE_OPTIONS",
            message: "exactly one of expectedVersion or create is required",
            details: {},
          },
        });
        return;
      }

      try {
        const content = await readUtf8Body(req, MAX_TEXT_FILE_BYTES);
        const options: TextFileWriteOptions = create
          ? { create: true }
          : { expectedVersion: expectedVersion ?? "" };
        const result = await writeTextFile(uri, content, options);
        res.writeHead(200, {
          "content-length": 0,
          "cache-control": "no-store",
          "x-yaade-file-version": result.version,
          "x-yaade-file-size": result.size,
        });
        res.end();
      } catch (error) {
        req.resume();
        sendTextFileError(res, error);
      }
      return;
    }
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
      const hostAuthorized = isAuthorizedRequest(req, runtime.config.authToken, url);
      const providedToken = requestAuthToken(req, url);
      const deviceSession = !hostAuthorized && providedToken
        ? runtime.devices.session(providedToken)
        : null;
      if (!hostAuthorized && deviceSession && !deviceMayInvoke(deviceSession.scopes, channel)) {
        const error = new ScopeDeniedError({
          message: "device scope does not allow this operation",
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
        clientId,
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

  // Provider hooks (Claude / Codex / Cursor / OpenCode) → ADE agent events.
  if (req.method === "POST" && pathname === "/api/v1/notifications/ingest") {
    const body = await readJson(req);
    try {
      const providerParam = url.searchParams.get("provider");
      const sessionIdParam = url.searchParams.get("sessionId");
      const { parseAgentProviderParam } = await import("./agents/index.js");
      const agentProvider = parseAgentProviderParam(providerParam);
      if (agentProvider && sessionIdParam) {
        runtime.agents.ingestNative(body, {
          provider: agentProvider,
          sessionId: sessionIdParam,
          projectId: url.searchParams.get("projectId") ?? undefined,
          projectName: url.searchParams.get("projectName") ?? undefined,
          sessionTitle: url.searchParams.get("sessionTitle") ?? undefined,
        });
        res.writeHead(204);
        res.end();
        return;
      }
      const normalized = normalizeProviderHookRequest(body, {
        provider: providerParam,
        sessionId: sessionIdParam,
        projectId: url.searchParams.get("projectId"),
        projectName: url.searchParams.get("projectName"),
        sessionTitle: url.searchParams.get("sessionTitle"),
      });
      const ingest = await runHostRpc(
        managed,
        "notifications:ingest",
        [normalized],
        "hook",
      );
      if (!ingest.ok) {
        const wire = hostErrorWire(ingest.error);
        sendJson(res, hostErrorHttpStatus(ingest.error), { error: wire });
        return;
      }
      // Hook consumers interpret response bodies as control output. An empty 2xx
      // acknowledges delivery without accidentally feeding Yaade data back
      // into the provider's conversation.
      res.writeHead(204);
      res.end();
    } catch (error) {
      sendJson(res, 400, {
        error: {
          code: "OPERATION_FAILED",
          message: error instanceof Error ? error.message : String(error),
          details: {},
        },
      });
    }
    return;
  }

  if (pathname === "/api/v1/projects") {
    if (req.method === "GET") {
      sendJson(res, 200, runtime.db.projects());
      return;
    }
    if (req.method === "POST") {
      const body = (await readJson(req)) as {
        rootPath?: string;
        name?: string;
      };
      if (!body.rootPath) {
        sendJson(res, 400, {
          error: {
            code: "INVALID_PROJECT_PATH",
            message: "rootPath required",
            details: {},
          },
        });
        return;
      }
      if (!pathAllowed(body.rootPath, runtime.config.allowedRoots)) {
        sendJson(res, 403, {
          error: {
            code: "PATH_OUTSIDE_ALLOWED_ROOTS",
            message: "project path outside allowed roots",
            details: {},
          },
        });
        return;
      }
      let projectStat: fs.Stats;
      try {
        projectStat = fs.statSync(body.rootPath);
      } catch {
        sendJson(res, 404, {
          error: {
            code: "PROJECT_PATH_NOT_FOUND",
            message: "project path does not exist",
            details: {},
          },
        });
        return;
      }
      if (!projectStat.isDirectory()) {
        sendJson(res, 400, {
          error: {
            code: "PROJECT_PATH_NOT_DIRECTORY",
            message: "project path is not a directory",
            details: {},
          },
        });
        return;
      }
      try {
        const project = runtime.db.addProject(body.rootPath, body.name);
        sendJson(res, 201, project);
      } catch (error) {
        sendJson(res, 400, {
          error: {
            code: "INVALID_PROJECT_PATH",
            message: String(error),
            details: {},
          },
        });
      }
      return;
    }
  }

  if (pathname === "/api/v1/projects/open" && req.method === "POST") {
    const body = (await readJson(req)) as { rootPath?: string; name?: string };
    const rootPath =
      typeof body.rootPath === "string" ? body.rootPath.trim() : "";
    if (!rootPath) {
      sendJson(res, 400, {
        error: {
          code: "INVALID_PROJECT_PATH",
          message: "rootPath required",
          details: {},
        },
      });
      return;
    }
    if (!pathAllowed(rootPath, runtime.config.allowedRoots)) {
      sendJson(res, 403, {
        error: {
          code: "FORBIDDEN",
          message: "project path outside allowed roots",
          details: {},
        },
      });
      return;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(rootPath);
    } catch {
      sendJson(res, 404, {
        error: {
          code: "NOT_FOUND",
          message: "project path does not exist",
          details: {},
        },
      });
      return;
    }
    if (!stat.isDirectory()) {
      sendJson(res, 400, {
        error: {
          code: "NOT_DIRECTORY",
          message: "project path is not a directory",
          details: {},
        },
      });
      return;
    }
    try {
      const opened = runtime.db.openProject(
        rootPath,
        typeof body.name === "string" ? body.name : undefined,
      );
      sendJson(res, 200, opened);
    } catch (error) {
      sendJson(res, 400, {
        error: {
          code: "INVALID_PROJECT_PATH",
          message: error instanceof Error ? error.message : String(error),
          details: {},
        },
      });
    }
    return;
  }

  const surfaceStateMatch =
    /^\/api\/v1\/projects\/([^/]+)\/surface-state$/.exec(pathname);
  if (surfaceStateMatch) {
    const projectId = decodeURIComponent(surfaceStateMatch[1]!);
    if (!runtime.db.project(projectId)) {
      sendJson(res, 404, {
        error: {
          code: "PROJECT_NOT_FOUND",
          message: "project not found",
          details: {},
        },
      });
      return;
    }
    if (req.method === "GET") {
      sendJson(
        res,
        200,
        runtime.db.projectSurfaceState(projectId, runtime.machineHostname),
      );
      return;
    }
    if (req.method === "PUT") {
      const body = (await readJson(req)) as {
        surface?: string;
        state?: unknown;
      };
      if (
        typeof body.surface !== "string" ||
        !body.state ||
        typeof body.state !== "object" ||
        Array.isArray(body.state)
      ) {
        sendJson(res, 400, {
          error: {
            code: "INVALID_SURFACE_STATE",
            message: "surface and state are required",
            details: {},
          },
        });
        return;
      }
      try {
        sendJson(
          res,
          200,
          runtime.db.putProjectSurfaceState({
            projectId,
            machine: runtime.machineHostname,
            surface: body.surface,
            state: body.state as Record<string, unknown>,
          }),
        );
      } catch (error) {
        sendJson(res, 400, {
          error: {
            code: "INVALID_SURFACE_STATE",
            message: error instanceof Error ? error.message : String(error),
            details: {},
          },
        });
      }
      return;
    }
  }

  const projectMatch = /^\/api\/v1\/projects\/([^/]+)(?:\/(file|files))?$/.exec(
    pathname,
  );
  if (projectMatch) {
    const projectId = decodeURIComponent(projectMatch[1]!);
    const sub = projectMatch[2];
    const project = runtime.db.project(projectId);
    if (!project) {
      sendJson(res, 404, {
        error: {
          code: "PROJECT_NOT_FOUND",
          message: "project not found",
          details: {},
        },
      });
      return;
    }

    if (!sub && req.method === "DELETE") {
      runtime.db.removeProject(projectId);
      res.writeHead(204);
      res.end();
      return;
    }

    if (!sub && req.method === "GET") {
      sendJson(res, 200, project);
      return;
    }

    if (sub === "files" && req.method === "GET") {
      const rel = url.searchParams.get("path") ?? "";
      const abs = pathStaysWithin(project.rootPath, rel || ".");
      if (!abs || !pathAllowed(abs, runtime.config.allowedRoots)) {
        sendJson(res, 403, {
          error: {
            code: "PATH_TRAVERSAL",
            message: "invalid path",
            details: {},
          },
        });
        return;
      }
      try {
        const entries = fs
          .readdirSync(abs, { withFileTypes: true })
          .map((entry) => ({
            name: entry.name,
            isDirectory: entry.isDirectory(),
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        sendJson(res, 200, entries);
      } catch {
        sendJson(res, 404, {
          error: {
            code: "FILE_NOT_FOUND",
            message: "directory not found",
            details: {},
          },
        });
      }
      return;
    }

    if (sub === "file") {
      const rel = url.searchParams.get("path") ?? "";
      if (req.method === "GET") {
        const abs = pathStaysWithin(project.rootPath, rel);
        if (!abs || !pathAllowed(abs, runtime.config.allowedRoots)) {
          sendJson(res, 403, {
            error: {
              code: "PATH_TRAVERSAL",
              message: "invalid path",
              details: {},
            },
          });
          return;
        }
        try {
          const st = fs.statSync(abs);
          if (st.isDirectory()) {
            sendJson(res, 404, {
              error: {
                code: "FILE_NOT_FOUND",
                message: "not a file",
                details: {},
              },
            });
            return;
          }
          if (st.size > MAX_READ_BYTES) {
            sendJson(res, 413, {
              error: {
                code: "FILE_TOO_LARGE",
                message: `file too large: ${st.size} bytes (max ${MAX_READ_BYTES})`,
                details: { size: st.size, max: MAX_READ_BYTES },
              },
            });
            return;
          }
          const content = fs.readFileSync(abs, "utf8");
          sendJson(res, 200, { path: rel, content, version: fileVersion(abs) });
        } catch {
          sendJson(res, 404, {
            error: {
              code: "FILE_NOT_FOUND",
              message: "file not found",
              details: {},
            },
          });
        }
        return;
      }
      if (req.method === "PUT") {
        const body = (await readJson(req)) as {
          path?: string;
          content?: string;
          expectedVersion?: string;
        };
        const fileRel = body.path ?? rel;
        const abs = pathStaysWithin(project.rootPath, fileRel ?? "");
        if (!abs || !pathAllowed(abs, runtime.config.allowedRoots)) {
          sendJson(res, 403, {
            error: {
              code: "PATH_TRAVERSAL",
              message: "invalid path",
              details: {},
            },
          });
          return;
        }
        if (body.expectedVersion && body.expectedVersion !== fileVersion(abs)) {
          sendJson(res, 409, {
            error: {
              code: "FILE_CHANGED",
              message: "file changed on disk",
              details: {},
            },
          });
          return;
        }
        const tmp = `${abs}.jet-write-${randomUUID()}`;
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(tmp, body.content ?? "", "utf8");
        fs.renameSync(tmp, abs);
        sendJson(res, 200, { path: fileRel, version: fileVersion(abs) });
        return;
      }
    }
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
): void {
  const protocol = url.searchParams.get("protocol");
  if (protocol && protocol !== "1" && protocol !== "2") {
    ws.close(4002, "incompatible protocol");
    return;
  }
  if (protocol === "2") {
    handleModernEventSocket(runtime, managed, ws, url)
    return
  }
  handleLegacyEventSocket(runtime, managed, ws, url)
}

function handleLegacyEventSocket(
  runtime: HostRuntime,
  managed: ManagedRuntime.ManagedRuntime<HostLayerServices, never>,
  ws: WebSocket,
  url: URL,
): void {
  const since = Number(url.searchParams.get("since") ?? "0") || 0;
  if (url.searchParams.get("protocol") === "1") LEGACY_PROTOCOL_SOCKETS.add(ws);
  const requestedClientId = url.searchParams.get("clientId");
  const clientId =
    requestedClientId && /^[A-Za-z0-9-]{1,128}$/.test(requestedClientId)
      ? requestedClientId
      : `ws-${randomUUID()}`;
  const legacyClientId = `legacy:${clientId}`;
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
  let commandTail = Promise.resolve();
  let commandQueue = 0;
  ws.on("message", (data) => {
    const text = typeof data === "string" ? data : wsDataToText(data);
    if (text === "ping") {
      ws.send("pong");
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
    if (commandQueue >= MAX_WS_COMMAND_QUEUE) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "terminal:result",
            requestId: cmd.requestId,
            ok: false,
            error: { code: "HOST_BUSY", message: "too many in-flight terminal commands" },
          }),
        );
      }
      return;
    }
    commandQueue += 1;
    if (cmd.op === "terminal:attach") {
      const id = cmd.args[0];
      if (typeof id === "string" && id) {
        attachedTerminals.add(id);
        void Promise.resolve(runtime.terminal.armLiveViewer(id, legacyClientId));
      }
    }
    const command = commandTail.then(() =>
      runHostRpc(managed, cmd.op, cmd.args, legacyClientId),
    );
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
        ws.send(
          JSON.stringify({
            type: "terminal:result",
            requestId: cmd.requestId,
            ok: true,
            value: result.value,
          }),
        );
        return;
      }
      const error = hostErrorWire(result.error);
      ws.send(
        JSON.stringify({
          type: "terminal:result",
          requestId: cmd.requestId,
          ok: false,
          error: { code: error.code, message: error.message },
        }),
      );
    });
  });
  ws.on("close", () => {
    unsubscribe();
    LEGACY_PROTOCOL_SOCKETS.delete(ws);
    runtime.leases.releaseClient(legacyClientId);
    void Promise.resolve(runtime.terminal.resumeForClient(legacyClientId));
  });
}

/** Modern protocol authentication happens in-band, never in a reusable URL. */
function handleModernEventSocket(
  runtime: HostRuntime,
  managed: ManagedRuntime.ManagedRuntime<HostLayerServices, never>,
  ws: WebSocket,
  url: URL,
): void {
  const expectedToken = runtime.config.authToken
  if (!expectedToken) {
    startModernEventSocket(runtime, managed, ws, url)
    return
  }
  let authenticated = false
  const timeout = setTimeout(() => {
    if (!authenticated) ws.close(4003, "authentication required")
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
      clearTimeout(timeout)
      ws.close(4003, "authentication failed")
      return
    }
    authenticated = true
    clearTimeout(timeout)
    ws.off("message", authenticate)
    const deviceSession = tokensEqual(expectedToken, record.token)
      ? null
      : runtime.devices.session(record.token)
    startModernEventSocket(runtime, managed, ws, url, deviceSession ?? undefined)
  }
  ws.send(JSON.stringify({ type: "protocol:auth-required" }))
  ws.on("message", authenticate)
}

function startModernEventSocket(
  runtime: HostRuntime,
  managed: ManagedRuntime.ManagedRuntime<HostLayerServices, never>,
  ws: WebSocket,
  url: URL,
  deviceSession?: { deviceId: string; scopes: import("./device-auth.js").DeviceScope[] },
): void {
  const requestedClientId = url.searchParams.get("clientId");
  const clientId =
    requestedClientId && /^[A-Za-z0-9-]{1,128}$/.test(requestedClientId)
      ? requestedClientId
      : `ws-${randomUUID()}`;
  let synchronizing = true;
  const pendingEvents: HostEvent[] = [];
  const attachedTerminals = new Set<string>();
  const send = (event: HostEvent) =>
    sendEventSocketMessage(ws, event, runtime, attachedTerminals);
  const unsubscribe = runtime.events.subscribe(event => {
    if (event.channel === "terminal:data") {
      const id = String(event.args[0] ?? "");
      if (!attachedTerminals.has(id)) return;
    }
    if (synchronizing) pendingEvents.push(event);
    else send(event);
  });

  try {
    ws.send(JSON.stringify({
      type: "protocol:hello",
      identity: runtime.identity,
      capabilities: serverCapabilities(runtime),
    }));
    const snapshot = buildRuntimeSnapshot(runtime);
    ws.send(JSON.stringify(snapshot));
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
  if (deviceSession) DEVICE_EVENT_SOCKETS.set(ws, { deviceId: deviceSession.deviceId });

  let commandTail = Promise.resolve();
  let commandQueue = 0;
  ws.on("message", data => {
    const text = typeof data === "string" ? data : wsDataToText(data);
    if (text === "ping") {
      ws.send("pong");
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
    if (deviceSession && !deviceMayInvoke(deviceSession.scopes, cmd.op)) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "terminal:result",
          requestId: cmd.requestId,
          ok: false,
          error: { code: "SCOPE_DENIED", message: "device scope does not allow this operation" },
        }));
      }
      return;
    }
    if (commandQueue >= MAX_WS_COMMAND_QUEUE) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "terminal:result",
          requestId: cmd.requestId,
          ok: false,
          error: { code: "HOST_BUSY", message: "too many in-flight terminal commands" },
        }));
      }
      return;
    }
    commandQueue += 1;
    if (cmd.op === "terminal:attach") {
      const id = cmd.args[0];
      if (typeof id === "string" && id) {
        attachedTerminals.add(id);
        void Promise.resolve(runtime.terminal.armLiveViewer(id, clientId));
      }
    }
    const command = commandTail.then(() =>
      runHostRpc(managed, cmd.op, cmd.args, clientId),
    );
    commandTail = command.then(
      () => { commandQueue = Math.max(0, commandQueue - 1) },
      () => { commandQueue = Math.max(0, commandQueue - 1) },
    );
    void command.then(result => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (result.ok) {
        ws.send(JSON.stringify({
          type: "terminal:result",
          requestId: cmd.requestId,
          ok: true,
          value: result.value,
        }));
        return;
      }
      const error = hostErrorWire(result.error);
      ws.send(JSON.stringify({
        type: "terminal:result",
        requestId: cmd.requestId,
        ok: false,
        error: { code: error.code, message: error.message },
      }));
    });
  });
  ws.on("close", () => {
    unsubscribe();
    ACTIVE_EVENT_SOCKETS.delete(ws);
    DEVICE_EVENT_SOCKETS.delete(ws);
    runtime.leases.releaseClient(clientId);
    void Promise.resolve(runtime.terminal.resumeForClient(clientId));
  });
}

function sendEventSocketMessage(
  ws: WebSocket,
  event: HostEvent,
  runtime?: { terminal: HostRuntime["terminal"] },
  attachedTerminals?: Set<string>,
): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > SOFT_WEBSOCKET_BUFFERED_BYTES) {
    const ids = attachedTerminals ? [...attachedTerminals] : undefined;
    void Promise.resolve(runtime?.terminal.pauseForBackpressure(ids));
  }
  if (ws.bufferedAmount > MAX_WEBSOCKET_BUFFERED_BYTES) {
    ws.close(1013, "client is not consuming events");
    return;
  }
  const wireEvent =
    LEGACY_PROTOCOL_SOCKETS.has(ws) && event.protocolVersion === 2
      ? {
          protocolVersion: 1,
          sequence: event.sequence,
          channel: event.channel,
          args: event.args,
        }
      : event;
  if (wireEvent.channel === "terminal:data") {
    const id = String(wireEvent.args[0] ?? "");
    const data = String(wireEvent.args[1] ?? "");
    const terminalSequence =
      typeof wireEvent.args[2] === "number" && Number.isFinite(wireEvent.args[2])
        ? wireEvent.args[2]
        : 0;
    try {
      ws.send(
        Buffer.from(
          encodeTerminalDataFrame(wireEvent.sequence, terminalSequence, id, data),
        ),
      );
      return;
    } catch {
      // Fall through to JSON if encoding fails (oversized id, etc.).
    }
  }
  ws.send(JSON.stringify(wireEvent));
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
    case "read-only-path":
      // Read-only file routes intentionally allow module-cache and standard
      // library paths outside allowedRoots.
      return;
    case "terminal-id-or-path": {
      const first = args[0];
      if (typeof first !== "string" || !first.startsWith("file:")) return;
      if (!pathAllowed(uriOrPath(first), config.allowedRoots)) {
        throw new Error("PATH_OUTSIDE_ALLOWED_ROOTS");
      }
      return;
    }
    case "trash-restore": {
      const target = args[1];
      if (
        typeof target === "string" &&
        !pathAllowed(uriOrPath(target), config.allowedRoots)
      ) {
        throw new Error("PATH_OUTSIDE_ALLOWED_ROOTS");
      }
      // Without an override, dispatch validates the original path stored in
      // the host-owned trash metadata before restoring it.
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
  return value.startsWith("file:") ? uriToPath(value) : value;
}

function fileVersion(abs: string): string {
  try {
    const st = fs.statSync(abs);
    return `${Math.trunc(st.mtimeMs * 1e6)}:${st.size}`;
  } catch {
    return "missing";
  }
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

async function readUtf8Body(
  req: IncomingMessage,
  maxBytes: number,
): Promise<string> {
  const declaredLength = req.headers["content-length"];
  if (declaredLength !== undefined) {
    const bytes = Number(declaredLength);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new HttpError(400, "invalid content-length");
    }
    if (bytes > maxBytes) throw new HttpError(413, "request body too large");
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw new HttpError(413, "request body too large");
    }
    chunks.push(buffer);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    throw new HttpError(400, "request body must be valid UTF-8");
  }
}

function nodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function sendTextFileError(res: ServerResponse, error: unknown): void {
  if (
    error instanceof FileChangedError ||
    error instanceof PayloadTooLargeError
  ) {
    sendJson(res, hostErrorHttpStatus(error), { error: hostErrorWire(error) });
    return;
  }
  if (error instanceof HttpError) {
    sendJson(res, error.status, {
      error: {
        code: error.status === 413 ? "PAYLOAD_TOO_LARGE" : "OPERATION_FAILED",
        message: error.message,
        details: {},
      },
    });
    return;
  }
  const code = nodeErrorCode(error);
  if (code === "ENOENT" || code === "ENOTDIR") {
    sendJson(res, 404, {
      error: { code: "NOT_FOUND", message: "text file not found", details: {} },
    });
    return;
  }
  sendJson(res, 400, {
    error: {
      code: "OPERATION_FAILED",
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}
