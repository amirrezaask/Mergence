import { Effect, Schema } from "effect";
import {
  assertAllowedUri,
  type TerminalInspectSnapshot,
  type TerminalLaunch,
  type TerminalMutationFence,
} from "@yaade/node-host";
import {
  ArchiveSession,
  CloseTerminal,
  StopTerminal,
  CreateSession,
  CreateSessionTab,
  RenameSessionTab,
  SaveSessionTabLayout,
  ReorderSessionTabs,
  ArchiveSessionTab,
  SelectSessionTab,
  CreateTerminal,
  GetSession,
  GetTerminal,
  ListSessions,
  ReorderSessions,
  ReorderTerminals,
  RestoreSession,
  RenameSession,
  RestartTerminal,
  SelectSessionTerminal,
  SessionNotFound,
  SessionTabConflict,
  SessionTabNotFound,
  TerminalNotFound,
  InvalidTerminalInput,
  InvalidMuxCommand,
  InvalidRpcPayloadError,
  TerminalConflict,
  TerminalRuntimeFailure,
  TerminalLeaseError,
  TerminalMutationFence as RpcTerminalMutationFence,
  ScopeDeniedError,
  SessionCreated,
  SessionRestored,
  SessionUpdated,
  SessionTabCreated,
  SessionTabUpdated,
  MuxTerminalUpdated,
  ConflictError,
  decodeHostRouteArgs,
  decodeHostRouteResult,
  isHostRouteName,
  OperationFailedError,
  NotFoundError,
  PathOutsideRootsError,
  UnknownChannelError,
  unknownChannel,
  type HostRpcError,
} from "@yaade/rpc";
import { fileUriToPath } from "@yaade/shared";
import { HostRuntimeTag } from "./effect/tags.js";
import type { HostRuntime } from "./host-runtime.js";
import { TerminalRuntimeDriverFailure } from "./terminal-runtime/errors.js"
import { principalMayInvoke } from "./route-policy.js"
import {
  makeCompatibilityPrincipal,
  type RequestPrincipal,
} from "./principal.js";
import {
  bindOwnerFence,
  controlErrorToHostError,
  currentOwnerWriter,
  mapControlError,
  toRuntimeLease,
} from "./terminal-authority.js";

export type { HostRuntime } from "./host-runtime.js";
export { createRuntime, shutdownRuntime } from "./host-runtime.js";

function decodeMuxCommand<S extends Schema.Schema.AnyNoContext>(
  schema: S,
  value: unknown,
  name: string,
): Schema.Schema.Type<S> {
  try {
    return Schema.decodeUnknownSync(schema)(value);
  } catch {
    throw new InvalidMuxCommand({ message: `invalid ${name} command` });
  }
}

