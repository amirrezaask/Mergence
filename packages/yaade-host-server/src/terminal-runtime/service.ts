import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import {
  CreateTerminal,
  InvalidTerminalInput,
  TerminalOutput,
  SessionArchived,
  SessionCreated,
  SessionTabArchived,
  SessionTabCreated,
  SessionTabNotFound,
  SessionTabUpdated,
  SessionUpdated,
  MuxTerminalArchived,
  TerminalConflict,
  MuxTerminalCreated,
  MuxTerminalId,
  TerminalNotFound,
  MuxTerminalUpdated,
  type MuxTerminal,
  type TerminalStatus,
} from "@yaade/rpc";
import type { HostConfig } from "../config.js";
import type { EventHub } from "../events.js";
import type { RuntimeDatabase } from "../runtime-database.js";
import type { MuxSessionStore } from "../mux-store.js";
import {
  TerminalProcessDriver,
  type ProcessDriverDependencies,
} from "./process-driver.js";
import { TerminalRegistry } from "./registry.js";

function eventId(prefix: string, id: string): string {
  return `${prefix}:${id}:${randomUUID()}`;
}

function pendingOutput(_kind: "terminal"): TerminalOutput {
  return TerminalOutput.make({
    kind: "process",
    terminalInstanceId: "pending",
    generation: 1,
    processState: "starting",
    activityState: "starting",
    replayAvailable: false,
    truncated: false,
  });
}

function isLiveStatus(status: TerminalStatus): boolean {
  return status === "created" || status === "starting" || status === "running" || status === "waiting";
}

export type TerminalServiceDependencies = {
  readonly config: HostConfig
  readonly db: RuntimeDatabase
  readonly homeDir: string
  readonly events: EventHub
  readonly muxSessions: MuxSessionStore
  readonly process: ProcessDriverDependencies
}

/** Single host-side mutator for MuxTerminal lifecycle and driver ownership. */
export class TerminalService {
  private readonly registry: TerminalRegistry;
  private readonly operationTails = new Map<MuxTerminalId, Promise<void>>();

  constructor(private readonly deps: TerminalServiceDependencies) {
    this.registry = new TerminalRegistry([new TerminalProcessDriver(deps.process)]);
  }

