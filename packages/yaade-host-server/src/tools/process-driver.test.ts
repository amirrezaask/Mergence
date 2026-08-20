import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vite-plus/test";
import { Schema } from "effect";
import {
  CreateToolUse,
  MainCheckout,
  ProjectTarget,
  TerminalToolInput,
  ToolUse,
} from "@yaade/rpc";
import {
  createTerminalInstance,
  restartTerminalInstance,
} from "./process-driver.js";
import { dispatchPromise } from "../dispatch.js";
import { SupervisedTerminalHost } from "@yaade/node-host";
import { loadConfig } from "../config.js";
import { startHostServer } from "../server.js";

async function waitFor(check: () => boolean, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline)
      throw new Error("timed out waiting for process lifecycle");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function hostWithProject(extraArgs: string[] = []) {
  const parent = fs.mkdtempSync(
    path.join(os.tmpdir(), "yaade-process-driver-"),
  );
  const projectRoot = path.join(parent, "project");
  fs.mkdirSync(projectRoot);
  const canonicalProjectRoot = fs.realpathSync(projectRoot);
  const config = await loadConfig([
    "--host",
    "127.0.0.1",
    "--port",
    "0",
    "--data-dir",
    path.join(parent, "data"),
    "--allowed-roots",
    parent,
    projectRoot,
    ...extraArgs,
  ]);
  const host = await startHostServer(config);
  return { host, parent, projectRoot: canonicalProjectRoot };
}

