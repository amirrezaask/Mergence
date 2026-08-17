import { randomUUID } from "node:crypto";
import { Effect, Exit, Fiber, Scope } from "effect";
import {
  CreateToolUse,
  EditorToolOutput,
  GitToolOutput,
  InvalidToolInput,
  NeovimToolOutput,
  ProcessToolOutput,
  SearchToolOutput,
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
import {
  ProcessToolDriver,
  processOutput,
  parseProcessProvider,
} from "./process-driver.js";
import { EditorToolDriver } from "./editor-driver.js";
import { NeovimToolDriver } from "./neovim-driver.js";
import type { NeovimExitEvent } from "../neovim/host.js";
import { GitToolDriver } from "./git-driver.js";
import { SearchDriver } from "./search-driver.js";
import { ToolRegistry } from "./registry.js";

function eventId(prefix: string, id: string): string {
  return `${prefix}:${id}:${randomUUID()}`;
}

function pendingOutput(
  kind: "agent" | "terminal" | "search" | "git" | "editor" | "neovim",
): ToolUseOutput {
  if (kind === "editor") {
    return EditorToolOutput.make({ kind: "editor" });
  }
  if (kind === "git") {
    return GitToolOutput.make({ kind: "git" });
  }
  if (kind === "neovim") {
    return NeovimToolOutput.make({
      kind: "neovim",
      serverInstanceId: "pending",
      generation: 1,
      processState: "starting",
    });
  }
  if (kind === "search") {
    return SearchToolOutput.make({
      kind: "search",
      resultRevision: 1,
      resultCount: 0,
      truncated: false,
      running: true,
    });
  }
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
  private readonly search: SearchDriver;
  private readonly registry: ToolRegistry;
  private readonly scope = Effect.runSync(Scope.make());
  private readonly fibers = new Map<string, Fiber.Fiber<void, never>>();

  constructor(private readonly runtime: HostRuntime) {
    this.search = new SearchDriver({
      store: runtime.toolSessions,
      publish: (event) => runtime.events.emit("tools:event", [event]),
    });
    this.registry = new ToolRegistry([
      new ProcessToolDriver(runtime, "agent"),
      new ProcessToolDriver(runtime, "terminal"),
      this.search,
      new GitToolDriver(),
      new EditorToolDriver(),
      new NeovimToolDriver(runtime),
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

    if (command.kind === "search") {
      const waiting = store.compareAndSetToolUse(use.id, use.revision, {
        status: "waiting",
      });
      this.emitUpdated(waiting);
      this.startSearch(waiting);
      return waiting;
    }

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
        ...(current.output.kind === "neovim"
          ? { output: NeovimToolOutput.make({ ...current.output, processState: "failed" }) }
          : {}),
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

  async updateInput(
    useId: ToolUseId,
    inputRevision: number,
    input: CreateToolUse["input"],
  ): Promise<ToolUse> {
    const current = this.require(useId);
    if (input.kind === "search") {
      if (current.kind !== "search" || input._tag !== "SearchToolInput") {
        throw new InvalidToolInput({
          message: "tool kind does not match input",
        });
      }
      return this.updateSearchInput(useId, inputRevision, input);
    }
    if (
      input.kind !== "agent" ||
      current.kind !== "agent" ||
      input._tag !== "AgentToolInput"
    ) {
      throw new InvalidToolInput({
        message: "tool kind does not match input",
      });
    }
    if (
      current.input.kind === "agent" &&
      current.input.provider === input.provider
    )
      return current;
    await this.stopLiveProcess(this.require(useId));
    const updated = this.withLatestRevision(useId, (revision) =>
      this.runtime.toolSessions.compareAndSetToolUse(useId, revision, { input }),
    );
    this.emitUpdated(updated);
    return this.relaunch(updated.id);
  }

  async updateSearchInput(
    useId: ToolUseId,
    inputRevision: number,
    input: Extract<CreateToolUse["input"], { kind: "search" }>,
  ): Promise<ToolUse> {
    this.require(useId);
    const updated = this.runtime.toolSessions.updateSearchInput(
      useId,
      inputRevision,
      input,
    );
    const nextRevision =
      updated.output.kind === "search" ? updated.output.resultRevision + 1 : 1;
    this.stopSearch(useId);
    const waiting = this.runtime.toolSessions.compareAndSetToolUse(
      updated.id,
      updated.revision,
      {
        status: "waiting",
        output: SearchToolOutput.make({
          kind: "search",
          resultRevision: nextRevision,
          resultCount: 0,
          truncated: false,
          running: true,
        }),
      },
    );
    this.emitUpdated(waiting);
    this.startSearch(waiting, true);
    return waiting;
  }

  async loadMore(
    useId: ToolUseId,
    resultRevision: number,
    cursor: number,
  ): Promise<ToolUse> {
    const use = this.require(useId);
    if (
      use.kind !== "search" ||
      use.output.kind !== "search" ||
      use.output.resultRevision !== resultRevision
    ) {
      throw new ToolUseConflict({
        toolUseId: useId,
        expectedRevision: resultRevision,
        actualRevision:
          use.output.kind === "search" ? use.output.resultRevision : -1,
        message: `search result revision conflict: ${useId}`,
      });
    }
    await this.search.loadMore(use, cursor);
    return use;
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
    this.stopSearch(useId);
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
    if (
      current.kind === "neovim" &&
      (current.status === "created" ||
        current.status === "starting" ||
        current.status === "running" ||
        current.status === "waiting")
    ) {
      try {
        await this.registry.get(current.kind).close(current).pipe(Effect.runPromise);
      } catch {
        /* The process may have exited between the lookup and close. */
      }
    }
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
    if (current.kind === "search") {
      const restarted = this.runtime.toolSessions.compareAndSetToolUse(
        useId,
        expectedRevision,
        {
          status: "waiting",
          error: null,
          output: SearchToolOutput.make({
            kind: "search",
            resultRevision:
              current.output.kind === "search"
                ? current.output.resultRevision + 1
                : 1,
            resultCount: 0,
            truncated: false,
            running: true,
          }),
        },
      );
      this.emitUpdated(restarted);
      this.stopSearch(useId);
      this.startSearch(restarted);
      return restarted;
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
          ...(starting.output.kind === "neovim"
            ? { output: NeovimToolOutput.make({ ...starting.output, processState: "failed" }) }
            : {}),
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
      // A Neovim process has no durable host-side handle after its ToolUse is
      // archived. Keep-running is a terminal compatibility affordance; native
      // editor servers must always be closed with their ToolUse.
      if (use.kind === "neovim") {
        try {
          await this.archiveUse(use.id);
        } catch {
          /* another lifecycle operation may already have archived it */
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

  onNeovimExit(event: NeovimExitEvent): void {
    const use = this.runtime.toolSessions.getToolUse(event.toolUseId);
    if (!use || use.kind !== "neovim" || use.output.kind !== "neovim") return;
    try {
      const updated = this.runtime.toolSessions.compareAndSetToolUse(
        use.id,
        use.revision,
        {
          status: event.output.processState === "exited" ? "succeeded" : "failed",
          output: event.output,
          ...(event.output.processState === "exited"
            ? {}
            : { error: `Neovim exited with ${event.output.exitCode ?? "an error"}` }),
        },
      );
      this.emitUpdated(updated);
    } catch {
      /* A cancel or restart may already own the revision. */
    }
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
        if (
          use.kind === "search" &&
          (use.status === "waiting" || use.status === "running")
        ) {
          this.startSearch(use);
          continue;
        }
        if (use.output.kind === "neovim") {
          if (
            use.status === "running" ||
            use.status === "starting" ||
            use.status === "waiting"
          ) {
            const runtime = this.runtime.neovim.get(use.id);
            if (runtime && runtime.generation === use.output.generation) continue;
            try {
              const disconnected = this.runtime.toolSessions.compareAndSetToolUse(
                use.id,
                use.revision,
                {
                  status: "disconnected",
                  output: NeovimToolOutput.make({
                    ...use.output,
                    processState: "disconnected",
                  }),
                },
              );
              this.emitUpdated(disconnected);
            } catch {
              /* another reconciliation won */
            }
          }
          continue;
        }
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

  async close(): Promise<void> {
    const fibers = [...this.fibers.values()];
    for (const use of this.runtime.toolSessions
      .listSessions()
      .flatMap((session) =>
        this.runtime.toolSessions.listToolUses(session.id),
      )) {
      this.stopSearch(use.id);
    }
    if (fibers.length > 0) await Effect.runPromise(Fiber.interruptAll(fibers));
    await this.runtime.neovim.closeAll();
    await Effect.runPromise(Scope.close(this.scope, Exit.void));
  }

  private startSearch(use: ToolUse, debounce = false): void {
    const search = this.search;
    const effect = Effect.gen(function* () {
      if (debounce) yield* Effect.sleep("120 millis");
      yield* Effect.tryPromise({
        try: () => search.run(use, true),
        catch: () => undefined,
      }).pipe(
        Effect.catchAll(() => Effect.void),
        Effect.ensuring(Effect.sync(() => search.abort(use.id))),
      );
    }).pipe(Effect.asVoid);
    const previous = this.fibers.get(use.id);
    if (previous) void Effect.runPromise(Fiber.interrupt(previous));
    const fiber = Effect.runSync(Effect.forkIn(effect, this.scope));
    this.fibers.set(use.id, fiber);
  }

  private stopSearch(id: ToolUseId): void {
    this.search.abort(id);
    const fiber = this.fibers.get(id);
    if (fiber) void Effect.runPromise(Fiber.interrupt(fiber));
    this.fibers.delete(id);
  }

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
    this.stopSearch(current.id);
    if (current.output.kind !== "process" && current.output.kind !== "neovim") return;
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
      (command.kind === "search" && command.input.kind === "search") ||
      (command.kind === "agent" && command.input.kind === "agent") ||
      (command.kind === "terminal" && command.input.kind === "terminal") ||
      (command.kind === "git" && command.input.kind === "git") ||
      (command.kind === "editor" && command.input.kind === "editor") ||
      (command.kind === "neovim" && command.input.kind === "neovim");
    if (!valid) {
      throw new InvalidToolInput({
        message: "tool kind does not match input",
      });
    }
    if (
      command.input._tag === "AgentToolInput" &&
      !parseProcessProvider(command.input.provider)
    ) {
      throw new InvalidToolInput({
        message: `agent provider is unavailable: ${command.input.provider}`,
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
  if (kind === "agent") return "Agent";
  if (kind === "terminal") return "Terminal";
  if (kind === "search") return "Search";
  if (kind === "git") return "Git History";
  if (kind === "editor") return "Editor";
  return "Neovim";
}
