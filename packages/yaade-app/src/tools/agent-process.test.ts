import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  agentProviderFromTerminal,
  agentProviderFromTerminalIdentity,
} from "./agent-process.js";

describe("terminal agent detection", () => {
  it("recognizes supported CLI process names", () => {
    assert.equal(agentProviderFromTerminalIdentity("claude"), "claude");
    assert.equal(agentProviderFromTerminalIdentity("/opt/bin/codex"), "codex");
    assert.equal(agentProviderFromTerminalIdentity("cursor-agent"), "cursor");
    assert.equal(agentProviderFromTerminalIdentity("opencode"), "opencode");
    assert.equal(agentProviderFromTerminalIdentity("grok"), "grok");
    assert.equal(agentProviderFromTerminalIdentity("pi"), "pi");
  });

  it("falls back to Ghostty's title when a CLI runs through node", () => {
    assert.equal(
      agentProviderFromTerminal("node", "Claude Code — project"),
      "claude",
    );
    assert.equal(agentProviderFromTerminal("node", "OpenCode"), "opencode");
  });

  it("does not classify ordinary shells and editor titles", () => {
    assert.equal(agentProviderFromTerminal("zsh", "~/dev/yaade"), null);
    assert.equal(agentProviderFromTerminal("nvim", "main.ts"), null);
    assert.equal(agentProviderFromTerminal("zsh", "Claude Code"), null);
  });
});
