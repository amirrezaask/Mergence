import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { Schema } from "effect";
import {
  AgentToolInput,
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

function makeFakeAgentBinDir(): string {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-fake-agents-"));
  const script = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "fake-agent 1.0"
  exit 0
fi
exit 0
`;
  for (const binary of ["claude", "codex"]) {
    const file = path.join(binDir, binary);
    fs.writeFileSync(file, script, { mode: 0o755 });
  }
  return binDir;
}

async function hostWithProject() {
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
        host.runtime,
        request,
        "process-test",
      );
      const duplicate = await createTerminalInstance(
        host.runtime,
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
        host.runtime,
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
      const updated = Schema.decodeUnknownSync(ToolUse)(
        await dispatchPromise(
          host.runtime,
          "tools:updateUseContext",
          [
            {
              _tag: "UpdateToolUseContext",
              toolUseId: running.id,
              revision: 0,
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

  it("changes agent provider even with a stale input revision", async () => {
    const binDir = makeFakeAgentBinDir();
    const previousPath = process.env.PATH;
    process.env.PATH = binDir;
    const { host, parent, projectRoot } = await hostWithProject();
    try {
      const available = host.runtime.agentRuns
        .listProviders(true)
        .filter((item) => item.available);
      assert.deepEqual(
        available.map((item) => item.provider),
        ["claude", "codex"],
      );
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
              kind: "agent",
              project: ProjectTarget.make({
                projectId: project.id,
                projectPath: project.rootPath,
                projectName: project.name,
              }),
              checkout: MainCheckout.make({ kind: "main" }),
              input: AgentToolInput.make({
                kind: "agent",
                provider: available[0]!.provider,
              }),
            }),
          ],
          "process-provider-test",
        ),
      );
      await waitFor(() => {
        const status = host.runtime.toolSessions.getToolUse(created.id)?.status;
        return status === "running" || status === "failed";
      });
      const current = host.runtime.toolSessions.getToolUse(created.id);
      assert.ok(current);
      const nextProvider =
        current.input.kind === "agent" && current.input.provider === "claude"
          ? "codex"
          : "claude";
      const updated = Schema.decodeUnknownSync(ToolUse)(
        await dispatchPromise(
          host.runtime,
          "tools:updateUseInput",
          [
            {
              _tag: "UpdateToolUseInput",
              toolUseId: current.id,
              inputRevision: 0,
              input: AgentToolInput.make({
                kind: "agent",
                provider: nextProvider,
              }),
            },
          ],
          "process-provider-test",
        ),
      );
      assert.equal(updated.input.kind, "agent");
      if (updated.input.kind === "agent")
        assert.equal(updated.input.provider, nextProvider);
      const live = host.runtime.toolSessions.getToolUse(updated.id);
      if (live) {
        try {
          await dispatchPromise(
            host.runtime,
            "tools:cancelUse",
            [live.id, live.revision],
            "process-provider-test",
          );
        } catch {
          /* host teardown still owns remaining PTY exit */
        }
      }
    } finally {
      await host.close();
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      fs.rmSync(parent, { recursive: true, force: true });
      fs.rmSync(binDir, { recursive: true, force: true });
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
