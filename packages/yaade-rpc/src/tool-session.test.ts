import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Schema } from "effect";
import {
  GitToolInput,
  GitToolOutput,
  ProcessToolOutput,
  TerminalToolInput,
  ToolKind,
  ToolUse,
  ToolUseInput,
} from "./tool-session.js";

const decode = <A, I>(schema: Schema.Schema<A, I>, value: unknown): A =>
  Schema.decodeUnknownSync(schema)(value);

describe("terminal/Git ToolUse schemas", () => {
  it("accepts only terminal and Git kinds", () => {
    assert.equal(decode(ToolKind, "terminal"), "terminal");
    assert.equal(decode(ToolKind, "git"), "git");
    for (const retired of ["agent", "search", "editor", "neovim"]) {
      assert.throws(() => decode(ToolKind, retired));
    }
  });

  it("decodes terminal and Git inputs", () => {
    assert.equal(
      decode(ToolUseInput, TerminalToolInput.make({ kind: "terminal" })).kind,
      "terminal",
    );
    assert.equal(
      decode(ToolUseInput, GitToolInput.make({ kind: "git" })).kind,
      "git",
    );
  });

  it("enforces matching input and output kinds", () => {
    const base = {
      id: "use-terminal",
      sessionId: "ses-main",
      kind: "terminal",
      title: "Terminal",
      position: 0,
      status: "running",
      context: {
        project: { projectId: "project", projectPath: "/tmp", projectName: "tmp" },
        checkoutKey: "main",
        checkoutPath: "/tmp",
        checkoutLabel: "Main",
        managedWorktree: false,
      },
      input: TerminalToolInput.make({ kind: "terminal" }),
      inputRevision: 1,
      output: ProcessToolOutput.make({
        kind: "process",
        terminalInstanceId: "terminal-1",
        generation: 1,
        processState: "running",
        activityState: "idle",
        replayAvailable: true,
        truncated: false,
      }),
      revision: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    assert.equal(decode(ToolUse, base).kind, "terminal");
    assert.throws(() =>
      decode(ToolUse, {
        ...base,
        kind: "git",
        input: GitToolInput.make({ kind: "git" }),
      }),
    );
    assert.equal(GitToolOutput.make({ kind: "git" }).kind, "git");
  });
});
