import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import {
  CreateToolUse,
  GitToolOutput,
  InvalidToolInput,
  ProcessToolOutput,
  SessionArchived,
  SessionCreated,
  SessionTabArchived,
  SessionTabCreated,
  SessionTabNotFound,
  SessionTabUpdated,
  SessionUpdated,
  ToolUseArchived,
  ToolUseConflict,
  ToolUseCreated,
  ToolUseId,
  ToolUseNotFound,
  ToolUseUpdated,
  type ToolUse,
  type ToolUseOutput,
  type ToolUseStatus,
} from "@yaade/rpc";
import type { HostRuntime } from "../host-runtime.js";
import { resolveToolContext } from "./context-resolver.js";
import { ProcessToolDriver, processOutput } from "./process-driver.js";
import { GitToolDriver } from "./git-driver.js";
import { ToolRegistry } from "./registry.js";

function eventId(prefix: string, id: string): string {
  return `${prefix}:${id}:${randomUUID()}`;
}

function pendingOutput(kind: "terminal" | "git"): ToolUseOutput {
  if (kind === "git") return GitToolOutput.make({ kind: "git" });
  return ProcessToolOutput.make({
    kind: "process",
    terminalInstanceId: "pending",
    generation: 1,
    processState: "starting",
    activityState: "starting",
    replayAvailable: false,
    truncated: false,
  });
}

function isLiveStatus(status: ToolUseStatus): boolean {
  return status === "created" || status === "starting" || status === "running" || status === "waiting";
}

function withoutPty(output: ProcessToolOutput): ProcessToolOutput {
  const { ptyId: _ptyId, ...rest } = output;
  return ProcessToolOutput.make({ ...rest, replayAvailable: false });
}

/** Single host-side mutator for ToolUse lifecycle and driver ownership. */
export class ToolService {
  private readonly registry: ToolRegistry;
  private readonly operationTails = new Map<ToolUseId, Promise<void>>();

  constructor(private readonly runtime: HostRuntime) {
    this.registry = new ToolRegistry([
      new ProcessToolDriver(runtime),
      new GitToolDriver(),
    ]);
  }