  async create(command: CreateTerminal): Promise<MuxTerminal> {
    this.assertInputPair(command);
    const store = this.deps.muxSessions;
    const existingTerminals = command.tabId
      ? store.listMuxTerminalsByTab(command.tabId)
      : store.listMuxTerminals(command.sessionId);
    const terminal = store.createMuxTerminal({
      sessionId: command.sessionId,
      tabId: command.tabId,
      kind: command.kind,
      title: command.title?.trim() || defaultTitle(),
      position: existingTerminals.length,
      input: command.input,
      output: pendingOutput(command.kind),
    });
    this.emitCreated(terminal);
    this.selectMuxTerminal(terminal.sessionId, terminal.id);

    return this.withTerminalLock(terminal.id, async () => {
      const starting = store.compareAndSetMuxTerminal(terminal.id, terminal.revision, {
        status: "starting",
      });
      this.emitUpdated(starting);
      try {
        const output = await this.registry
          .get(starting.kind)
          .create(starting, starting.input)
          .pipe(Effect.runPromise);
        const current = this.require(terminal.id);
        const failed =
          output.kind === "process" && output.processState === "failed";
        const running = store.compareAndSetMuxTerminal(current.id, current.revision, {
          status: failed ? "failed" : "running",
          output,
          ...(failed ? { error: "process failed" } : {}),
        });
        this.emitUpdated(running);
        return running;
      } catch (error) {
        const current = store.getMuxTerminal(terminal.id);
        if (!current || current.archivedAt) throw error;
        const failed = store.compareAndSetMuxTerminal(current.id, current.revision, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        this.emitUpdated(failed);
        throw error;
      }
    });
  }

  async cancel(terminalId: MuxTerminalId, expectedRevision: number): Promise<MuxTerminal> {
    return this.withTerminalLock(terminalId, () =>
      this.cancelUnlocked(terminalId, expectedRevision),
    );
  }

  private async cancelUnlocked(
    terminalId: MuxTerminalId,
    expectedRevision: number,
  ): Promise<MuxTerminal> {
    const current = this.require(terminalId);
    this.assertRevision(current, expectedRevision);
    const output = await this.registry
      .get(current.kind)
      .cancel(current)
      .pipe(Effect.runPromise);
    const cancelled = this.deps.muxSessions.compareAndSetMuxTerminal(
      terminalId,
      expectedRevision,
      {
        status: "cancelled",
        output,
      },
    );
    this.emitUpdated(cancelled);
    return cancelled;
  }

  async closeTerminal(terminalId: MuxTerminalId): Promise<MuxTerminal> {
    return this.withTerminalLock(terminalId, () => this.closeTerminalUnlocked(terminalId, true));
  }

  private async closeTerminalUnlocked(
    terminalId: MuxTerminalId,
    stopProcess: boolean,
  ): Promise<MuxTerminal> {
    const existing = this.deps.muxSessions.getMuxTerminal(terminalId);
    if (!existing) {
      throw new TerminalNotFound({
        muxTerminalId: terminalId,
        message: `terminal not found: ${terminalId}`,
      });
    }
    if (existing.archivedAt) return existing;

    let current = existing;
    if (
      stopProcess &&
      isLiveStatus(current.status) &&
      current.output.kind === "process"
    ) {
      const output = await this.registry
        .get(current.kind)
        .cancel(current)
        .pipe(Effect.runPromise);
      current = this.deps.muxSessions.compareAndSetMuxTerminal(
        terminalId,
        current.revision,
        { status: "cancelled", output },
      );
      this.emitUpdated(current);
    }

    const previousSession = this.deps.muxSessions.getSession(current.sessionId);
    const previousTab = current.tabId
      ? this.deps.muxSessions.getTab(current.tabId)
      : undefined;
    const archived = this.deps.muxSessions.archiveMuxTerminal(terminalId);
    this.deps.events.emit("mux:event", [
      MuxTerminalArchived.make({
        eventId: eventId("terminal-archived", archived.id),
        muxTerminalId: archived.id,
        revision: archived.revision,
        occurredAt: archived.updatedAt,
      }),
    ]);
    const nextSession = this.deps.muxSessions.getSession(current.sessionId);
    const nextTab = current.tabId
      ? this.deps.muxSessions.getTab(current.tabId)
      : undefined;
    if (nextTab && previousTab && nextTab.revision !== previousTab.revision) {
      this.emitTabUpdated(nextTab);
    }
    if (
      nextSession &&
      previousSession &&
      nextSession.revision !== previousSession.revision
    ) {
      this.emitSessionUpdated(nextSession);
    }
    return archived;
  }

  async restart(
    terminalId: MuxTerminalId,
    expectedRevision: number,
  ): Promise<MuxTerminal> {
    return this.withTerminalLock(terminalId, () =>
      this.restartUnlocked(terminalId, expectedRevision),
    );
  }

  private async restartUnlocked(
    terminalId: MuxTerminalId,
    expectedRevision: number,
  ): Promise<MuxTerminal> {
    const current = this.require(terminalId);
    this.assertRevision(current, expectedRevision);
    const starting = this.deps.muxSessions.compareAndSetMuxTerminal(
      terminalId,
      expectedRevision,
      {
        status: "starting",
        error: null,
      },
    );
    this.emitUpdated(starting);
    try {
      const output = await this.registry
        .get(starting.kind)
        .restart(starting)
        .pipe(Effect.runPromise);
      const failed =
        output.kind === "process" && output.processState === "failed";
      const result = this.deps.muxSessions.compareAndSetMuxTerminal(
        terminalId,
        starting.revision,
        {
          status: failed ? "failed" : "running",
          output,
          ...(failed ? { error: "process failed" } : {}),
        },
      );
      this.emitUpdated(result);
      return result;
    } catch (error) {
      const currentAfterFailure = this.deps.muxSessions.getMuxTerminal(terminalId);
      if (!currentAfterFailure || currentAfterFailure.archivedAt) throw error;
      const failed = this.deps.muxSessions.compareAndSetMuxTerminal(
        terminalId,
        starting.revision,
        {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        },
      );
      this.emitUpdated(failed);
      throw error;
    }
  }

  async archiveTab(
    tabId: import("@yaade/rpc").SessionTabId,
    stopTerminals: boolean,
  ): Promise<import("@yaade/rpc").SessionTab> {
    const tab = this.deps.muxSessions.getTab(tabId);
    if (!tab) {
      throw new SessionTabNotFound({
        tabId,
        message: `tab not found: ${tabId}`,
      });
    }
    const previousSession = this.deps.muxSessions.getSession(tab.sessionId);
    if (tab.archivedAt) return tab;
    for (const terminal of this.deps.muxSessions.listMuxTerminalsByTab(tabId)) {
      try {
        await this.withTerminalLock(terminal.id, async () => {
          const latest = this.deps.muxSessions.getMuxTerminal(terminal.id);
          if (!latest || latest.archivedAt) return;
          if (stopTerminals && isLiveStatus(latest.status)) {
            try {
              await this.cancelUnlocked(latest.id, latest.revision);
            } catch {
              /* closeTerminalUnlocked retries the driver close below */
            }
          }
          await this.closeTerminalUnlocked(terminal.id, stopTerminals);
        });
      } catch {
        /* continue archiving the tab */
      }
    }
    const visibleTabsBeforeArchive = this.deps.muxSessions.listTabs(tab.sessionId);
    const archived = this.deps.muxSessions.archiveTab(tabId);
    const session = this.deps.muxSessions.getSession(tab.sessionId);
    this.deps.events.emit("mux:event", [
      SessionTabArchived.make({
        eventId: eventId("tab-archived", archived.id),
        revision: archived.revision ?? 1,
        occurredAt: archived.updatedAt,
        tab: archived,
      }),
    ]);
    const replacementTabs = this.deps.muxSessions
      .listTabs(tab.sessionId)
      .filter(candidate => !visibleTabsBeforeArchive.some(previous => previous.id === candidate.id));
    for (const replacement of replacementTabs) {
      this.deps.events.emit("mux:event", [
        SessionTabCreated.make({
          eventId: eventId("tab-created", replacement.id),
          revision: replacement.revision ?? 1,
          occurredAt: replacement.updatedAt,
          tab: replacement,
        }),
      ]);
    }
    if (
      session &&
      (session.activeTabId !== previousSession?.activeTabId ||
        session.activeMuxTerminalId !== previousSession?.activeMuxTerminalId)
    ) {
      this.deps.events.emit("mux:event", [
        SessionUpdated.make({
          eventId: eventId("session-tab-archived", session.id),
          revision: session.revision ?? 1,
          occurredAt: session.updatedAt,
          session,
        }),
      ]);
    }
    return archived;
  }

  async archiveSession(
    sessionId: import("@yaade/rpc").SessionId,
    stopTerminals: boolean,
  ): Promise<import("@yaade/rpc").AppSession> {
    const visibleSessionIds = new Set(
      this.deps.muxSessions.listSessions().map(session => session.id),
    );
    for (const terminal of this.deps.muxSessions.listMuxTerminals(sessionId)) {
      if (
        stopTerminals &&
        (terminal.status === "created" ||
          terminal.status === "starting" ||
          terminal.status === "running" ||
          terminal.status === "waiting")
      ) {
        try {
          await this.cancel(terminal.id, terminal.revision);
        } catch {
          /* continue archiving remaining terminals */
        }
      }
    }
    const session = this.deps.muxSessions.archiveSession(sessionId);
    this.deps.events.emit("mux:event", [
      SessionArchived.make({
        eventId: eventId("session-archived", session.id),
        revision: session.revision ?? 1,
        occurredAt: session.updatedAt,
        session,
      }),
    ]);
    for (const replacement of this.deps.muxSessions.listSessions()) {
      if (visibleSessionIds.has(replacement.id)) continue;
      this.deps.events.emit("mux:event", [
        SessionCreated.make({
          eventId: eventId("session-created", replacement.id),
          revision: replacement.revision ?? 1,
          occurredAt: replacement.updatedAt,
          session: replacement,
        }),
      ]);
      for (const tab of this.deps.muxSessions.listTabs(replacement.id)) {
        this.deps.events.emit("mux:event", [
          SessionTabCreated.make({
            eventId: eventId("tab-created", tab.id),
            revision: tab.revision ?? 1,
            occurredAt: tab.updatedAt,
            tab,
          }),
        ]);
      }
    }
    return session;
  }

  /** Persist selection changes and publish every affected aggregate. */
  selectMuxTerminal(
    sessionId: import("@yaade/rpc").SessionId,
    muxTerminalId: MuxTerminalId | null,
  ): import("@yaade/rpc").AppSession {
    const previousSession = this.deps.muxSessions.getSession(sessionId);
    const previousTab = previousSession?.activeTabId
      ? this.deps.muxSessions.getTab(previousSession.activeTabId)
      : undefined;
    const session = this.deps.muxSessions.setActiveMuxTerminal(
      sessionId,
      muxTerminalId,
    );
    const activeTab = session.activeTabId
      ? this.deps.muxSessions.getTab(session.activeTabId)
      : undefined;
    if (activeTab && activeTab.revision !== previousTab?.revision) {
      this.emitTabUpdated(activeTab);
    }
    if (session.revision !== previousSession?.revision) {
      this.emitSessionUpdated(session);
    }
    return session;
  }

  /** Reorder is a MuxTerminal mutation, so its revision/event policy belongs here. */
  reorderMuxTerminals(
    sessionId: import("@yaade/rpc").SessionId,
    ids: readonly MuxTerminalId[],
    tabId?: import("@yaade/rpc").SessionTabId,
  ): MuxTerminal[] {
    const terminals = this.deps.muxSessions.reorderMuxTerminals(sessionId, ids, tabId);
    for (const muxTerminal of terminals) this.emitUpdated(muxTerminal);
    return terminals;
  }

  onProcessExit(ptyId: string, exitCode: number): void {
    for (const session of this.deps.muxSessions.listSessions(false)) {
      const terminal = this.deps.muxSessions.listMuxTerminals(session.id).find(
        candidate => candidate.output.ptyId === ptyId,
      )
      if (!terminal) continue
      try {
        const updated = this.deps.muxSessions.compareAndSetMuxTerminal(
          terminal.id,
          terminal.revision,
          {
            status: exitCode === 0 ? "succeeded" : "failed",
            output: TerminalOutput.make({
              ...terminal.output,
              processState: "exited",
              activityState: "idle",
              exitCode,
            }),
            ...(exitCode === 0 ? {} : { error: `process exited with ${exitCode}` }),
          },
        )
        this.emitUpdated(updated)
      } catch {
        // A concurrent close or restart already owns this revision.
      }
      return
    }
  }

  reconcile(): void {
    // PTY exit events are authoritative; browser reconnect performs snapshot reconciliation.
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.operationTails.values()].map(operation =>
        operation.catch(() => undefined),
      ),
    );
  }

  private async withTerminalLock<T>(
    id: MuxTerminalId,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.operationTails.get(id);
    let release!: () => void;
    const current = new Promise<void>(resolve => {
      release = resolve;
    });
    const tail = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => current);
    this.operationTails.set(id, tail);
    if (previous) await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.operationTails.get(id) === tail) {
        this.operationTails.delete(id);
      }
    }
  }

  private assertRevision(current: MuxTerminal, expectedRevision: number): void {
    if (current.revision !== expectedRevision) {
      throw new TerminalConflict({
        muxTerminalId: current.id,
        expectedRevision,
        actualRevision: current.revision,
        message: `terminal revision conflict: ${current.id}`,
      });
    }
  }

  private async stopLiveProcess(current: MuxTerminal): Promise<void> {
    if (current.output.kind !== "process" || !isLiveStatus(current.status)) return;
    try {
      await this.registry
        .get(current.kind)
        .cancel(current)
        .pipe(Effect.runPromise);
    } catch {
      /* instance may already be gone */
    }
  }

  private require(id: MuxTerminalId): MuxTerminal {
    const terminal = this.deps.muxSessions.getMuxTerminal(id);
    if (!terminal || terminal.archivedAt)
      throw new TerminalNotFound({
        muxTerminalId: id,
        message: `terminal not found: ${id}`,
      });
    return terminal;
  }

  private assertInputPair(command: CreateTerminal): void {
    const valid =
      command.kind === "terminal" && command.input.kind === "terminal";
    if (!valid) {
      throw new InvalidTerminalInput({
        message: "terminal kind does not match input",
      });
    }
  }

  private emitCreated(terminal: MuxTerminal): void {
    this.deps.events.emit("mux:event", [
      MuxTerminalCreated.make({
        eventId: eventId("terminal-created", terminal.id),
        muxTerminalId: terminal.id,
        revision: terminal.revision,
        occurredAt: terminal.updatedAt,
        muxTerminal: terminal,
      }),
    ]);
  }

  private emitUpdated(terminal: MuxTerminal): void {
    this.deps.events.emit("mux:event", [
      MuxTerminalUpdated.make({
        eventId: eventId("terminal-updated", terminal.id),
        muxTerminalId: terminal.id,
        revision: terminal.revision,
        occurredAt: terminal.updatedAt,
        muxTerminal: terminal,
      }),
    ]);
  }

  private emitTabUpdated(tab: import("@yaade/rpc").SessionTab): void {
    this.deps.events.emit("mux:event", [
      SessionTabUpdated.make({
        eventId: eventId("tab-updated", tab.id),
        revision: tab.revision ?? 1,
        occurredAt: tab.updatedAt,
        tab,
      }),
    ]);
  }

  private emitSessionUpdated(session: import("@yaade/rpc").AppSession): void {
    this.deps.events.emit("mux:event", [
      SessionUpdated.make({
        eventId: eventId("session-updated", session.id),
        revision: session.revision ?? 1,
        occurredAt: session.updatedAt,
        session,
      }),
    ]);
  }
}

function defaultTitle(): string {
  return "Terminal";
}