describe("process Tool driver", () => {
  it("deduplicates launches and increments the generation on restart", async () => {
    const { host, parent, projectRoot } = await hostWithProject();
    try {
      const project = host.runtime.db
        .projects()
        .find((item) => item.rootPath === projectRoot);
      assert.ok(project);

      const request = {
        projectId: project.id,
        checkoutPath: projectRoot,
        title: "Driver shell",
        workspaceId: "ses-driver-test",
        launchRequestId: "use-driver-test:1",
      };
      const first = await createTerminalInstance(
        host.runtime.terminalExecution,
        request,
        "process-test",
      );
      const duplicate = await createTerminalInstance(
        host.runtime.terminalExecution,
        request,
        "process-test",
      );
      assert.equal(duplicate.id, first.id);
      assert.equal(
        host.runtime.terminalInstances
          .listProject(project.id)
          .filter((item) => item.id === first.id).length,
        1,
      );

      const restarted = await restartTerminalInstance(
        host.runtime.terminalExecution,
        first,
        [],
        "process-test",
      );
      assert.equal(restarted.id, first.id);
      assert.equal(restarted.generation, first.generation + 1);
      assert.notEqual(restarted.ptyId, first.ptyId);
    } finally {
      await host.close();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("cancels a TerminalToolUse and preserves replay metadata", async () => {
    const { host, parent, projectRoot } = await hostWithProject();
    try {
      const project = host.runtime.db
        .projects()
        .find((item) => item.rootPath === projectRoot);
      assert.ok(project);
      const session = host.runtime.toolSessions.listSessions()[0];
      assert.ok(session);
      const created = Schema.decodeUnknownSync(ToolUse)(
        await dispatchPromise(
          host.runtime,
          "tools:createUse",
          [
            CreateToolUse.make({
              sessionId: session.id,
              kind: "terminal",
              project: ProjectTarget.make({
                projectId: project.id,
                projectPath: project.rootPath,
                projectName: project.name,
              }),
              checkout: MainCheckout.make({ kind: "main" }),
              input: TerminalToolInput.make({ kind: "terminal" }),
            }),
          ],
          "process-cancel-test",
        ),
      );
      await waitFor(() => {
        const use = host.runtime.toolSessions.getToolUse(created.id);
        return (
          use?.status === "running" &&
          use.output.kind === "process" &&
          Boolean(use.output.ptyId)
        );
      });
      const running = host.runtime.toolSessions.getToolUse(created.id);
      assert.ok(running);
      const cancelled = Schema.decodeUnknownSync(ToolUse)(
        await dispatchPromise(
          host.runtime,
          "tools:cancelUse",
          [running.id, running.revision],
          "process-cancel-test",
        ),
      );
      assert.equal(cancelled.status, "cancelled");
      assert.equal(cancelled.output.kind, "process");
      if (cancelled.output.kind === "process") {
        assert.equal(cancelled.output.replayAvailable, true);
        assert.ok(
          ["exited", "failed", "disconnected"].includes(
            cancelled.output.processState,
          ),
        );
      }
    } finally {
      await host.close();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("archives a live terminal by stopping its PTY and clearing focus", async () => {
    const { host, parent, projectRoot } = await hostWithProject();
    try {
      const project = host.runtime.db
        .projects()
        .find((item) => item.rootPath === projectRoot);
      assert.ok(project);
      const session = host.runtime.toolSessions.listSessions()[0];
      assert.ok(session);
      const created = Schema.decodeUnknownSync(ToolUse)(
        await dispatchPromise(
          host.runtime,
          "tools:createUse",
          [
            CreateToolUse.make({
              sessionId: session.id,
              kind: "terminal",
              project: ProjectTarget.make({
                projectId: project.id,
                projectPath: project.rootPath,
                projectName: project.name,
              }),
              checkout: MainCheckout.make({ kind: "main" }),
              input: TerminalToolInput.make({ kind: "terminal" }),
            }),
          ],
          "process-archive-test",
        ),
      );
      await waitFor(() => {
        const use = host.runtime.toolSessions.getToolUse(created.id);
        return use?.status === "running" && use.output.kind === "process" && Boolean(use.output.ptyId);
      });
      const running = host.runtime.toolSessions.getToolUse(created.id);
      assert.ok(running);
      assert.equal(running.output.kind, "process");
      if (running.output.kind !== "process" || !running.output.ptyId) return;
      const archived = Schema.decodeUnknownSync(ToolUse)(
        await dispatchPromise(
          host.runtime,
          "tools:archiveUse",
          [{ _tag: "ArchiveToolUse", toolUseId: running.id }],
          "process-archive-test",
        ),
      );
      assert.ok(archived.archivedAt);
      assert.equal(
        await Promise.resolve(host.runtime.terminal.inspect(running.output.ptyId)),
        null,
      );
      assert.equal(host.runtime.terminalInstances.get(running.output.terminalInstanceId), null);
      assert.equal(host.runtime.toolSessions.getSession(session.id)?.activeToolUseId, undefined);
      const tab = host.runtime.toolSessions.listTabs(session.id)[0];
      assert.equal(tab?.activeToolUseId, undefined);
    } finally {
      await host.close();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("restarts a TerminalToolUse with a new generation and live PTY", async () => {
    const { host, parent, projectRoot } = await hostWithProject();
    try {
      const project = host.runtime.db
        .projects()
        .find((item) => item.rootPath === projectRoot);
      assert.ok(project);
      const session = host.runtime.toolSessions.listSessions()[0];
      assert.ok(session);
      const created = Schema.decodeUnknownSync(ToolUse)(
        await dispatchPromise(
          host.runtime,
          "tools:createUse",
          [
            CreateToolUse.make({
              sessionId: session.id,
              kind: "terminal",
              project: ProjectTarget.make({
                projectId: project.id,
                projectPath: project.rootPath,
                projectName: project.name,
              }),
              checkout: MainCheckout.make({ kind: "main" }),
              input: TerminalToolInput.make({ kind: "terminal" }),
            }),
          ],
          "process-restart-test",
        ),
      );
      await waitFor(
        () =>
          host.runtime.toolSessions.getToolUse(created.id)?.status ===
          "running",
      );
      const running = host.runtime.toolSessions.getToolUse(created.id);
      assert.ok(running);
      assert.equal(running.output.kind, "process");
      const firstGeneration =
        running.output.kind === "process" ? running.output.generation : 0;
      const firstPty =
        running.output.kind === "process" ? running.output.ptyId : undefined;
      const restarted = Schema.decodeUnknownSync(ToolUse)(
        await dispatchPromise(
          host.runtime,
          "tools:restartUse",
          [running.id, running.revision],
          "process-restart-test",
        ),
      );
      assert.equal(restarted.status, "running");
      assert.equal(restarted.output.kind, "process");
      if (restarted.output.kind === "process") {
        assert.equal(restarted.output.generation, firstGeneration + 1);
        assert.notEqual(restarted.output.ptyId, firstPty);
        assert.ok(restarted.output.ptyId);
      }
    } finally {
      await host.close();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("changes terminal context and restarts it in the selected project", async () => {
    const { host, parent, projectRoot } = await hostWithProject();
    const secondRoot = path.join(parent, "second-project");
    fs.mkdirSync(secondRoot);
    try {
      const firstProject = host.runtime.db
        .projects()
        .find((item) => item.rootPath === projectRoot);
      assert.ok(firstProject);
      host.runtime.db.addProject(secondRoot, "second-project");
      const secondProject = host.runtime.db
        .projects()
        .find((item) => item.rootPath === fs.realpathSync(secondRoot));
      assert.ok(secondProject);
      const session = host.runtime.toolSessions.listSessions()[0];
      assert.ok(session);
      const created = Schema.decodeUnknownSync(ToolUse)(
        await dispatchPromise(
          host.runtime,
          "tools:createUse",
          [
            CreateToolUse.make({
              sessionId: session.id,
              kind: "terminal",
              project: ProjectTarget.make({
                projectId: firstProject.id,
                projectPath: firstProject.rootPath,
                projectName: firstProject.name,
              }),
              checkout: MainCheckout.make({ kind: "main" }),
              input: TerminalToolInput.make({ kind: "terminal" }),
            }),
          ],
          "process-context-test",
        ),
      );
      await waitFor(
        () =>
          host.runtime.toolSessions.getToolUse(created.id)?.status ===
          "running",
      );
      const running = host.runtime.toolSessions.getToolUse(created.id);
      assert.ok(running);
      assert.equal(running.output.kind, "process");
      const firstPty =
        running.output.kind === "process" ? running.output.ptyId : undefined;
      await assert.rejects(
        dispatchPromise(
          host.runtime,
          "tools:updateUseContext",
          [
            {
              _tag: "UpdateToolUseContext",
              toolUseId: running.id,
              revision: running.revision - 1,
              project: ProjectTarget.make({
                projectId: secondProject.id,
                projectPath: secondProject.rootPath,
                projectName: secondProject.name,
              }),
              checkout: MainCheckout.make({ kind: "main" }),
            },
          ],
          "process-context-test",
        ),
        /revision conflict/,
      );
      const updated = Schema.decodeUnknownSync(ToolUse)(
        await dispatchPromise(
          host.runtime,
          "tools:updateUseContext",
          [
            {
              _tag: "UpdateToolUseContext",
              toolUseId: running.id,
              revision: running.revision,
              project: ProjectTarget.make({
                projectId: secondProject.id,
                projectPath: secondProject.rootPath,
                projectName: secondProject.name,
              }),
              checkout: MainCheckout.make({ kind: "main" }),
            },
          ],
          "process-context-test",
        ),
      );
      assert.equal(updated.context.checkoutPath, fs.realpathSync(secondRoot));
      assert.equal(updated.status, "running");
      assert.equal(updated.output.kind, "process");
      if (updated.output.kind === "process")
        assert.notEqual(updated.output.ptyId, firstPty);
    } finally {
      await host.close();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("marks persisted live tools disconnected after a host restart", async () => {
    const first = await hostWithProject();
    let currentHost = first.host;
    try {
      const project = currentHost.runtime.db
        .projects()
        .find((item) => item.rootPath === first.projectRoot);
      assert.ok(project);
      const session = currentHost.runtime.toolSessions.listSessions()[0];
      assert.ok(session);
      const created = Schema.decodeUnknownSync(ToolUse)(
        await dispatchPromise(
          currentHost.runtime,
          "tools:createUse",
          [
            CreateToolUse.make({
              sessionId: session.id,
              kind: "terminal",
              project: ProjectTarget.make({
                projectId: project.id,
                projectPath: project.rootPath,
                projectName: project.name,
              }),
              checkout: MainCheckout.make({ kind: "main" }),
              input: TerminalToolInput.make({ kind: "terminal" }),
            }),
          ],
          "process-restart-reconcile-test",
        ),
      );
      await waitFor(() => currentHost.runtime.toolSessions.getToolUse(created.id)?.status === "running");

      await currentHost.close();
      const config = await loadConfig([
        "--host", "127.0.0.1",
        "--port", "0",
        "--data-dir", path.join(first.parent, "data"),
        "--allowed-roots", first.parent,
        first.projectRoot,
      ]);
      currentHost = await startHostServer(config);
      const disconnected = currentHost.runtime.toolSessions.getToolUse(created.id);
      assert.equal(disconnected?.status, "disconnected");
      assert.equal(disconnected?.output.kind, "process");
      if (disconnected?.output.kind === "process") {
        assert.equal(disconnected.output.processState, "disconnected");
        assert.equal(disconnected.output.ptyId, undefined);
      }
    } finally {
      await currentHost.close();
      fs.rmSync(first.parent, { recursive: true, force: true });
    }
  });

  it("keeps live tools attached across an API restart when the PTY supervisor survives", async () => {
    const first = await hostWithProject(["--pty-supervisor", "1"]);
    let currentHost = first.host;
    const dataDir = path.join(first.parent, "data");
    try {
      const project = currentHost.runtime.db
        .projects()
        .find((item) => item.rootPath === first.projectRoot);
      assert.ok(project);
      const session = currentHost.runtime.toolSessions.listSessions()[0];
      assert.ok(session);
      const created = Schema.decodeUnknownSync(ToolUse)(
        await dispatchPromise(
          currentHost.runtime,
          "tools:createUse",
          [
            CreateToolUse.make({
              sessionId: session.id,
              kind: "terminal",
              project: ProjectTarget.make({
                projectId: project.id,
                projectPath: project.rootPath,
                projectName: project.name,
              }),
              checkout: MainCheckout.make({ kind: "main" }),
              input: TerminalToolInput.make({ kind: "terminal" }),
            }),
          ],
          "process-supervisor-durability-test",
        ),
      );
      await waitFor(() => currentHost.runtime.toolSessions.getToolUse(created.id)?.status === "running");
      const live = currentHost.runtime.toolSessions.getToolUse(created.id);
      assert.ok(live);
      assert.equal(live.output.kind, "process");
      if (live.output.kind !== "process") return;
      const ptyId = live.output.ptyId;
      assert.ok(ptyId);

      await currentHost.close({ killPtys: false });
      const config = await loadConfig([
        "--host", "127.0.0.1",
        "--port", "0",
        "--data-dir", dataDir,
        "--allowed-roots", first.parent,
        "--pty-supervisor", "1",
        first.projectRoot,
      ]);
      currentHost = await startHostServer(config);
      const restored = currentHost.runtime.toolSessions.getToolUse(created.id);
      assert.equal(restored?.status, "running");
      assert.equal(restored?.output.kind, "process");
      if (restored?.output.kind === "process") {
        assert.equal(restored.output.processState, "running");
        assert.equal(restored.output.ptyId, ptyId);
      }
      const attached = await Promise.resolve(
        currentHost.runtime.terminal.attach(ptyId, "durability-reattach"),
      );
      assert.ok(attached);
      assert.equal(attached.status, "running");
    } finally {
      try {
        const supervisor = await SupervisedTerminalHost.connect(dataDir);
        await supervisor.shutdownSupervisor();
      } catch {
        /* supervisor may already be gone */
      }
      await currentHost.close({ killPtys: true });
      fs.rmSync(first.parent, { recursive: true, force: true });
    }
  });

  it("marks a missing terminal instance as disconnected during reconcile", async () => {
    const { host, parent, projectRoot } = await hostWithProject();
    try {
      const project = host.runtime.db
        .projects()
        .find((item) => item.rootPath === projectRoot);
      assert.ok(project);
      const session = host.runtime.toolSessions.listSessions()[0];
      assert.ok(session);
      const created = Schema.decodeUnknownSync(ToolUse)(
        await dispatchPromise(
          host.runtime,
          "tools:createUse",
          [
            CreateToolUse.make({
              sessionId: session.id,
              kind: "terminal",
              project: ProjectTarget.make({
                projectId: project.id,
                projectPath: project.rootPath,
                projectName: project.name,
              }),
              checkout: MainCheckout.make({ kind: "main" }),
              input: TerminalToolInput.make({ kind: "terminal" }),
            }),
          ],
          "process-reconcile-test",
        ),
      );
      await waitFor(() => {
        const use = host.runtime.toolSessions.getToolUse(created.id);
        return use?.status === "running" && use.output.kind === "process";
      });
      const live = host.runtime.toolSessions.getToolUse(created.id);
      assert.ok(live);
      assert.equal(live.output.kind, "process");
      if (live.output.kind !== "process") return;
      const instance = host.runtime.terminalInstances.get(
        live.output.terminalInstanceId,
      );
      assert.ok(instance);
      // Remove the durable instance while the ToolUse is still live so reconcile
      // can mark the missing process as disconnected.
      host.runtime.terminalInstances.close(
        instance.id,
        instance.generation,
        "",
      );
      host.runtime.toolService?.reconcile();
      await waitFor(
        () =>
          host.runtime.toolSessions.getToolUse(created.id)?.status ===
          "disconnected",
      );
      const disconnected = host.runtime.toolSessions.getToolUse(created.id);
      assert.equal(disconnected?.status, "disconnected");
      assert.equal(disconnected?.output.kind, "process");
      if (disconnected?.output.kind === "process") {
        assert.equal(disconnected.output.processState, "disconnected");
      }
    } finally {
      await host.close();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});