  async create(command: CreateToolUse): Promise<ToolUse> {
    this.assertInputPair(command);
    const context = await resolveToolContext(
      {
        config: this.runtime.config,
        db: this.runtime.db,
        homeDir: this.runtime.homeDir,
      },
      command,
    );
    const store = this.runtime.toolSessions;
    const existingUses = command.tabId
      ? store.listToolUsesByTab(command.tabId)
      : store.listToolUses(command.sessionId);
    const use = store.createToolUse({
      sessionId: command.sessionId,
      tabId: command.tabId,
      kind: command.kind,
      title: command.title?.trim() || defaultTitle(command.kind),
      position: existingUses.length,
      context,
      input: command.input,
      output: pendingOutput(command.kind),
    });
    this.emitCreated(use);
    this.selectToolUse(use.sessionId, use.id);

    return this.withToolLock(use.id, async () => {
      const starting = store.compareAndSetToolUse(use.id, use.revision, {
        status: "starting",
      });
      this.emitUpdated(starting);
      try {
        const output = await this.registry
          .get(starting.kind)
          .create(starting, starting.input)
          .pipe(Effect.runPromise);
        const current = this.require(use.id);
        const failed =
          output.kind === "process" && output.processState === "failed";
        const running = store.compareAndSetToolUse(current.id, current.revision, {
          status: failed ? "failed" : "running",
          output,
          ...(failed ? { error: "process failed" } : {}),
        });
        this.emitUpdated(running);
        return running;
      } catch (error) {
        const current = store.getToolUse(use.id);
        if (!current || current.archivedAt) throw error;
        const failed = store.compareAndSetToolUse(current.id, current.revision, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        this.emitUpdated(failed);
        throw error;
      }
    });
  }

  async updateContext(
    command: CreateToolUse,
    useId: ToolUseId,
    expectedRevision: number,
  ): Promise<ToolUse> {
    return this.withToolLock(useId, async () => {
      const current = this.require(useId);
      this.assertRevision(current, expectedRevision);
      const context = await resolveToolContext(
        {
          config: this.runtime.config,
          db: this.runtime.db,
          homeDir: this.runtime.homeDir,
        },
        command,
      );
      if (
        current.context.checkoutPath === context.checkoutPath &&
        current.context.project.projectId === context.project.projectId
      ) {
        return current;
      }

      await this.stopLiveProcess(current);
      const updated = this.runtime.toolSessions.updateToolUseContext(
        useId,
        expectedRevision,
        context,
      );
      this.emitUpdated(updated);
      return this.restartUnlocked(updated.id, updated.revision);
    });
  }

  async cancel(useId: ToolUseId, expectedRevision: number): Promise<ToolUse> {
    return this.withToolLock(useId, () =>
      this.cancelUnlocked(useId, expectedRevision),
    );
  }

  private async cancelUnlocked(
    useId: ToolUseId,
    expectedRevision: number,
  ): Promise<ToolUse> {
    const current = this.require(useId);
    this.assertRevision(current, expectedRevision);
    const output = await this.registry
      .get(current.kind)
      .cancel(current)
      .pipe(Effect.runPromise);
    const cancelled = this.runtime.toolSessions.compareAndSetToolUse(
      useId,
      expectedRevision,
      {
        status: "cancelled",
        output,
      },
    );
    this.emitUpdated(cancelled);
    return cancelled;
  }

  async archiveUse(useId: ToolUseId): Promise<ToolUse> {
    return this.withToolLock(useId, () => this.archiveUseUnlocked(useId, true));
  }

  private async archiveUseUnlocked(
    useId: ToolUseId,
    stopProcess: boolean,
  ): Promise<ToolUse> {
    const existing = this.runtime.toolSessions.getToolUse(useId);
    if (!existing) {
      throw new ToolUseNotFound({
        toolUseId: useId,
        message: `tool use not found: ${useId}`,
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
      current = this.runtime.toolSessions.compareAndSetToolUse(
        useId,
        current.revision,
        { status: "cancelled", output },
      );
      this.emitUpdated(current);
    }

    const previousSession = this.runtime.toolSessions.getSession(current.sessionId);
    const previousTab = current.tabId
      ? this.runtime.toolSessions.getTab(current.tabId)
      : undefined;
    const archived = this.runtime.toolSessions.archiveToolUse(useId);
    this.runtime.events.emit("tools:event", [
      ToolUseArchived.make({
        eventId: eventId("tool-archived", archived.id),
        toolUseId: archived.id,
        revision: archived.revision,
        occurredAt: archived.updatedAt,
      }),
    ]);
    const nextSession = this.runtime.toolSessions.getSession(current.sessionId);
    const nextTab = current.tabId
      ? this.runtime.toolSessions.getTab(current.tabId)
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
    useId: ToolUseId,
    expectedRevision: number,
  ): Promise<ToolUse> {
    return this.withToolLock(useId, () =>
      this.restartUnlocked(useId, expectedRevision),
    );
  }

  private async restartUnlocked(
    useId: ToolUseId,
    expectedRevision: number,
  ): Promise<ToolUse> {
    const current = this.require(useId);
    this.assertRevision(current, expectedRevision);
    const starting = this.runtime.toolSessions.compareAndSetToolUse(
      useId,
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
      const result = this.runtime.toolSessions.compareAndSetToolUse(
        useId,
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
      const currentAfterFailure = this.runtime.toolSessions.getToolUse(useId);
      if (!currentAfterFailure || currentAfterFailure.archivedAt) throw error;
      const failed = this.runtime.toolSessions.compareAndSetToolUse(
        useId,
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
    stopTools: boolean,
  ): Promise<import("@yaade/rpc").SessionTab> {
    const tab = this.runtime.toolSessions.getTab(tabId);
    if (!tab) {
      throw new SessionTabNotFound({
        tabId,
        message: `tab not found: ${tabId}`,
      });
    }
    const previousSession = this.runtime.toolSessions.getSession(tab.sessionId);
    if (tab.archivedAt) return tab;
    for (const use of this.runtime.toolSessions.listToolUsesByTab(tabId)) {
      try {
        await this.withToolLock(use.id, async () => {
          const latest = this.runtime.toolSessions.getToolUse(use.id);
          if (!latest || latest.archivedAt) return;
          if (stopTools && isLiveStatus(latest.status)) {
            try {
              await this.cancelUnlocked(latest.id, latest.revision);
            } catch {
              /* archiveUseUnlocked retries the driver close below */
            }
          }
          await this.archiveUseUnlocked(use.id, stopTools);
        });
      } catch {
        /* continue archiving the tab */
      }
    }
    const visibleTabsBeforeArchive = this.runtime.toolSessions.listTabs(tab.sessionId);
    const archived = this.runtime.toolSessions.archiveTab(tabId);
    const session = this.runtime.toolSessions.getSession(tab.sessionId);
    this.runtime.events.emit("tools:event", [
      SessionTabArchived.make({
        eventId: eventId("tab-archived", archived.id),
        revision: archived.revision ?? 1,
        occurredAt: archived.updatedAt,
        tab: archived,
      }),
    ]);
    const replacementTabs = this.runtime.toolSessions
      .listTabs(tab.sessionId)
      .filter(candidate => !visibleTabsBeforeArchive.some(previous => previous.id === candidate.id));
    for (const replacement of replacementTabs) {
      this.runtime.events.emit("tools:event", [
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
        session.activeToolUseId !== previousSession?.activeToolUseId)
    ) {
      this.runtime.events.emit("tools:event", [
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
    stopTools: boolean,
  ): Promise<import("@yaade/rpc").AppSession> {
    const visibleSessionIds = new Set(
      this.runtime.toolSessions.listSessions().map(session => session.id),
    );
    for (const use of this.runtime.toolSessions.listToolUses(sessionId)) {
      if (
        stopTools &&
        (use.status === "created" ||
          use.status === "starting" ||
          use.status === "running" ||
          use.status === "waiting")
      ) {
        try {
          await this.cancel(use.id, use.revision);
        } catch {
          /* continue archiving remaining tools */
        }
      }
    }
    const session = this.runtime.toolSessions.archiveSession(sessionId);
    this.runtime.events.emit("tools:event", [
      SessionArchived.make({
        eventId: eventId("session-archived", session.id),
        revision: session.revision ?? 1,
        occurredAt: session.updatedAt,
        session,
      }),
    ]);
    for (const replacement of this.runtime.toolSessions.listSessions()) {
      if (visibleSessionIds.has(replacement.id)) continue;
      this.runtime.events.emit("tools:event", [
        SessionCreated.make({
          eventId: eventId("session-created", replacement.id),
          revision: replacement.revision ?? 1,
          occurredAt: replacement.updatedAt,
          session: replacement,
        }),
      ]);
      for (const tab of this.runtime.toolSessions.listTabs(replacement.id)) {
        this.runtime.events.emit("tools:event", [
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
  selectToolUse(
    sessionId: import("@yaade/rpc").SessionId,
    toolUseId: ToolUseId | null,
  ): import("@yaade/rpc").AppSession {
    const previousSession = this.runtime.toolSessions.getSession(sessionId);
    const previousTab = previousSession?.activeTabId
      ? this.runtime.toolSessions.getTab(previousSession.activeTabId)
      : undefined;
    const session = this.runtime.toolSessions.setActiveToolUse(
      sessionId,
      toolUseId,
    );
    const activeTab = session.activeTabId
      ? this.runtime.toolSessions.getTab(session.activeTabId)
      : undefined;
    if (activeTab && activeTab.revision !== previousTab?.revision) {
      this.emitTabUpdated(activeTab);
    }
    if (session.revision !== previousSession?.revision) {
      this.emitSessionUpdated(session);
    }
    return session;
  }

  /** Reorder is a ToolUse mutation, so its revision/event policy belongs here. */
  reorderToolUses(
    sessionId: import("@yaade/rpc").SessionId,
    ids: readonly ToolUseId[],
    tabId?: import("@yaade/rpc").SessionTabId,
  ): ToolUse[] {
    const uses = this.runtime.toolSessions.reorderToolUses(sessionId, ids, tabId);
    for (const toolUse of uses) this.emitUpdated(toolUse);
    return uses;
  }

  onProcessExit(ptyId: string): void {
    const instance = this.runtime.terminalInstances.byPtyId(ptyId);
    if (!instance) return;
    const use = instance.toolUseId
      ? this.runtime.toolSessions.getToolUse(
          Schema.decodeUnknownSync(ToolUseId)(instance.toolUseId),
        )
      : null;
    if (!use) return;
    try {
      const updated = this.runtime.toolSessions.compareAndSetToolUse(
        use.id,
        use.revision,
        {
          status: instance.exitCode === 0 ? "succeeded" : "failed",
          output: processOutput(instance),
          ...(instance.exitCode === 0
            ? {}
            : {
                error:
                  instance.endReason ??
                  `process exited with ${instance.exitCode ?? "unknown"}`,
              }),
        },
      );
      this.emitUpdated(updated);
    } catch {
      /* A cancel/restart may already own the revision. */
    }
  }

  reconcile(): void {
    for (const session of this.runtime.toolSessions.listSessions(false)) {
      for (const use of this.runtime.toolSessions.listToolUses(session.id)) {
        if (use.output.kind !== "process") continue;
        if (
          !(
            use.status === "running" ||
            use.status === "starting" ||
            use.status === "waiting"
          )
        )
          continue;
        const instance = this.runtime.terminalInstances.get(
          use.output.terminalInstanceId,
        );
        const processState = instance?.processState;
        const nextStatus: ToolUseStatus =
          processState === "exited"
            ? instance?.exitCode === 0
              ? "succeeded"
              : "failed"
            : processState === "failed"
              ? "failed"
              : processState === "disconnected" || !instance
                ? "disconnected"
                : use.status;
        if (
          instance &&
          (processState === "starting" || processState === "running") &&
          use.status === nextStatus
        ) {
          continue;
        }
        if (!instance && nextStatus === use.status) continue;
        try {
          const nextOutput =
            nextStatus === "disconnected"
              ? withoutPty({ ...use.output, processState: "disconnected" })
              : instance
                ? processOutput(instance)
                : use.output;
          const updated = this.runtime.toolSessions.compareAndSetToolUse(
            use.id,
            use.revision,
            {
              status: nextStatus,
              output: nextOutput,
              ...(nextStatus === "failed"
                ? { error: instance?.endReason ?? "process is unavailable" }
                : {}),
            },
          );
          this.emitUpdated(updated);
        } catch {
          /* another reconciliation won */
        }
      }
    }
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.operationTails.values()].map(operation =>
        operation.catch(() => undefined),
      ),
    );
  }

  private async withToolLock<T>(
    id: ToolUseId,
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

  private assertRevision(current: ToolUse, expectedRevision: number): void {
    if (current.revision !== expectedRevision) {
      throw new ToolUseConflict({
        toolUseId: current.id,
        expectedRevision,
        actualRevision: current.revision,
        message: `tool use revision conflict: ${current.id}`,
      });
    }
  }

  private async stopLiveProcess(current: ToolUse): Promise<void> {
    if (current.output.kind !== "process" || !isLiveStatus(current.status)) return;
    try {
      await this.registry
        .get(current.kind)
        .cancel(current)
        .pipe(Effect.runPromise);
    } catch {
      /* instance may already be gone */
    }
    this.runtime.terminalInstances.unbindToolUse(current.id);
  }

  private require(id: ToolUseId): ToolUse {
    const use = this.runtime.toolSessions.getToolUse(id);
    if (!use || use.archivedAt)
      throw new ToolUseNotFound({
        toolUseId: id,
        message: `tool use not found: ${id}`,
      });
    return use;
  }

  private assertInputPair(command: CreateToolUse): void {
    const valid =
      (command.kind === "terminal" && command.input.kind === "terminal") ||
      (command.kind === "git" && command.input.kind === "git");
    if (!valid) {
      throw new InvalidToolInput({
        message: "tool kind does not match input",
      });
    }
  }

  private emitCreated(use: ToolUse): void {
    this.runtime.events.emit("tools:event", [
      ToolUseCreated.make({
        eventId: eventId("tool-created", use.id),
        toolUseId: use.id,
        revision: use.revision,
        occurredAt: use.updatedAt,
        toolUse: use,
      }),
    ]);
  }

  private emitUpdated(use: ToolUse): void {
    this.runtime.events.emit("tools:event", [
      ToolUseUpdated.make({
        eventId: eventId("tool-updated", use.id),
        toolUseId: use.id,
        revision: use.revision,
        occurredAt: use.updatedAt,
        toolUse: use,
      }),
    ]);
  }

  private emitTabUpdated(tab: import("@yaade/rpc").SessionTab): void {
    this.runtime.events.emit("tools:event", [
      SessionTabUpdated.make({
        eventId: eventId("tab-updated", tab.id),
        revision: tab.revision ?? 1,
        occurredAt: tab.updatedAt,
        tab,
      }),
    ]);
  }

  private emitSessionUpdated(session: import("@yaade/rpc").AppSession): void {
    this.runtime.events.emit("tools:event", [
      SessionUpdated.make({
        eventId: eventId("session-updated", session.id),
        revision: session.revision ?? 1,
        occurredAt: session.updatedAt,
        session,
      }),
    ]);
  }
}

function defaultTitle(kind: CreateToolUse["kind"]): string {
  return kind === "terminal" ? "Terminal" : "Git History";
}