export function mapDispatchError(
  channel: string,
  error: unknown,
): HostRpcError {
  if (
    error instanceof ConflictError ||
    error instanceof InvalidRpcPayloadError ||
    error instanceof NotFoundError ||
    error instanceof PathOutsideRootsError ||
    error instanceof SessionNotFound ||
    error instanceof SessionTabConflict ||
    error instanceof SessionTabNotFound ||
    error instanceof TerminalNotFound ||
    error instanceof InvalidTerminalInput ||
    error instanceof InvalidMuxCommand ||
    error instanceof TerminalConflict ||
    error instanceof TerminalRuntimeFailure ||
    error instanceof TerminalLeaseError
  ) {
    return error;
  }
  const controlError = mapControlError(error);
  if (controlError) return controlError;
  if (error instanceof TerminalRuntimeDriverFailure) {
    return new TerminalRuntimeFailure({
      muxTerminalId: error.muxTerminalId,
      message: error.message,
      cause: error.cause,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("not allowed") || message.includes("PATH_OUTSIDE")) {
    return new PathOutsideRootsError({ message });
  }
  if (message.startsWith("unknown host channel:")) {
    return unknownChannel(channel);
  }
  if (message.startsWith("unknown")) {
    return new UnknownChannelError({ channel, message });
  }
  return new OperationFailedError({ message, cause: error });
}

export type DispatchEnv = HostRuntimeTag;

export function dispatch(
  channel: string,
  args: unknown[],
  principalOrClientId: RequestPrincipal | string,
  _signal?: AbortSignal,
): Effect.Effect<unknown, HostRpcError, DispatchEnv> {
  return Effect.gen(function* () {
    if (!isHostRouteName(channel)) {
      return yield* Effect.fail(unknownChannel(channel));
    }
    const principal =
      typeof principalOrClientId === "string"
        ? makeCompatibilityPrincipal(principalOrClientId)
        : principalOrClientId
    if (!principalMayInvoke(principal, channel)) {
      return yield* Effect.fail(
        new ScopeDeniedError({
          message: "principal does not have the capability for this operation",
          channel,
        }),
      )
    }
    const decodedArgs = yield* Effect.try({
      try: () => decodeHostRouteArgs(channel, args),
      catch: cause =>
        new InvalidRpcPayloadError({
          message: `invalid arguments for host route ${channel}`,
          cause,
        }),
    });
    const runtime = yield* HostRuntimeTag
    const value = yield* Effect.tryPromise({
      try: () => dispatchImpl(runtime, channel, decodedArgs, principal),
      catch: err => mapDispatchError(channel, err),
    })
    return yield* Effect.try({
      try: () => decodeHostRouteResult(channel, value),
      catch: cause =>
        new InvalidRpcPayloadError({
          message: `invalid result for host route ${channel}`,
          cause,
        }),
    });
  });
}

export function dispatchPromise(
  runtime: HostRuntime,
  channel: string,
  args: unknown[],
  principalOrClientId: RequestPrincipal | string,
  signal?: AbortSignal,
): Promise<unknown> {
  return Effect.runPromise(
    dispatch(channel, args, principalOrClientId, signal).pipe(
      Effect.provideService(HostRuntimeTag, runtime),
    ),
  );
}

async function dispatchImpl(
  runtime: HostRuntime,
  channel: string,
  args: unknown[],
  principal: RequestPrincipal,
): Promise<unknown> {
  const clientId = principal.connectionId

  if (channel.startsWith("mux:")) return handleMux(runtime, channel, args);
  if (channel.startsWith("terminal:"))
    return handleTerminal(runtime, channel, args, clientId, principal);

  throw new Error(`unknown host channel: ${channel}`);
}

async function handleMux(
  runtime: HostRuntime,
  channel: string,
  args: unknown[],
): Promise<unknown> {
  const store = runtime.muxSessions;
  switch (channel) {
    case "mux:listSessions": {
      const command = decodeMuxCommand(
        ListSessions,
        {
          _tag: "ListSessions",
          ...(args[0] === true ? { includeArchived: true } : {}),
        },
        "list sessions",
      );
      return store
        .listSessions(command.includeArchived === true)
        .map((session) => ({
          session,
          tabs: store.listTabs(session.id, command.includeArchived === true),
          muxTerminals: store.listMuxTerminals(
            session.id,
            command.includeArchived === true,
          ),
        }));
    }
    case "mux:createSession": {
      const command = decodeMuxCommand(
        CreateSession,
        {
          _tag: "CreateSession",
          ...(typeof args[0] === "string" ? { title: args[0] } : {}),
        },
        "create session",
      );
      const session = store.createSession(command.title ?? "New session");
      const tabs = store.listTabs(session.id);
      runtime.events.emit("mux:event", [
        SessionCreated.make({
          eventId: `evt-${Date.now()}`,
          revision: session.revision ?? 1,
          occurredAt: session.updatedAt,
          session,
        }),
        ...tabs.map((tab) =>
          SessionTabCreated.make({
            eventId: `evt-tab-${Date.now()}-${tab.id}`,
            revision: tab.revision ?? 1,
            occurredAt: tab.updatedAt,
            tab,
          }),
        ),
      ]);
      return store.getSession(session.id) ?? session;
    }
    case "mux:reorderSessions": {
      const command = decodeMuxCommand(
        ReorderSessions,
        args[0],
        "reorder sessions",
      );
      const sessions = store.reorderSessions(command.sessionIds);
      for (const session of sessions) {
        runtime.events.emit("mux:event", [
          SessionUpdated.make({
            eventId: `evt-session-reorder-${Date.now()}-${session.id}`,
            revision: session.revision ?? 1,
            occurredAt: session.updatedAt,
            session,
          }),
        ]);
      }
      return sessions;
    }
    case "mux:createTab": {
      const command = decodeMuxCommand(
        CreateSessionTab,
        args[0],
        "create tab",
      );
      const previousSession = store.getSession(command.sessionId);
      const tab = store.createTab(
        command.sessionId,
        command.title ?? "New tab",
      );
      runtime.events.emit("mux:event", [
        SessionTabCreated.make({
          eventId: `evt-tab-${Date.now()}-${tab.id}`,
          revision: tab.revision ?? 1,
          occurredAt: tab.updatedAt,
          tab,
        }),
      ]);
      const nextSession = store.getSession(command.sessionId);
      if (
        nextSession &&
        previousSession &&
        nextSession.revision !== previousSession.revision
      ) {
        runtime.events.emit("mux:event", [
          SessionUpdated.make({
            eventId: `evt-session-tab-created-${Date.now()}-${nextSession.id}`,
            revision: nextSession.revision ?? 1,
            occurredAt: nextSession.updatedAt,
            session: nextSession,
          }),
        ]);
      }
      return tab;
    }
    case "mux:renameTab": {
      const command = decodeMuxCommand(
        RenameSessionTab,
        args[0],
        "rename tab",
      );
      const tab = store.renameTab(command.tabId, command.title);
      runtime.events.emit("mux:event", [
        SessionTabUpdated.make({
          eventId: `evt-tab-${Date.now()}-${tab.id}`,
          revision: tab.revision ?? 1,
          occurredAt: tab.updatedAt,
          tab,
        }),
      ]);
      return tab;
    }
    case "mux:saveTabLayout": {
      const command = decodeMuxCommand(
        SaveSessionTabLayout,
        args[0],
        "save tab layout",
      );
      const tab = store.saveTabLayout(
        command.tabId,
        command.layoutJson,
        command.revision,
      );
      runtime.events.emit("mux:event", [
        SessionTabUpdated.make({
          eventId: `evt-tab-layout-${Date.now()}-${tab.id}`,
          revision: tab.revision ?? 1,
          occurredAt: tab.updatedAt,
          tab,
        }),
      ]);
      return tab;
    }
    case "mux:reorderTabs": {
      const command = decodeMuxCommand(
        ReorderSessionTabs,
        args[0],
        "reorder tabs",
      );
      const tabs = store.reorderTabs(command.sessionId, command.tabIds);
      for (const tab of tabs) {
        runtime.events.emit("mux:event", [
          SessionTabUpdated.make({
            eventId: `evt-tab-reorder-${Date.now()}-${tab.id}`,
            revision: tab.revision ?? 1,
            occurredAt: tab.updatedAt,
            tab,
          }),
        ]);
      }
      return tabs;
    }
    case "mux:archiveTab": {
      const command = decodeMuxCommand(
        ArchiveSessionTab,
        args[0],
        "archive tab",
      );
      const tab = await runtime.terminalService.archiveTab(
        command.tabId,
        command.mode === "stop-terminals",
      );
      return tab;
    }
    case "mux:selectTab": {
      const command = decodeMuxCommand(
        SelectSessionTab,
        args[0],
        "select tab",
      );
      const tabId =
        command.tabId ?? store.listTabs(command.sessionId)[0]?.id ?? null;
      const session = store.setActiveTab(command.sessionId, tabId);
      runtime.events.emit("mux:event", [
        SessionUpdated.make({
          eventId: `evt-session-tab-${Date.now()}`,
          revision: session.revision ?? 1,
          occurredAt: session.updatedAt,
          session,
        }),
      ]);
      return session;
    }
    case "mux:archiveSession": {
      const command = decodeMuxCommand(
        ArchiveSession,
        args[0],
        "archive session",
      );
      return runtime.terminalService.archiveSession(
        command.sessionId,
        command.mode === "stop-terminals",
      );
    }
    case "mux:restoreSession": {
      const command = decodeMuxCommand(
        RestoreSession,
        args[0],
        "restore session",
      );
      const session = store.restoreSession(command.sessionId);
      runtime.events.emit("mux:event", [
        SessionRestored.make({
          eventId: `evt-${Date.now()}`,
          revision: session.revision ?? 1,
          occurredAt: session.updatedAt,
          session,
        }),
      ]);
      return session;
    }
    case "mux:renameSession": {
      const command = decodeMuxCommand(
        RenameSession,
        {
          _tag: "RenameSession",
          sessionId: args[0],
          title: args[1],
        },
        "rename session",
      );
      const session = store.renameSession(command.sessionId, command.title);
      runtime.events.emit("mux:event", [
        SessionUpdated.make({
          eventId: `evt-${Date.now()}`,
          revision: session.revision ?? 1,
          occurredAt: session.updatedAt,
          session,
        }),
      ]);
      return session;
    }
    case "mux:getSession": {
      const command = decodeMuxCommand(
        GetSession,
        {
          _tag: "GetSession",
          sessionId: args[0],
        },
        "get session",
      );
      const session = store.getSession(command.sessionId);
      return session
        ? {
            session,
            tabs: store.listTabs(session.id),
            muxTerminals: store.listMuxTerminals(session.id),
          }
        : null;
    }
    case "mux:getTerminal": {
      const command = decodeMuxCommand(
        GetTerminal,
        {
          _tag: "GetTerminal",
          muxTerminalId: args[0],
        },
        "get terminal",
      );
      return store.getMuxTerminal(command.muxTerminalId);
    }
    case "mux:reorderTerminals": {
      const command = decodeMuxCommand(
        ReorderTerminals,
        args[0],
        "reorder terminals",
      );
      return runtime.terminalService.reorderMuxTerminals(
        command.sessionId,
        command.muxTerminalIds,
        command.tabId,
      );
    }
    case "mux:selectTerminal": {
      const command = decodeMuxCommand(
        SelectSessionTerminal,
        {
          _tag: "SelectSessionTerminal",
          sessionId: args[0],
          ...(args[1] == null ? {} : { muxTerminalId: args[1] }),
        },
        "select terminal",
      );
      return runtime.terminalService.selectMuxTerminal(
        command.sessionId,
        command.muxTerminalId ?? null,
      );
    }
    case "mux:createTerminal": {
      const command = decodeMuxCommand(
        CreateTerminal,
        args[0],
        "create terminal",
      );
      return runtime.terminalService.create(command);
    }
    case "mux:stopTerminal": {
      const command = decodeMuxCommand(
        StopTerminal,
        {
          _tag: "StopTerminal",
          muxTerminalId: args[0],
          revision: args[1],
        },
        "cancel terminal",
      );
      return runtime.terminalService.cancel(
        command.muxTerminalId,
        command.revision,
      );
    }
    case "mux:restartTerminal": {
      const command = decodeMuxCommand(
        RestartTerminal,
        {
          _tag: "RestartTerminal",
          muxTerminalId: args[0],
          revision: args[1],
        },
        "restart terminal",
      );
      return runtime.terminalService.restart(
        command.muxTerminalId,
        command.revision,
      );
    }
    case "mux:closeTerminal": {
      const command = decodeMuxCommand(
        CloseTerminal,
        args[0],
        "archive terminal",
      );
      return runtime.terminalService.closeTerminal(command.muxTerminalId);
    }
    case "mux:renameTerminal": {
      const muxTerminalId = args[0];
      const title = typeof args[1] === "string" ? args[1] : "";
      if (typeof muxTerminalId !== "string" || !title.trim())
        throw new InvalidMuxCommand({
          message: "invalid rename terminal command",
        });
      const terminal = store.renameMuxTerminal(muxTerminalId as never, title);
      runtime.events.emit("mux:event", [
        MuxTerminalUpdated.make({
          eventId: `evt-${Date.now()}`,
          muxTerminalId: terminal.id,
          revision: terminal.revision,
          occurredAt: terminal.updatedAt,
          muxTerminal: terminal,
        }),
      ]);
      return terminal;
    }
    default:
      throw new Error(`unknown mux channel: ${channel}`);
  }
}

async function ownerMutationFence(
  runtime: HostRuntime,
  id: string,
  inspected: TerminalInspectSnapshot,
  principal: RequestPrincipal,
  decoded: Schema.Schema.Type<typeof RpcTerminalMutationFence> | null,
): Promise<TerminalMutationFence> {
  let writer = await currentOwnerWriter(runtime.terminal, id, principal)
  // A supplied fence may intentionally be stale; keep the primary writer
  // available so the terminal control registry can return its normal stale
  // lease error instead of turning it into a missing-writer error.
  if (!writer && decoded) writer = await currentOwnerWriter(runtime.terminal, id)
  if (!writer) {
    const leases = await Promise.resolve(runtime.terminal.listLeases(id))
    const observer = leases.find(
      lease =>
        lease.mode === "observer" &&
        lease.principalId === principal.principalId &&
        lease.connectionId === principal.connectionId,
    )
    if (observer) {
      throw new TerminalLeaseError({
        code: "WRITER_LEASE_REQUIRED",
        terminalId: id,
        message: "an active writer lease is required",
      })
    }
    writer = await Promise.resolve(runtime.terminal.acquireLease(
      id,
      inspected.terminalEpoch ?? "",
      principal.principalId,
      principal.connectionId,
      "writer",
    ))
  }
  return bindOwnerFence(id, decoded, principal, writer)
}

async function handleTerminal(
  runtime: HostRuntime,
  channel: string,
  args: unknown[],
  clientId: string,
  principal: RequestPrincipal,
): Promise<unknown> {
  switch (channel) {
    case "terminal:create": {
      const cwdUri = str(args[0], "cwdUri");
      await assertAllowedUri(
        cwdUri,
        runtime.config.allowedRoots,
        fileUriToPath,
      );
      const launch = (args[1] as TerminalLaunch | null | undefined) ?? null;
      const created = await Promise.resolve(
        runtime.terminal.create(cwdUri, launch, clientId),
      );
      return created;
    }
    case "terminal:acquireLease": {
      const id = str(args[0], "id")
      const inspected = await Promise.resolve(runtime.terminal.inspect(id))
      if (!inspected) throw new NotFoundError({ message: `terminal ${id} not found`, resource: id })
      const mode = args[1] === "observer" ? "observer" : "writer"
      try {
        const lease = await Promise.resolve(runtime.terminal.acquireLease(
          id,
          inspected.terminalEpoch ?? "",
          principal.principalId,
          principal.connectionId,
          mode,
        ))
        return toRuntimeLease(lease, id)
      } catch (error) {
        controlErrorToHostError(error)
      }
    }
    case "terminal:renewLease": {
      const id = str(args[0], "id")
      const leaseId = str(args[1], "leaseId")
      const inspected = await Promise.resolve(runtime.terminal.inspect(id))
      if (!inspected) throw new NotFoundError({ message: `terminal ${id} not found`, resource: id })
      try {
        const lease = await Promise.resolve(runtime.terminal.renewLease(
          id,
          inspected.terminalEpoch ?? "",
          leaseId,
          principal.principalId,
          principal.connectionId,
        ))
        return toRuntimeLease(lease, id)
      } catch (error) {
        controlErrorToHostError(error)
      }
    }
    case "terminal:releaseLease": {
      const id = str(args[0], "id")
      const leaseId = str(args[1], "leaseId")
      const inspected = await Promise.resolve(runtime.terminal.inspect(id))
      if (!inspected) throw new NotFoundError({ message: `terminal ${id} not found`, resource: id })
      try {
        await Promise.resolve(runtime.terminal.releaseLease(
          id,
          inspected.terminalEpoch ?? "",
          leaseId,
          principal.principalId,
          principal.connectionId,
        ))
        return null
      } catch (error) {
        controlErrorToHostError(error)
      }
    }
    case "terminal:requestControl": {
      const id = str(args[0], "id")
      const inspected = await Promise.resolve(runtime.terminal.inspect(id))
      if (!inspected) throw new NotFoundError({ message: `terminal ${id} not found`, resource: id })
      try {
        const lease = await Promise.resolve(runtime.terminal.forceTakeover(
          id,
          inspected.terminalEpoch ?? "",
          principal.principalId,
          principal.connectionId,
        ))
        return toRuntimeLease(lease, id)
      } catch (error) {
        controlErrorToHostError(error)
      }
    }
    case "terminal:transferControl": {
      const id = str(args[0], "id")
      const leaseId = str(args[1], "leaseId")
      const targetClientId = str(args[2], "targetClientId")
      const inspected = await Promise.resolve(runtime.terminal.inspect(id))
      if (!inspected) throw new NotFoundError({ message: `terminal ${id} not found`, resource: id })
      try {
        const lease = await Promise.resolve(runtime.terminal.transferLease(
          id,
          inspected.terminalEpoch ?? "",
          leaseId,
          principal.principalId,
          principal.connectionId,
          principal.principalId,
          targetClientId,
        ))
        return toRuntimeLease(lease, id)
      } catch (error) {
        controlErrorToHostError(error)
      }
    }
    case "terminal:listViewers": {
      const leases = await Promise.resolve(runtime.terminal.listLeases(str(args[0], "id")))
      return [...new Set(leases.map(lease => lease.connectionId))]
    }
    case "terminal:write": {
      const id = str(args[0], "id");
      const inspected = await Promise.resolve(runtime.terminal.inspect(id))
      if (!inspected) {
        throw new NotFoundError({ message: `terminal ${id} not found`, resource: id });
      }
      const data = String(args[1] ?? "");
      try {
        const fence = await ownerMutationFence(
          runtime,
          id,
          inspected,
          principal,
          decodeMutationFence(args[2]),
        )
        await Promise.resolve(runtime.terminal.writeFenced(id, data, fence))
      } catch (error) {
        controlErrorToHostError(error)
      }
      return null;
    }
    case "terminal:writeBinary": {
      const id = str(args[0], "id");
      const inspected = await Promise.resolve(runtime.terminal.inspect(id))
      if (!inspected) {
        throw new NotFoundError({ message: `terminal ${id} not found`, resource: id });
      }
      try {
        const fence = await ownerMutationFence(
          runtime,
          id,
          inspected,
          principal,
          decodeMutationFence(args[2]),
        )
        return Promise.resolve(runtime.terminal.writeBinaryFenced(id, String(args[1] ?? ""), fence))
      } catch (error) {
        controlErrorToHostError(error)
      }
    }
    case "terminal:resize": {
      const id = str(args[0], "id");
      const inspected = await Promise.resolve(runtime.terminal.inspect(id))
      if (!inspected) {
        throw new NotFoundError({ message: `terminal ${id} not found`, resource: id });
      }
      try {
        const fence = await ownerMutationFence(
          runtime,
          id,
          inspected,
          principal,
          decodeMutationFence(args[3]),
        )
        return Promise.resolve(runtime.terminal.resizeFenced(
          id,
          typeof args[1] === "number" ? args[1] : undefined,
          typeof args[2] === "number" ? args[2] : undefined,
          fence,
        ))
      } catch (error) {
        controlErrorToHostError(error)
      }
    }
    case "terminal:ready":
      return Promise.resolve(
        runtime.terminal.markReplayReady(str(args[0], "id"), clientId),
      );
    case "terminal:attach": {
      const id = str(args[0], "id");
      const inspected = await Promise.resolve(runtime.terminal.inspect(id))
      if (!inspected) throw new NotFoundError({ message: `terminal ${id} not found`, resource: id })
      const mode = principalMayInvoke(principal, "terminal:write") ? "writer" : "observer"
      try {
        await Promise.resolve(runtime.terminal.acquireLease(
          id,
          inspected.terminalEpoch ?? "",
          principal.principalId,
          principal.connectionId,
          mode,
        ))
      } catch (error) {
        controlErrorToHostError(error)
      }
      return Promise.resolve(
        runtime.terminal.attach(
          id,
          clientId,
          typeof args[1] === "number" ? args[1] : undefined,
        ),
      );
    }
    case "terminal:readReplayPage":
      return runtime.terminal.readReplayPage(
        str(args[0], "id"),
        typeof args[1] === "number" ? args[1] : 0,
        typeof args[2] === "number" ? args[2] : undefined,
      );
    case "terminal:getCwd":
      return Promise.resolve(runtime.terminal.getCwd(str(args[0], "id")));
    case "terminal:getForegroundProcess":
      return Promise.resolve(
        runtime.terminal.getForegroundProcess(str(args[0], "id")),
      );
    case "terminal:dispose": {
      const id = str(args[0], "id");
      const inspected = await Promise.resolve(runtime.terminal.inspect(id))
      if (!inspected) {
        throw new NotFoundError({ message: `terminal ${id} not found`, resource: id })
      }
      try {
        const fence = await ownerMutationFence(
          runtime,
          id,
          inspected,
          principal,
          decodeMutationFence(args[1]),
        )
        await Promise.resolve(runtime.terminal.disposeFenced(id, fence))
      } catch (error) {
        controlErrorToHostError(error)
      }
      // A terminal can be disposed while its replay remains useful to a
      // client. The terminal exit callback still owns lifecycle updates.
      return null;
    }
    default:
      throw new Error(`unknown terminal channel: ${channel}`);
  }
}

function decodeMutationFence(
  value: unknown,
): Schema.Schema.Type<typeof RpcTerminalMutationFence> | null {
  if (value === undefined) return null
  try {
    return Schema.decodeUnknownSync(RpcTerminalMutationFence)(value)
  } catch {
    return null
  }
}

function str(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`missing ${label}`);
  return value;
}

