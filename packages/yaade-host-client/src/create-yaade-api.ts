import type { YaadeHostAPI } from "@yaade/workspace"
import { Schema } from "effect";
import {
  MuxEvent,
  TerminalPatchMessage,
  TerminalResyncRequiredMessage,
  TerminalSnapshotMessage,
} from "@yaade/rpc";
import type { YaadeHostTransport } from "./transport.js";
import { TerminalV3Store } from "./terminal-v3-store.js";

// Host owns the authoritative terminal replay. This buffer only bridges the
// attach handshake, so keeping a second multi-megabyte copy is wasteful.
const MAX_BUFFERED_TERMINAL_CHARS = 64 * 1024;

type TerminalAttachResult = {
  id: string;
  title?: string;
  terminalEpoch?: string;
  ownerId?: string;
  ownerEpoch?: string;
  protocolVersion?: number;
  checkpoint?: {
    checkpointVersion: 1;
    terminalEpoch: string;
    sequence: number;
    cols: number;
    rows: number;
    createdAt: string;
    syntheticAnsi: string;
  };
  replayQuality?: "exact" | "checkpoint" | "degraded";
  outputChunks?: string[];
  output: string;
  replayTruncated?: boolean;
  replayNeedsQueryResponses?: boolean;
  lastSequence: number;
  status: "running" | "exited";
  exitCode?: number;
  signal?: number;
  semanticSnapshot?: import("@yaade/rpc").TerminalSemanticSnapshot | null;
};

/** Prefer acknowledged WS delivery for hot terminal I/O; fall back to HTTP RPC. */
function invokeTerminalHot(
  transport: YaadeHostTransport,
  channel: string,
  ...args: unknown[]
): Promise<void> {
  const realtime = transport.invokeRealtime?.(channel, ...args);
  if (realtime) return realtime.then(() => undefined);
  return transport.invoke(channel, ...args).then(() => undefined);
}

