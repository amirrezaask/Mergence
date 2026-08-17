import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import {
  CreateToolUse,
  GitToolOutput,
  InvalidToolInput,
  ProcessToolOutput,
  SessionArchived,
  SessionTabArchived,
  SessionTabNotFound,
  SessionUpdated,
  ToolUseArchived,
  ToolUseConflict,
  ToolUseCreated,
  ToolUseNotFound,
  ToolUseUpdated,
  type ToolUse,
  type ToolUseId,
  type ToolUseOutput,
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

/** Single host-side mutator for ToolUse lifecycle and driver ownership. */
export class ToolService {
  private readonly registry: ToolRegistry;

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
    store.setActiveToolUse(use.sessionId, use.id);

    const starting = store.compareAndSetToolUse(use.id, use.revision, {
      status: "starting",
    });
    this.emitUpdated(starting);
    try {
      const output = await this.registry
        .get(starting.kind)
        .create(starting, starting.input)
        .pipe(Effect.runPromise);
      const current = store.getToolUse(use.id);
      if (!current)
        throw new ToolUseNotFound({
          toolUseId: use.id,
          message: "tool use disappeared",
        });
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
      if (!current) throw error;
      const failed = store.compareAndSetToolUse(current.id, current.revision, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      this.emitUpdated(failed);
      throw error;
    }
  }

  async updateContext(
    command: CreateToolUse,
    useId: ToolUseId,
    _expectedRevision: number,
  ): Promise<ToolUse> {
    const current = this.require(useId);
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
    )
      return current;

    await this.stopLiveProcess(this.require(useId));
    const updated = this.withLatestRevision(useId, (revision) =>
      this.runtime.toolSessions.updateToolUseContext(useId, revision, context),
    );
    this.emitUpdated(updated);
    return this.relaunch(updated.id);
  }

  async cancel(useId: ToolUseId, expectedRevision: number): Promise<ToolUse> {
    const current = this.require(useId);
    if (current.revision !== expectedRevision) {
      throw new ToolUseConflict({
        toolUseId: useId,
        expectedRevision,
        actualRevision: current.revision,
        message: `tool use revision conflict: ${useId}`,
      });
    }
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
    const current = this.require(useId);
    const archived = this.runtime.toolSessions.archiveToolUse(useId);
    this.runtime.events.emit("tools:event", [
      ToolUseArchived.make({
        eventId: eventId("tool-archived", archived.id),
        toolUseId: archived.id,
        revision: archived.revision,
        occurredAt: archived.updatedAt,
      }),
    ]);
    return archived;
  }

  async restart(
    useId: ToolUseId,
    expectedRevision: number,
  ): Promise<ToolUse> {
    const current = this.require(useId);
    if (current.revision !== expectedRevision) {
      throw new ToolUseConflict({
        toolUseId: useId,
        expectedRevision,
        actualRevision: current.revision,
        message: `tool use revision conflict: ${useId}`,
      });
    }
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
    for (const use of this.runtime.toolSessions.listToolUsesByTab(tabId)) {
      if (stopTools && ["created", "starting", "running", "waiting"].includes(use.status)) {
        try {
          await this.cancel(use.id, use.revision);
        } catch {
          /* continue archiving the tab */
        }
      }
      try {
        await this.archiveUse(use.id);
      } catch {
        /* another lifecycle operation may already have archived it */
      }
    }
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
    return session;
  }

  onProcessExit(ptyId: string): void {
    const instance = this.runtime.terminalInstances.byPtyId(ptyId);
    if (!instance) return;
    const use = this.runtime.toolSessions
      .listSessions()
      .flatMap((session) => this.runtime.toolSessions.listToolUses(session.id))
      .find(
        (candidate) =>
          candidate.output.kind === "process" &&
          candidate.output.ptyId === ptyId,
      );
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
    for (const session of this.runtime.toolSessions.listSessions()) {
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
        if (instance) continue;
        try {
          const disconnected = this.runtime.toolSessions.compareAndSetToolUse(
            use.id,
            use.revision,
            {
              status: "disconnected",
              output: {
                ...use.output,
                processState: "disconnected",
              },
            },
          );
          this.emitUpdated(disconnected);
        } catch {
          /* another reconciliation won */
        }
      }
    }
  }

  async close(): Promise<void> {}

  private async relaunch(useId: ToolUseId): Promise<ToolUse> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = this.require(useId);
      try {
        return await this.restart(useId, current.revision);
      } catch (error) {
        if (!(error instanceof ToolUseConflict) || attempt === 2)
          return this.require(useId);
      }
    }
    return this.require(useId);
  }

  private withLatestRevision<T>(
    useId: ToolUseId,
    apply: (revision: number) => T,
  ): T {
    let last: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return apply(this.require(useId).revision);
      } catch (error) {
        last = error;
        if (!(error instanceof ToolUseConflict)) throw error;
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }

  private async stopLiveProcess(current: ToolUse): Promise<void> {
    if (current.output.kind !== "process") return;
    try {
      await this.registry
        .get(current.kind)
        .cancel(current)
        .pipe(Effect.runPromise);
    } catch {
      /* instance may already be gone */
    }
    if (current.output.kind === "process") {
      this.runtime.terminalInstances.unbindToolUse(current.id);
    }
  }

  private require(id: ToolUseId): ToolUse {
    const use = this.runtime.toolSessions.getToolUse(id);
    if (!use)
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
}

function defaultTitle(kind: CreateToolUse["kind"]): string {
  return kind === "terminal" ? "Terminal" : "Git History";
}