export function createYaadeApi(transport: YaadeHostTransport): YaadeHostAPI {
  type TerminalDataListener = (
    data: string,
    replay?: boolean,
    replayNeedsQueryResponses?: boolean,
    replayTruncated?: boolean,
  ) => void;
  const terminalDataListeners = new Map<string, Set<TerminalDataListener>>();
  type BufferedTerminalData = {
    data: string;
    sequence: number;
    replay?: boolean;
    replayNeedsQueryResponses?: boolean;
    replayTruncated?: boolean;
  };
  const terminalDataBuffers = new Map<string, BufferedTerminalData[]>();
  const terminalDataBufferSizes = new Map<string, number>();
  const terminalReplayFloors = new Map<string, number>();
  const terminalResyncing = new Set<string>();
  let realtimeConnected = false;
  let reconnectGeneration = 0;
  let hadRealtimeDisconnect = false;

  const bufferTerminalData = (
    id: string,
    data: string,
    sequence: number,
    replay = false,
    replayNeedsQueryResponses = false,
    replayTruncated = false,
  ) => {
    const pending = terminalDataBuffers.get(id) ?? [];
    const buffered: BufferedTerminalData = { data, sequence }
    if (replay) buffered.replay = true
    if (replayNeedsQueryResponses) buffered.replayNeedsQueryResponses = true
    if (replayTruncated) buffered.replayTruncated = true
    pending.push(buffered)
    let size = (terminalDataBufferSizes.get(id) ?? 0) + data.length;
    while (size > MAX_BUFFERED_TERMINAL_CHARS && pending.length > 1) {
      size -= pending.shift()!.data.length;
    }
    terminalDataBuffers.set(id, pending);
    terminalDataBufferSizes.set(id, size);
  };

  const deliverTerminalData = (
    id: string,
    data: string,
    replay = false,
    replayNeedsQueryResponses = false,
    replayTruncated = false,
  ) => {
    const listeners = terminalDataListeners.get(id);
    if (!listeners || listeners.size === 0) return false;
    listeners.forEach((cb) =>
      cb(data, replay, replayNeedsQueryResponses, replayTruncated),
    );
    return true;
  };

  const attachTerminal = (
    id: string,
    afterSequence?: number,
  ): Promise<TerminalAttachResult | null> => {
    const realtime =
      afterSequence === undefined
        ? transport.invokeRealtime?.("terminal:attach", id)
        : transport.invokeRealtime?.("terminal:attach", id, afterSequence);
    if (realtime) return realtime;
    return afterSequence === undefined
      ? transport.invoke("terminal:attach", id)
      : transport.invoke("terminal:attach", id, afterSequence);
  };

  const resyncTerminal = async (id: string, generation: number) => {
    const afterSequence = terminalReplayFloors.get(id) ?? 0;
    try {
      // Must go over the live socket so the host arms `attachedTerminals`.
      // HTTP attach replays the ring but leaves live `terminal:data` dropped.
      const result = await attachTerminal(id, afterSequence);
      if (
        generation !== reconnectGeneration ||
        !realtimeConnected ||
        !terminalResyncing.has(id)
      ) {
        return;
      }
      if (!result) {
        terminalResyncing.delete(id);
        return;
      }
      const chunks =
        result.outputChunks && result.outputChunks.length > 0
          ? result.outputChunks
          : result.output
            ? [result.output]
            : [];
      const pending = terminalDataBuffers.get(id);
      terminalDataBuffers.delete(id);
      terminalDataBufferSizes.delete(id);
      terminalReplayFloors.set(id, result.lastSequence);
      terminalResyncing.delete(id);
      let firstReplayChunk = true;
      if (result.checkpoint?.syntheticAnsi) {
        const checkpoint = result.checkpoint.syntheticAnsi;
        if (
          !deliverTerminalData(
            id,
            checkpoint,
            true,
            result.replayNeedsQueryResponses === true,
            false,
          )
        ) {
          bufferTerminalData(
            id,
            checkpoint,
            0,
            true,
            result.replayNeedsQueryResponses === true,
            false,
          );
        }
      }
      for (const chunk of chunks) {
        const replayTruncated =
          firstReplayChunk && result.replayTruncated === true;
        if (chunk) {
          if (
            !deliverTerminalData(
              id,
              chunk,
              true,
              result.replayNeedsQueryResponses === true,
              replayTruncated,
            )
          ) {
            bufferTerminalData(
              id,
              chunk,
              0,
              true,
              result.replayNeedsQueryResponses === true,
              replayTruncated,
            );
          }
          firstReplayChunk = false;
        }
      }
      for (const chunk of pending ?? []) {
        if (chunk.sequence > 0 && chunk.sequence <= result.lastSequence)
          continue;
        if (chunk.sequence > 0) terminalReplayFloors.set(id, chunk.sequence);
        if (
          !deliverTerminalData(
            id,
            chunk.data,
            chunk.replay === true,
            chunk.replayNeedsQueryResponses === true,
            chunk.replayTruncated === true,
          )
        ) {
          bufferTerminalData(
            id,
            chunk.data,
            chunk.sequence,
            chunk.replay === true,
            chunk.replayNeedsQueryResponses === true,
            chunk.replayTruncated === true,
          );
        }
      }
    } catch {
      // Keep the terminal marked for resync. A later socket recovery will retry;
      // normal HTTP errors remain owned by the connection lifecycle.
    }
  };

  transport.on("connection:status", (...args: unknown[]) => {
    const status = args[0];
    if (status === "disconnected") {
      realtimeConnected = false;
      hadRealtimeDisconnect = true;
      reconnectGeneration += 1;
      for (const id of terminalDataListeners.keys()) terminalResyncing.add(id);
      return;
    }
    if (status !== "connected") return;
    realtimeConnected = true;
    const generation = reconnectGeneration;
    for (const id of terminalResyncing) {
      void resyncTerminal(id, generation);
    }
    if (hadRealtimeDisconnect && typeof window !== "undefined") {
      hadRealtimeDisconnect = false;
      window.dispatchEvent(new Event("yaade:host-reconnected"));
    }
  });

  transport.on("protocol:replay-gap", (...args: unknown[]) => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent("yaade:host-replay-gap", {
        detail: { replayFloor: args[0], lastSequence: args[1] },
      }),
    );
  });

  transport.on("runtime:snapshot", (...args: unknown[]) => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent("yaade:runtime-snapshot", { detail: args[0] }),
    );
  });

  transport.on("terminal:data", (...args: unknown[]) => {
    const id = args[0] as string;
    const data = args[1] as string;
    const sequence = (args[2] as number | undefined) ?? 0;
    const floor = terminalReplayFloors.get(id) ?? 0;
    if (sequence > 0 && sequence <= floor) return;
    if (terminalResyncing.has(id)) {
      bufferTerminalData(id, data, sequence);
      return;
    }
    const listeners = terminalDataListeners.get(id);
    if (listeners && listeners.size > 0) {
      if (sequence > 0) terminalReplayFloors.set(id, sequence);
      listeners.forEach((cb) => cb(data, false, false, false));
      return;
    }
    if (terminalReplayFloors.has(id)) {
      if (sequence > 0) terminalReplayFloors.set(id, sequence);
      bufferTerminalData(id, data, sequence);
    }
  });
  transport.on("terminal:exit", (...args: unknown[]) => {
    const id = args[0] as string;
    const exitCode = args[1] as number;
    const signal = args[2] as number | undefined;
    for (const cb of terminalExitListeners) cb(id, exitCode, signal);
  });
  const semanticStores = new Map<string, TerminalV3Store>();
  const semanticStoreFor = (terminalId: string): TerminalV3Store => {
    const existing = semanticStores.get(terminalId)
    if (existing) return existing
    const created = new TerminalV3Store()
    semanticStores.set(terminalId, created)
    return created
  }
  const requestSemanticResync = (terminalId: string): void => {
    void attachTerminal(terminalId)
      .then(result => {
        if (!result?.semanticSnapshot) return
        const ownerEpoch = result.ownerEpoch ?? "attach"
        semanticStoreFor(terminalId).applySnapshot({
          type: "terminal.snapshot",
          terminalId,
          ownerEpoch,
          terminalEpoch: result.terminalEpoch ?? "",
          revision: result.semanticSnapshot.revision,
          snapshot: result.semanticSnapshot,
        })
      })
      .catch(() => undefined)
  }
  transport.on("terminal.snapshot", (...args: unknown[]) => {
    try {
      const message = Schema.decodeUnknownSync(TerminalSnapshotMessage)(args[0])
      const result = semanticStoreFor(message.terminalId).applySnapshot(message)
      if (result === "resync-required") requestSemanticResync(message.terminalId)
    } catch {
      /* A malformed semantic frame must not break the legacy PTY stream. */
    }
  });
  transport.on("terminal.patch", (...args: unknown[]) => {
    try {
      const message = Schema.decodeUnknownSync(TerminalPatchMessage)(args[0])
      const result = semanticStoreFor(message.terminalId).applyPatch(message)
      if (result === "resync-required") requestSemanticResync(message.terminalId)
    } catch {
      /* A malformed semantic frame must not break the legacy PTY stream. */
    }
  });
  transport.on("terminal.resync-required", (...args: unknown[]) => {
    try {
      const message = Schema.decodeUnknownSync(TerminalResyncRequiredMessage)(args[0])
      requestSemanticResync(message.terminalId)
    } catch {
      /* Ignore malformed resync notices; the next attach reconciles state. */
    }
  });
  transport.on("mux:event", (...args: unknown[]) => {
    try {
      const event = Schema.decodeUnknownSync(MuxEvent)(args[0]);
      for (const cb of muxEventListeners) cb(event);
    } catch {
      // Malformed generic events are ignored; the next reconciliation refetches state.
    }
  });

  const terminalExitListeners = new Set<
    (id: string, exitCode: number, signal?: number) => void
  >();
  const muxEventListeners = new Set<
    (event: import("@yaade/rpc").MuxEvent) => void
  >();
  return {
    mux: {
      listSessions: (includeArchived) =>
        transport.invoke("mux:listSessions", includeArchived === true),
      reorderSessions: (command) =>
        transport.invoke("mux:reorderSessions", command),
      createTab: (command) => transport.invoke("mux:createTab", command),
      renameTab: (command) => transport.invoke("mux:renameTab", command),
      saveTabLayout: (command) =>
        transport.invoke("mux:saveTabLayout", command),
      reorderTabs: (command) => transport.invoke("mux:reorderTabs", command),
      archiveTab: (command) => transport.invoke("mux:archiveTab", command),
      selectTab: (command) => transport.invoke("mux:selectTab", command),
      archiveSession: (command) =>
        transport.invoke("mux:archiveSession", command),
      restoreSession: (command) =>
        transport.invoke("mux:restoreSession", command),
      createSession: (title) => transport.invoke("mux:createSession", title),
      renameSession: (sessionId, title) =>
        transport.invoke("mux:renameSession", sessionId, title),
      getSession: (sessionId) =>
        transport.invoke("mux:getSession", sessionId),
      createTerminal: (command) => transport.invoke("mux:createTerminal", command),
      getTerminal: (muxTerminalId) => transport.invoke("mux:getTerminal", muxTerminalId),
      reorderTerminals: (command) => transport.invoke("mux:reorderTerminals", command),
      selectTerminal: (sessionId, muxTerminalId) =>
        transport.invoke("mux:selectTerminal", sessionId, muxTerminalId),
      stopTerminal: (muxTerminalId, revision) =>
        transport.invoke("mux:stopTerminal", muxTerminalId, revision),
      restartTerminal: (muxTerminalId, revision) =>
        transport.invoke("mux:restartTerminal", muxTerminalId, revision),
      closeTerminal: (command) => transport.invoke("mux:closeTerminal", command),
      renameTerminal: (muxTerminalId, title) =>
        transport.invoke("mux:renameTerminal", muxTerminalId, title),
      onEvent: (callback) => {
        muxEventListeners.add(callback);
        return () => muxEventListeners.delete(callback);
      },
    },
    terminal: {
      create: async (cwdUri, launch) => {
        const result = await transport.invoke("terminal:create", cwdUri, launch);
        if (result.title) return { id: result.id, title: result.title }
        return { id: result.id }
      },
      attach: async (id) => {
        const result = await attachTerminal(id);
        if (result) {
          terminalReplayFloors.set(id, result.lastSequence);
          if (result.semanticSnapshot) {
            semanticStoreFor(id).applySnapshot({
              type: "terminal.snapshot",
              terminalId: id,
              ownerEpoch: result.ownerEpoch ?? "attach",
              terminalEpoch: result.terminalEpoch ?? "",
              revision: result.semanticSnapshot.revision,
              snapshot: result.semanticSnapshot,
            })
          }
          const pending = terminalDataBuffers.get(id);
          if (pending) {
            const kept = pending.filter(
              (chunk) =>
                chunk.sequence === 0 || chunk.sequence > result.lastSequence,
            );
            let size = 0;
            for (const chunk of kept) size += chunk.data.length;
            terminalDataBuffers.set(id, kept);
            terminalDataBufferSizes.set(id, size);
          }
        }
        return result;
      },
      write: (id, data) => {
        if (transport.sendRealtime?.("terminal:write", id, data)) {
          return Promise.resolve();
        }
        return invokeTerminalHot(transport, "terminal:write", id, data);
      },
      writeBinary: (id, dataBase64) => {
        if (transport.sendRealtime?.("terminal:writeBinary", id, dataBase64)) {
          return Promise.resolve();
        }
        return invokeTerminalHot(
          transport,
          "terminal:writeBinary",
          id,
          dataBase64,
        );
      },
      resize: (id, cols, rows) => {
        if (transport.sendRealtime?.("terminal:resize", id, cols, rows)) {
          return Promise.resolve();
        }
        return invokeTerminalHot(transport, "terminal:resize", id, cols, rows);
      },
      acknowledgeData: (id, charCount) =>
        invokeTerminalHot(transport, "terminal:ack", id, charCount),
      markReplayReady: (id) =>
        invokeTerminalHot(transport, "terminal:ready", id),
      getCwd: (id) => transport.invoke("terminal:getCwd", id),
      getForegroundProcess: (id) =>
        transport.invoke("terminal:getForegroundProcess", id),
      onData: (id, callback) => {
        let set = terminalDataListeners.get(id);
        if (!set) {
          set = new Set();
          terminalDataListeners.set(id, set);
        }
        set.add(callback);
        if (!realtimeConnected) terminalResyncing.add(id);
        const pending = terminalDataBuffers.get(id);
        if (pending) {
          for (const chunk of pending) {
            callback(
              chunk.data,
              chunk.replay === true,
              chunk.replayNeedsQueryResponses === true,
              chunk.replayTruncated === true,
            );
          }
          terminalDataBuffers.delete(id);
          terminalDataBufferSizes.delete(id);
        }
        return () => {
          set!.delete(callback);
          if (set!.size === 0) terminalDataListeners.delete(id);
        };
      },
      onSemanticSnapshot: (id, callback) => {
        const store = semanticStoreFor(id)
        const current = store.snapshot
        if (current) callback(current)
        return store.onChange((snapshot, result) => {
          if (result === "applied" && snapshot) callback(snapshot)
        })
      },
      onExit: (cb) => {
        terminalExitListeners.add(cb);
        return () => terminalExitListeners.delete(cb);
      },
      dispose: (id) => {
        terminalDataBuffers.delete(id);
        terminalDataBufferSizes.delete(id);
        terminalDataListeners.delete(id);
        terminalReplayFloors.delete(id);
        return transport.invoke("terminal:dispose", id);
      },
      acquireLease: (id, mode) =>
        mode === undefined
          ? transport.invoke("terminal:acquireLease", id)
          : transport.invoke("terminal:acquireLease", id, mode),
      renewLease: (id, leaseId) =>
        transport.invoke("terminal:renewLease", id, leaseId),
      releaseLease: (id, leaseId) =>
        transport.invoke("terminal:releaseLease", id, leaseId),
      requestControl: id => transport.invoke("terminal:requestControl", id),
      transferControl: (id, leaseId, targetClientId) =>
        transport.invoke("terminal:transferControl", id, leaseId, targetClientId),
      listViewers: id => transport.invoke("terminal:listViewers", id),
    },
  };
}
