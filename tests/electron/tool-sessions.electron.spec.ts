import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ShellDriver } from "../shell/driver.js";
import { createMockLspHarness } from "../../apps/host-server/mocks/mock-lsp-harness.js";
import { launchWeb } from "../shell/launch-web.js";
import {
  expectContainsText,
  expectLocatorCount,
  expectLocatorVisible,
  expectNotContainsText,
  expectSelectorVisible,
} from "../shell/assert.js";
import {
  expectLayout,
  expectListRows,
  expectNoOverlap,
  expectRowSpacing,
  expectRowTextVisible,
} from "../helpers/list.js";
import { REPO_ROOT, focusTerminal, pressMuxPrefix } from "./_launch.js";

async function openToolSessionShell(page: ShellDriver): Promise<void> {
  await page.evaluate(() => {
    history.pushState(null, "", "/");
    window.dispatchEvent(new Event("popstate"));
  });
  await page.waitForSelector('[data-yaade-shell="tool-session"]');
  await expectSelectorVisible(page, '[data-yaade-shell="tool-session"]');
  await page.waitForFunction(
    () => (window.__yaadeAgent?.getState().sessions?.length ?? 0) >= 1,
  );
}

async function openToolContext(page: ShellDriver): Promise<void> {
  await page
    .locator('[data-yaade-tool-pane-tab][data-active]')
    .click({ button: "right" });
  await expectSelectorVisible(page, "[data-yaade-tool-context-popover]");
}

async function waitForVisibleTerminalSurface(page: ShellDriver): Promise<void> {
  await page.waitForFunction(
    () => {
      return [...document.querySelectorAll("[data-yaade-terminal-canvas]")].some((el) => {
        const root = el.closest(".absolute");
        if (!(root instanceof HTMLElement)) return true;
        return !root.classList.contains("hidden");
      });
    },
    null,
    { timeout: 30_000 },
  );
}

async function createTerminalToolUse(page: ShellDriver): Promise<void> {
  await page.locator("[data-yaade-pane-new-tool]").first().click();
  await expectSelectorVisible(page, "[data-yaade-pane-tool-menu]");
  await page.locator('[data-yaade-pane-new-tool-kind="terminal"]').click();
  await waitForVisibleTerminalSurface(page);
  await openToolContext(page);
  await expectSelectorVisible(page, "#tool-project");
}

async function createEditorToolUse(page: ShellDriver): Promise<void> {
  await page.locator('[data-yaade-empty-tool="editor"]').click();
  await page.waitForSelector('[data-yaade-editor-tool]', { timeout: 30_000 });
}

async function createSearchToolUse(
  page: ShellDriver,
  query: string,
): Promise<void> {
  await page.locator("[data-yaade-pane-new-tool]").first().click();
  await expectSelectorVisible(page, "[data-yaade-pane-tool-menu]");
  await page.locator('[data-yaade-pane-new-tool-kind="search"]').click();
  await page.waitForSelector('[data-yaade-list-panel="project-search"]', {
    timeout: 30_000,
  });
  await openToolContext(page);
  await expectSelectorVisible(page, "#tool-project");
  await page.getByLabel("Search project").fill(query);
}

async function ensureProjectGitRepo(page: ShellDriver): Promise<string> {
  const projectPath = await page.evaluate(async () => {
    const projects = await window.yaade!.tools!.listProjects();
    const project = projects[0];
    if (!project) throw new Error("no project");
    return project.projectPath;
  });
  if (!fs.existsSync(path.join(projectPath, ".git"))) {
    execFileSync("git", ["init"], { cwd: projectPath });
    execFileSync("git", ["config", "user.email", "e2e@yaade.test"], {
      cwd: projectPath,
    });
    execFileSync("git", ["config", "user.name", "yaade-e2e"], {
      cwd: projectPath,
    });
    fs.writeFileSync(path.join(projectPath, "README.md"), "seed\n");
    execFileSync("git", ["add", "."], { cwd: projectPath });
    execFileSync("git", ["commit", "-m", "seed"], { cwd: projectPath });
  }
  return projectPath;
}

async function waitForToolTerminalText(
  page: ShellDriver,
  needle: string,
): Promise<void> {
  const tabId = await page.evaluate(
    () => window.__yaadeAgent?.getState().activeToolUseId ?? undefined,
  );
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const text = await page.evaluate(
      (id) => window.__yaadeAgent?.getTerminalText?.(id) ?? "",
      tabId,
    );
    if (text.includes(needle)) return;
    await page.waitForTimeout(50);
  }
  throw new Error(`waitForToolTerminalText: timed out waiting for ${needle}`);
}

async function createTerminalViaApi(
  page: ShellDriver,
  title?: string,
  projectPathNeedle?: string,
): Promise<string> {
  const id = await page.evaluate(
    async ({ nextTitle, needle }) => {
      const tools = window.yaade?.tools;
      const state = window.__yaadeAgent!.getState();
      const sessionId = state.activeSessionId;
      if (!tools || !sessionId) throw new Error("tools API or session missing");
      const projects = await tools.listProjects();
      const project = needle
        ? (projects.find((item) => item.projectPath.includes(needle)) ??
          projects[0])
        : projects[0];
      if (!project) throw new Error("no project");
      const created = nextTitle
        ? await tools.createUse({
            _tag: "CreateToolUse",
            sessionId,
            title: nextTitle,
            kind: "terminal",
            project,
            checkout: { _tag: "MainCheckout", kind: "main" },
            input: { _tag: "TerminalToolInput", kind: "terminal" },
          })
        : await tools.createUse({
            _tag: "CreateToolUse",
            sessionId,
            kind: "terminal",
            project,
            checkout: { _tag: "MainCheckout", kind: "main" },
            input: { _tag: "TerminalToolInput", kind: "terminal" },
          });
      return created.id;
    },
    { nextTitle: title, needle: projectPathNeedle },
  );
  await page.waitForFunction(
    (toolUseId) =>
      (window.__yaadeAgent?.getState().toolUses ?? []).some(
        (use: { id: string }) => use.id === toolUseId,
      ),
    id,
    { timeout: 20_000 },
  );
  await page.evaluate(async (toolUseId) => {
    await window.__yaadeAgent!.selectToolUse?.(toolUseId);
  }, id);
  await waitForVisibleTerminalSurface(page);
  return id;
}

/** 1 */ test("boots a visible empty Session without opening a tool", async () => {
  const app = await launchWeb({});
  try {
    const page = app.page;
    await openToolSessionShell(page);
    await expectSelectorVisible(page, '[role="tablist"] [role="tab"]');
    await expectSelectorVisible(page, '[data-yaade-session-empty]');
    await expectLocatorCount(
      page.locator('[data-yaade-tool-tabs] [data-yaade-tool-use]'),
      0,
    );
    await expectLocatorCount(page.locator('[data-yaade-editor-tool]'), 0);
    await expectLocatorCount(
      page.locator('[data-yaade-session-empty] [data-yaade-empty-agent]'),
      0,
    );
    await expectNotContainsText(
      page,
      '[data-yaade-session-empty]',
      "Or pick a CLI",
    );
    await page.waitForFunction(
      () => {
        const state = window.__yaadeAgent?.getState();
        return !state?.activeToolUseId && (state?.toolUses?.length ?? 0) === 0;
      },
    );
    await expectSelectorVisible(page, '[data-yaade-empty-tool="editor"]');
    await expectSelectorVisible(page, '[data-yaade-empty-tool="git"]');
  } finally {
    await app.app.close();
  }
});

test("Editor tabs preserve dirty state, save, and reconnect the language server", async () => {
  const mock = createMockLspHarness();
  const app = await launchWeb({
    env: mock.env,
    workspaceRel: "fixtures/non-git-search",
  });
  try {
    const page = app.page;
    await openToolSessionShell(page);
    await createEditorToolUse(page);
    await page.getByRole("treeitem", { name: /index\.ts$/i }).click();
    await expectSelectorVisible(page, "[data-yaade-monaco-editor]");
    await mock.waitForClientMethod("textDocument/didOpen", {
      timeoutMs: 15_000,
    });
    await page.getByRole("treeitem", { name: /other\.ts$/i }).click();
    await expectLocatorCount(
      page.locator('[data-yaade-editor-tabs] [role="tab"]'),
      2,
    );
    await page
      .locator('[data-yaade-editor-tab$="/src/index.ts"] [role="tab"]')
      .click();

    const input = page.locator(
      "[data-yaade-monaco-editor] textarea.inputarea",
    );
    await input.focus();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("\n// tool-editor-dirty");
    await expect
      .poll(() =>
        page
          .locator('[data-yaade-editor-tab$="/src/index.ts"]')
          .getAttribute("data-dirty"),
      )
      .toBe("true");

    const beforeSave = mock.captures().length;
    await page.keyboard.press(
      `${process.platform === "darwin" ? "Meta" : "Control"}+KeyS`,
    );
    await mock.waitForClientMethod("textDocument/didSave", {
      timeoutMs: 15_000,
      afterCaptureCount: beforeSave,
    });
    await expect
      .poll(() =>
        page
          .locator('[data-yaade-editor-tab$="/src/index.ts"]')
          .getAttribute("data-dirty"),
      )
      .toBeNull();

    const beforeCrash = mock.captures().length;
    mock.crash(1, 72);
    await mock.waitForStartCount(2, 15_000);
    await mock.waitForClientMethod("textDocument/didOpen", {
      timeoutMs: 15_000,
      afterCaptureCount: beforeCrash,
    });
    await expect
      .poll(() =>
        page
          .locator("[data-yaade-editor-lsp-status]")
          .getAttribute("data-yaade-editor-lsp-status"),
      )
      .toBe("ready");
  } finally {
    await app.app.close();
    mock.dispose();
  }
});

test("Editor references render and the compact Explorer toggles", async () => {
  const mock = createMockLspHarness();
  const app = await launchWeb({
    env: mock.env,
    workspaceRel: "fixtures/non-git-search",
  });
  try {
    const page = app.page;
    await openToolSessionShell(page);
    await createEditorToolUse(page);
    await page.getByRole("treeitem", { name: /index\.ts$/i }).click();
    await expectSelectorVisible(page, "[data-yaade-monaco-editor]");
    await mock.waitForClientMethod("textDocument/didOpen", {
      timeoutMs: 15_000,
    });

    const explorerRow = page.getByRole("treeitem", { name: /index\.ts$/i });
    const explorerFontSize = await explorerRow.evaluate(element =>
      Number.parseFloat(getComputedStyle(element).fontSize),
    );
    expect(explorerFontSize).toBeGreaterThanOrEqual(12);

    await expectLocatorCount(page.getByText("LSP on", { exact: true }), 0);
    await expectLocatorCount(page.getByText("⌘P quick open", { exact: true }), 0);

    const explorerToggle = page.locator(
      "[data-yaade-editor-explorer-header] [data-yaade-editor-explorer-toggle]",
    );
    await expectLocatorCount(explorerToggle, 1);
    expect(await explorerToggle.getAttribute("aria-label")).toBe("Hide Explorer");
    await explorerToggle.click();
    await page
      .locator("[data-yaade-editor-file-tree]")
      .first()
      .waitFor({ state: "hidden" });
    expect(await explorerToggle.getAttribute("aria-label")).toBe("Show Explorer");
    await explorerToggle.click();
    await expectSelectorVisible(page, "[data-yaade-editor-file-tree]");

    const editorTypography = await page
      .locator("[data-yaade-monaco-editor] .view-line")
      .first()
      .evaluate(element => {
        const style = getComputedStyle(element);
        return {
          fontFamily: style.fontFamily,
          lineHeight: Number.parseFloat(style.lineHeight),
        };
      });
    expect(editorTypography.fontFamily).toContain("Geist Mono Variable");
    expect(editorTypography.lineHeight).toBeLessThanOrEqual(20);

    const input = page.locator(
      "[data-yaade-monaco-editor] textarea.inputarea",
    );
    await input.focus();
    await page.keyboard.press("Control+Home");
    const beforeReferences = mock.captures().length;
    await page.keyboard.press("Shift+F12");
    await mock.waitForClientMethod("textDocument/references", {
      timeoutMs: 15_000,
      afterCaptureCount: beforeReferences,
    });

    const references = ".reference-zone-widget";
    const referenceRows = `${references} .monaco-list-row`;
    await expectSelectorVisible(page, references);
    await expectContainsText(page, references, "index.ts");
    await expectNotContainsText(page, references, "No references");
    await expectLayout(page, {
      selector: referenceRows,
      minItems: 2,
      minUniqueTops: 2,
      minRowHeight: 18,
    });
    await expectNoOverlap(page, { selector: referenceRows, minItems: 2 });
    await expectRowSpacing(page, { selector: referenceRows, minItems: 2 });
    await expectRowTextVisible(page, {
      selector: referenceRows,
      minItems: 2,
    });
  } finally {
    await app.app.close();
    mock.dispose();
  }
});

test("Mod-P opens Editor Quick Open before and after a file is open", async () => {
  const app = await launchWeb({
    workspaceRel: path.join(REPO_ROOT, "fixtures/non-git-search"),
    startPath: "/",
  });
  try {
    const page = app.page;
    await openToolSessionShell(page);
    await createEditorToolUse(page);
    await expectContainsText(
      page,
      "[data-yaade-editor-tool]",
      "Open a file to start editing",
    );

    const shortcut = `${process.platform === "darwin" ? "Meta" : "Control"}+KeyP`;
    await page.keyboard.press(shortcut);
    await expectSelectorVisible(
      page,
      '[data-yaade-list-panel="yaade:palette"]',
    );
    await page.keyboard.type("other");
    await expectListRows(page, {
      panel: "yaade:palette",
      minItems: 1,
      needle: "other.ts",
    });
    await expectNotContainsText(
      page,
      '[data-yaade-list-panel="yaade:palette"]',
      "No matching files",
    );
    await page
      .locator('[data-yaade-list-panel="yaade:palette"] [data-yaade-list-item]')
      .first()
      .click();
    await expectSelectorVisible(
      page,
      '[data-yaade-editor-tool] [data-yaade-monaco-editor]',
    );

    await page.keyboard.press(shortcut);
    await expectSelectorVisible(
      page,
      '[data-yaade-list-panel="yaade:palette"]',
    );
  } finally {
    await app.app.close();
  }
});

/** 2 */ test("creates two Sessions; reload preserves order", async () => {
  const app = await launchWeb({});
  try {
    const page = app.page;
    await openToolSessionShell(page);
    await page.getByRole("button", { name: "New session" }).click();
    await page.waitForFunction(
      () => (window.__yaadeAgent?.getState().sessions?.length ?? 0) >= 2,
    );
    const before = await page.evaluate(() => {
      const state = window.__yaadeAgent!.getState();
      return {
        sessionIds: (state.sessions ?? []).map(
          (session: { id: string }) => session.id,
        ),
        activeSessionId: state.activeSessionId,
      };
    });
    await page.reload();
    await openToolSessionShell(page);
    await page.waitForFunction(
      () => (window.__yaadeAgent?.getState().sessions?.length ?? 0) >= 2,
    );
    const after = await page.evaluate(() => {
      const state = window.__yaadeAgent!.getState();
      return {
        sessionIds: (state.sessions ?? []).map(
          (session: { id: string }) => session.id,
        ),
        activeSessionId: state.activeSessionId,
      };
    });
    expect(after.sessionIds).toEqual(before.sessionIds);
  } finally {
    await app.app.close();
  }
});

/** 3 */ test("creates a Terminal ToolUse and observes a PTY marker", async () => {
  const app = await launchWeb({});
  try {
    const page = app.page;
    await openToolSessionShell(page);
    await createTerminalToolUse(page);
    const projectDisplay = await page.getByLabel("Tool project").inputValue();
    const project = await page.evaluate(() => {
      const state = window.__yaadeAgent!.getState();
      return (state.toolUses ?? []).find(
        (use: { id: string }) => use.id === state.activeToolUseId,
      )?.context?.project;
    });
    expect(projectDisplay).toBe(project?.projectName);
    expect(projectDisplay).not.toBe(project?.projectId);
    await page.getByLabel("Tool project").click();
    const [projectControlBox, projectPopupBox] = await Promise.all([
      page.getByLabel("Tool project").boundingBox(),
      page.locator('[data-slot="combobox-popup"]').boundingBox(),
    ]);
    expect(projectControlBox).not.toBeNull();
    expect(projectPopupBox).not.toBeNull();
    expect(projectPopupBox!.width).toBeLessThanOrEqual(
      projectControlBox!.width + 2,
    );
    await expectSelectorVisible(
      page,
      '[data-slot="combobox-item"][data-selected]',
    );
    await page.keyboard.press("Escape");
    await focusTerminal(page);
    const marker = `yaade-tool-pty-${Date.now()}`;
    await page.keyboard.type(`echo ${marker}`);
    await page.keyboard.press("Enter");
    await waitForToolTerminalText(page, marker);
    await page.waitForFunction(
      () => {
        const title = document
          .querySelector(
            '[data-yaade-tool-pane-tab][data-active] button[role="tab"]',
          )
          ?.textContent?.trim();
        return Boolean(title && title !== "Terminal");
      },
      null,
      { timeout: 10_000 },
    );
  } finally {
    await app.app.close();
  }
});

/** 4 */ test("TerminalTool PTY marker survives Session switch", async () => {
  const app = await launchWeb({});
  try {
    const page = app.page;
    await openToolSessionShell(page);
    await createTerminalToolUse(page);
    await focusTerminal(page);
    const marker = `yaade-tool-session-${Date.now()}`;
    await page.keyboard.type(`echo ${marker}`);
    await page.keyboard.press("Enter");
    await waitForToolTerminalText(page, marker);
    const first = await page.evaluate(() => {
      const state = window.__yaadeAgent!.getState();
      const tool = (state.toolUses ?? []).find(
        (use: {
          id: string;
          context?: { project?: { projectName?: string } };
        }) => use.id === state.activeToolUseId,
      );
      return {
        sessionId: state.activeSessionId,
        toolUseId: tool?.id,
        projectName: tool?.context?.project?.projectName,
      };
    });
    expect(first.sessionId).toBeTruthy();
    expect(first.toolUseId).toBeTruthy();
    expect(first.projectName).toBeTruthy();
    if (!first.sessionId || !first.toolUseId || !first.projectName) {
      throw new Error("first session tool metadata missing");
    }
    await page.getByRole("button", { name: "New session" }).click();
    await page.waitForFunction(
      () => (window.__yaadeAgent?.getState().sessions?.length ?? 0) >= 2,
    );
    await pressMuxPrefix(page, "KeyU");
    await expectListRows(page, {
      panel: "yaade:palette",
      minItems: 1,
      needle: first.projectName,
    });
    await expectNotContainsText(
      page,
      '[data-yaade-list-panel="yaade:palette"]',
      "No current tool uses",
    );
    await page
      .locator(`[data-yaade-tool-switcher-use="${first.toolUseId}"]`)
      .click();
    await page.waitForFunction(
      (sessionId) =>
        window.__yaadeAgent?.getState().activeSessionId === sessionId,
      first.sessionId,
    );
    await waitForVisibleTerminalSurface(page);
    await waitForToolTerminalText(page, marker);
  } finally {
    await app.app.close();
  }
});

/** 5 */ test("creates an AgentTool when a provider is available", async () => {
  const app = await launchWeb({});
  try {
    const page = app.page;
    await openToolSessionShell(page);
    await createEditorToolUse(page);
    const provider = await page.evaluate(async () => {
      const list = await window.yaade?.agents?.listProviders?.(true);
      return list?.find((item) => item.available)?.provider ?? null;
    });
    test.skip(!provider, "no agent CLI provider available on this host");
    await page.locator('[data-yaade-new-tool="agent"]').click();
    const providerMenu = page.locator("[data-yaade-agent-provider-menu]");
    await expectSelectorVisible(page, "[data-yaade-agent-provider-menu]");
    await providerMenu
      .locator(`[data-yaade-agent-provider="${provider}"]`)
      .click();
    await page.waitForFunction(
      () =>
        (window.__yaadeAgent?.getState().toolUses ?? []).some(
          (use: { kind: string }) => use.kind === "agent",
        ),
      null,
      { timeout: 30_000 },
    );
    const agentId = await page.evaluate(
      () =>
        window.__yaadeAgent
          ?.getState()
          .toolUses?.find((use: { kind: string }) => use.kind === "agent")?.id,
    );
    if (!agentId) throw new Error("agent tool missing after creation");
    await page.locator(`[data-yaade-tool-use="${agentId}"]`).click();
    await openToolContext(page);
    await expectSelectorVisible(page, "#tool-provider");
    const use = await page.evaluate(() =>
      (window.__yaadeAgent!.getState().toolUses ?? []).find(
        (item: { kind: string }) => item.kind === "agent",
      ),
    );
    expect(use).toBeTruthy();
    const updatedProvider = await page.evaluate(async () => {
      const state = window.__yaadeAgent!.getState();
      const agent = (state.toolUses ?? []).find(
        (item: { kind: string }) => item.kind === "agent",
      );
      if (!agent || agent.input.kind !== "agent")
        throw new Error("agent tool missing");
      const updated = await window.yaade!.tools!.updateUseInput({
        _tag: "UpdateToolUseInput",
        toolUseId: agent.id,
        inputRevision: agent.inputRevision,
        input: agent.input.args
          ? {
              _tag: "AgentToolInput",
              kind: "agent",
              provider: agent.input.provider,
              args: agent.input.args,
            }
          : {
              _tag: "AgentToolInput",
              kind: "agent",
              provider: agent.input.provider,
            },
      });
      return updated.input.kind === "agent" ? updated.input.provider : null;
    });
    expect(updatedProvider).toBe(provider);
    await waitForVisibleTerminalSurface(page);
  } finally {
    await app.app.close();
  }
});

/** 6 */ test("SearchTool renders file cards and opens a Monaco buffer", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-tool-search-"));
  fs.cpSync(path.join(REPO_ROOT, "fixtures/non-git-search"), project, {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(project, "broad-results.txt"),
    Array.from(
      { length: 520 },
      (_, index) => `broadNeedle result-row-${String(index).padStart(3, "0")}`,
    ).join("\n"),
  );
  for (let index = 0; index < 12; index += 1) {
    fs.writeFileSync(
      path.join(project, `file-${String(index).padStart(2, "0")}.txt`),
      `fileNeedle result-file-${String(index).padStart(2, "0")}\n`,
    );
  }
  const app = await launchWeb({ workspaceRel: project });
  try {
    const page = app.page;
    await openToolSessionShell(page);
    await createSearchToolUse(page, "nonGitSearchFixture");
    const searchOptions = page.locator("[data-yaade-project-search-options]");
    await expectLocatorVisible(searchOptions);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const query = document.querySelector("[data-yaade-project-search-input]");
          const options = document.querySelector("[data-yaade-project-search-options]");
          if (!query || !options) return false;
          const queryRect = query.getBoundingClientRect();
          const optionsRect = options.getBoundingClientRect();
          return (
            optionsRect.left > queryRect.left &&
            optionsRect.right <= queryRect.right &&
            optionsRect.top >= queryRect.top &&
            optionsRect.bottom <= queryRect.bottom
          );
        }),
      )
      .toBe(true);

    const includeChip = page.locator('[data-yaade-project-search-filter="include"]');
    await includeChip.click();
    const includeInput = page.getByRole("textbox", { name: "Files to include" });
    await includeInput.waitFor({ state: "visible" });
    await includeInput.fill("src/**");
    expect(await includeChip.getAttribute("data-active")).toBe("true");
    await page.keyboard.press("Escape");
    await includeInput.waitFor({ state: "hidden" });
    await includeChip.click();
    await includeInput.fill("");
    expect(await includeChip.getAttribute("data-active")).toBe("false");
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () =>
        document.querySelectorAll(
          '[data-yaade-list-panel="project-search"] [data-yaade-list-item]',
        ).length > 0,
      null,
      { timeout: 10_000 },
    );

    await expectListRows(page, {
      panel: "project-search",
      minItems: 1,
      needle: "nonGitSearchFixture",
    });
    await expectContainsText(
      page,
      "[data-yaade-tool-pane-tab][data-active]",
      "nonGitSearchFixture",
    );
    await expectNotContainsText(
      page,
      '[data-yaade-list-panel="project-search"]',
      "No matches",
    );
    await expectContainsText(
      page,
      '[data-yaade-list-panel="project-search"]',
      "beforeSearchContext",
    );
    await expectContainsText(
      page,
      '[data-yaade-list-panel="project-search"]',
      "afterSearchContext",
    );

    const searchInput = page.getByLabel("Search project");
    const results = page.locator('[data-yaade-list-panel="project-search"]');
    const fileCards = results.locator("[data-yaade-project-search-file]");
    const manualLoadButtons = page.getByRole("button", {
      name: /Show \d+ more files|Load more matches/,
    });
    await searchInput.fill("fileNeedle");
    await expectListRows(page, {
      panel: "project-search",
      minItems: 2,
      needle: "result-file-01",
    });
    await expectLocatorCount(manualLoadButtons, 0);
    await expect
      .poll(async () => {
        await results.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        return fileCards.count();
      })
      .toBe(12);
    await expectSelectorVisible(
      page,
      '[data-yaade-project-search-file="file-11.txt"]',
    );

    await searchInput.fill("broadNeedle");
    await expectListRows(page, {
      panel: "project-search",
      minItems: 2,
      needle: "result-row-001",
    });
    await expect
      .poll(async () => {
        await results.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        return page
          .getByRole("status")
          .filter({ hasText: "matches in" })
          .textContent();
      })
      .toContain("520 matches in 1 file");
    await expectLocatorCount(manualLoadButtons, 0);

    await searchInput.fill("nonGitSearchFixture");
    await expectListRows(page, {
      panel: "project-search",
      minItems: 1,
      needle: "nonGitSearchFixture",
    });
    await expectSelectorVisible(
      page,
      '[data-yaade-project-search-file*="src/index.ts"]',
    );
    await page.locator("[data-yaade-project-search-hit]").first().click();
    await expectSelectorVisible(
      page,
      '[data-yaade-search-editor*="/src/index.ts"] [data-yaade-monaco-editor]',
    );
    await expectSelectorVisible(page, "[data-yaade-editor-file-tree]");
    await expectContainsText(page, "[data-yaade-editor-breadcrumbs]", "src");
    await expectContainsText(
      page,
      "[data-yaade-editor-breadcrumbs]",
      "index.ts:2",
    );
    await expectLocatorVisible(
      page.getByRole("treeitem", { name: /src\/index\.ts|index\.ts/i }),
    );
    await page.waitForFunction(
      () => {
        const editor = document.querySelector(
          '[data-yaade-monaco-editor][data-yaade-monaco-language="typescript"]',
        );
        if (!editor) return false;
        const tokenClasses = new Set(
          [...editor.querySelectorAll(".view-line span")]
            .flatMap((span) => [...span.classList])
            .filter((name) => /^mtk\d+$/.test(name)),
        );
        return tokenClasses.size >= 2;
      },
      null,
      { timeout: 20_000 },
    );
    await page.keyboard.press(
      `${process.platform === "darwin" ? "Meta" : "Control"}+KeyP`,
    );
    await expectSelectorVisible(
      page,
      '[data-yaade-list-panel="yaade:palette"]',
    );
    await page.keyboard.type("other");
    await expectListRows(page, {
      panel: "yaade:palette",
      minItems: 1,
      needle: "src/other.ts",
    });
    await expectNotContainsText(
      page,
      '[data-yaade-list-panel="yaade:palette"]',
      "No matching files",
    );
    await page
      .locator('[data-yaade-list-panel="yaade:palette"] [data-yaade-list-item]')
      .filter({ hasText: "src/other.ts" })
      .click();
    await expectSelectorVisible(
      page,
      '[data-yaade-search-editor*="/src/other.ts"] [data-yaade-monaco-editor]',
    );
    await page.getByRole("treeitem", { name: /^index\.ts$/i }).click();
    await expectSelectorVisible(
      page,
      '[data-yaade-search-editor*="/src/index.ts"] [data-yaade-monaco-editor]',
    );
  } finally {
    await app.app.close();
    fs.rmSync(project, { recursive: true, force: true });
  }
});

/** 7 */ test("changing search quickly never shows stale-query rows", async () => {
  const app = await launchWeb({ workspaceRel: "fixtures/non-git-search" });
  try {
    const page = app.page;
    await openToolSessionShell(page);
    await createSearchToolUse(page, "nonGitSearchFixture");
    await expectListRows(page, {
      panel: "project-search",
      minItems: 1,
      needle: "nonGitSearchFixture",
    });
    const input = page.getByLabel("Search project");
    await input.fill("this-query-should-miss-zzzz");
    await page.waitForFunction(
      () => {
        const panel = document.querySelector(
          '[data-yaade-list-panel="project-search"]',
        );
        return (panel?.textContent ?? "").includes("No matches");
      },
      null,
      { timeout: 20_000 },
    );
    await expectContainsText(
      page,
      '[data-yaade-list-panel="project-search"]',
      "No matches",
    );
    const stale = await page.evaluate(() =>
      [
        ...document.querySelectorAll(
          '[data-yaade-list-panel="project-search"] [data-yaade-list-item]',
        ),
      ].some((row) => (row.textContent ?? "").includes("nonGitSearchFixture")),
    );
    expect(stale).toBe(false);
  } finally {
    await app.app.close();
  }
});

/** 8 */ test("one Session can hold ToolUses from two projects", async () => {
  const app = await launchWeb({});
  try {
    const page = app.page;
    await openToolSessionShell(page);
    const secondRoot = path.resolve(REPO_ROOT, "fixtures/second-workspace");
    if (!fs.existsSync(path.join(secondRoot, "README.md"))) {
      fs.mkdirSync(secondRoot, { recursive: true });
      fs.writeFileSync(path.join(secondRoot, "README.md"), "second\n");
    }
    await page.evaluate(async (rootPath) => {
      const response = await fetch("/api/v1/projects", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ rootPath }),
      });
      if (!response.ok)
        throw new Error(`register second project failed: ${response.status}`);
    }, secondRoot);
    await createTerminalViaApi(page, "term-a", "sample-workspace");
    await createTerminalViaApi(page, "term-b", "second-workspace");
    const paths = await page.evaluate(() => {
      const uses = window.__yaadeAgent!.getState().toolUses ?? [];
      return uses.map(
        (use: {
          context?: { project?: { projectPath?: string } };
          title?: string;
        }) => ({
          title: use.title,
          path: use.context?.project?.projectPath ?? "",
        }),
      );
    });
    const unique = new Set(paths.map((item) => item.path).filter(Boolean));
    expect(paths.some((item) => item.title === "term-a")).toBeTruthy();
    expect(paths.some((item) => item.title === "term-b")).toBeTruthy();
    expect(unique.size).toBeGreaterThanOrEqual(2);
  } finally {
    await app.app.close();
  }
});

/** 9 */ test("isolated branch worktree creates a managed checkout without switching Main", async () => {
  const homeDir = fs.mkdtempSync(
    path.join(path.dirname(REPO_ROOT), "yaade-e2e-home-"),
  );
  const app = await launchWeb({ homeDir });
  try {
    const page = app.page;
    await openToolSessionShell(page);
    await ensureProjectGitRepo(page);
    const branch = `yaade-e2e-${Date.now()}`;
    await createTerminalToolUse(page);
    await page.locator("#tool-checkout").click();
    await page.getByRole("option", { name: "New isolated branch…" }).click();
    await page.getByLabel("Isolated branch worktree").fill(branch);
    await page.getByLabel("Isolated branch worktree").press("Enter");
    await page.waitForFunction(
      () => {
        const state = window.__yaadeAgent?.getState();
        // SAFETY: the browser test harness exposes toolUses with these optional fields.
        const uses = (state?.toolUses ?? []) as readonly {
          id?: string;
          context?: { managedWorktree?: boolean };
        }[];
        const active = uses.find((use) => use.id === state?.activeToolUseId);
        return active?.context?.managedWorktree === true;
      },
      null,
      { timeout: 30_000 },
    );
    const checkout = await page.evaluate(() => {
      const state = window.__yaadeAgent!.getState();
      // SAFETY: the browser test harness exposes toolUses with these optional fields.
      const uses = (state.toolUses ?? []) as readonly {
        id?: string;
        context?: {
          checkoutPath?: string;
          checkoutLabel?: string;
          managedWorktree?: boolean;
        };
      }[];
      return uses.find((use) => use.id === state.activeToolUseId)?.context;
    });
    expect(checkout?.checkoutPath ?? "").toContain(".yaade/worktrees");
    expect(checkout?.managedWorktree).toBe(true);
  } finally {
    await app.app.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

/** 10 */ test("reload restores ToolUses and selected ToolUse", async () => {
  const app = await launchWeb({});
  try {
    const page = app.page;
    await openToolSessionShell(page);
    const first = await createTerminalViaApi(page, "keep-me");
    await createTerminalViaApi(page, "select-me");
    const before = await page.evaluate(() => {
      const state = window.__yaadeAgent!.getState();
      return {
        ids: (state.toolUses ?? []).map((use: { id: string }) => use.id),
        active: state.activeToolUseId,
      };
    });
    expect(before.ids).toContain(first);
    expect(before.ids.length).toBeGreaterThanOrEqual(2);
    await page.reload();
    await openToolSessionShell(page);
    await page.waitForFunction(
      (count) =>
        (window.__yaadeAgent?.getState().toolUses?.length ?? 0) >= count,
      before.ids.length,
      { timeout: 20_000 },
    );
    const after = await page.evaluate(() => {
      const state = window.__yaadeAgent!.getState();
      return {
        ids: (state.toolUses ?? []).map((use: { id: string }) => use.id),
        active: state.activeToolUseId,
      };
    });
    expect(after.ids.sort()).toEqual(before.ids.sort());
    expect(after.active).toBeTruthy();
  } finally {
    await app.app.close();
  }
});

/** 11 */ test("host reconnect reconciles ToolUse status without clearing search", async () => {
  const app = await launchWeb({ workspaceRel: "fixtures/non-git-search" });
  try {
    const page = app.page;
    await openToolSessionShell(page);
    await createSearchToolUse(page, "nonGitSearchFixture");
    await expectListRows(page, {
      panel: "project-search",
      minItems: 1,
      needle: "nonGitSearchFixture",
    });
    await page.evaluate(() => {
      window.dispatchEvent(new Event("yaade:host-reconnected"));
    });
    await page.waitForFunction(
      () => window.__yaadeAgent?.getState().connection === "connected",
      null,
      {
        timeout: 15_000,
      },
    );
    await expectListRows(page, {
      panel: "project-search",
      minItems: 1,
      needle: "nonGitSearchFixture",
    });
  } finally {
    await app.app.close();
  }
});

/** 12 */ test("closing a live Session offers keep-running and stop-tools choices", async () => {
  const app = await launchWeb({});
  try {
    const page = app.page;
    await openToolSessionShell(page);
    await createTerminalToolUse(page);
    const sessionTitle = await page.evaluate(
      () => window.__yaadeAgent!.getState().sessions?.[0]?.title ?? "Session",
    );
    await page.getByRole("button", { name: `Close ${sessionTitle}` }).click();
    await expectContainsText(page, "body", "Close session?");
    await expectLocatorVisible(
      page.getByRole("button", { name: "Keep running and archive" }),
    );
    await expectLocatorVisible(
      page.getByRole("button", { name: "Stop tools and archive" }),
    );
    await page
      .getByRole("button", { name: "Keep running and archive" })
      .click();
    await page.waitForFunction(
      () => (window.__yaadeAgent?.getState().sessions?.length ?? 0) >= 1,
    );
    // Host always keeps a visible Session after the last one is archived.
    await expectSelectorVisible(page, '[data-yaade-shell="tool-session"]');
  } finally {
    await app.app.close();
  }
});

/** 13 */ test("pane tabs render one process viewport while host PTYs survive", async () => {
  const app = await launchWeb({});
  try {
    const page = app.page;
    await openToolSessionShell(page);
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      ids.push(await createTerminalViaApi(page, `term-${i}`));
    }
    await expectLocatorCount(page.locator("[data-yaade-tool-pane-tab]"), 7);
    await expectLocatorCount(page.locator("[data-yaade-panel-leaf]"), 1);
    await expectLocatorCount(page.locator("[data-yaade-tool-tile]"), 1);
    const firstId = ids[0]!;
    await page.evaluate(async (id) => {
      await window.__yaadeAgent!.selectToolUse!(id);
    }, firstId);
    await page.waitForSelector("[data-yaade-terminal-canvas]", { timeout: 30_000 });
    await focusTerminal(page);
    const marker = `lru-survive-${Date.now()}`;
    await page.keyboard.type(`echo ${marker}`);
    await page.keyboard.press("Enter");
    await waitForToolTerminalText(page, marker);
  } finally {
    await app.app.close();
  }
});

/** 14 */ test("bare Escape reaches a focused terminal", async () => {
  const app = await launchWeb({});
  try {
    const page = app.page;
    await openToolSessionShell(page);
    await createTerminalToolUse(page);
    await focusTerminal(page);
    await page.keyboard.type("echo yaadeESC");
    await page.keyboard.press("Escape");
    await page.keyboard.press("KeyB");
    await page.keyboard.type("XX");
    await page.keyboard.press("Enter");
    await waitForToolTerminalText(page, "XXyaadeESC");
  } finally {
    await app.app.close();
  }
});

/** 15 */ test("prefix Ctrl-a c creates a Session; double prefix does not", async () => {
  const app = await launchWeb({});
  try {
    const page = app.page;
    await openToolSessionShell(page);
    await createTerminalToolUse(page);
    const before = await page.evaluate(
      () => window.__yaadeAgent!.getState().sessions?.length ?? 0,
    );
    await page.locator("[data-yaade-terminal-canvas]").first().click();
    await page.keyboard.down("Control");
    await page.keyboard.press("a");
    await page.keyboard.up("Control");
    await page.waitForTimeout(50);
    await page.keyboard.press("c");
    await page.waitForFunction(
      (count) =>
        (window.__yaadeAgent?.getState().sessions?.length ?? 0) > count,
      before,
      { timeout: 15_000 },
    );
    const mid = await page.evaluate(
      () => window.__yaadeAgent!.getState().sessions?.length ?? 0,
    );
    await page.evaluate(
      async (id) => {
        await window.__yaadeAgent!.selectSession!(id);
      },
      await page.evaluate(
        () => window.__yaadeAgent!.getState().sessions?.[0]?.id,
      ),
    );
    await waitForVisibleTerminalSurface(page);
    await page.locator(".absolute.inset-0.flex [data-yaade-terminal-canvas], [data-yaade-terminal-canvas]").first().click();
    await page.keyboard.down("Control");
    await page.keyboard.press("a");
    await page.keyboard.up("Control");
    await page.waitForTimeout(50);
    await page.keyboard.down("Control");
    await page.keyboard.press("a");
    await page.keyboard.up("Control");
    await page.waitForTimeout(100);
    const after = await page.evaluate(
      () => window.__yaadeAgent!.getState().sessions?.length ?? 0,
    );
    expect(after).toBe(mid);
  } finally {
    await app.app.close();
  }
});

/** 16 */ test("legacy project path URL resolves into the Session shell", async () => {
  const app = await launchWeb({});
  try {
    const page = app.page;
    await page.evaluate(() => {
      history.pushState(null, "", "/dev/yaade");
      window.dispatchEvent(new Event("popstate"));
    });
    await page.waitForSelector('[data-yaade-shell="tool-session"]', {
      timeout: 15_000,
    });
    const href = await page.evaluate(() => location.href);
    expect(new URL(href).pathname).toBe("/");
  } finally {
    await app.app.close();
  }
});

/** 17 */ test("mobile pane tabs keep the selected ToolUse visible", async () => {
  const app = await launchWeb({});
  try {
    const page = app.page;
    await page.setViewportSize({ width: 390, height: 844 });
    await openToolSessionShell(page);
    await createTerminalViaApi(page, "mobile-term");
    await expectSelectorVisible(
      page,
      '[data-yaade-tool-pane-tab][data-active]',
    );
    const activeTabBox = await page
      .locator('[data-yaade-tool-pane-tab][data-active]')
      .boundingBox();
    const viewportWidth = await page.evaluate(() => window.innerWidth);
    expect(activeTabBox).not.toBeNull();
    expect(activeTabBox?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((activeTabBox?.x ?? 0) + (activeTabBox?.width ?? 0)).toBeLessThanOrEqual(
      viewportWidth,
    );
    await waitForVisibleTerminalSurface(page);
  } finally {
    await app.app.close();
  }
});

/** 18 */ test("changing a live Terminal project does not error", async () => {
  const app = await launchWeb({});
  try {
    const page = app.page;
    await openToolSessionShell(page);
    const secondRoot = path.resolve(REPO_ROOT, "fixtures/second-workspace");
    if (!fs.existsSync(path.join(secondRoot, "README.md"))) {
      fs.mkdirSync(secondRoot, { recursive: true });
      fs.writeFileSync(path.join(secondRoot, "README.md"), "second\n");
    }
    await page.evaluate(async (rootPath) => {
      const response = await fetch("/api/v1/projects", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ rootPath }),
      });
      if (!response.ok)
        throw new Error(`register second project failed: ${response.status}`);
    }, secondRoot);
    const id = await createTerminalViaApi(
      page,
      "retarget-me",
      "sample-workspace",
    );
    await waitForVisibleTerminalSurface(page);
    const result = await page.evaluate(async (toolUseId) => {
      const tools = window.yaade?.tools;
      if (!tools) throw new Error("tools API missing");
      // SAFETY: the preceding find predicate establishes the tool-use identifier.
      const use = (window.__yaadeAgent!.getState().toolUses ?? []).find(
        (item: { id: string }) => item.id === toolUseId,
      ) as { id: string } | undefined;
      if (!use) throw new Error("tool use missing");
      const projects = await tools.listProjects();
      const next = projects.find((item) =>
        item.projectPath.includes("second-workspace"),
      );
      if (!next) throw new Error("second project missing");
      const updated = await tools.updateUseContext({
        _tag: "UpdateToolUseContext",
        toolUseId: use.id,
        revision: 0,
        project: next,
        checkout: { _tag: "MainCheckout", kind: "main" },
      });
      return { projectPath: updated.context.project.projectPath };
    }, id);
    expect(result.projectPath).toContain("second-workspace");
    await expectNotContainsText(
      page,
      '[data-yaade-shell="tool-session"]',
      "Action failed",
    );
    await openToolContext(page);
    await expectSelectorVisible(page, "#tool-project");
    await waitForVisibleTerminalSurface(page);
  } finally {
    await app.app.close();
  }
});

/** 19 */ test("Session settings opens from the tab bar and Mod-,", async ({}, testInfo) => {
  const app = await launchWeb({});
  try {
    const page = app.page;
    await openToolSessionShell(page);

    await page.locator("[data-yaade-session-settings]").click();
    await expectLocatorVisible(page.locator("[data-yaade-settings-overlay]"));
    await expectLocatorCount(page.locator("[data-yaade-theme-option]"), 16);
    await expectLocatorVisible(page.locator("[data-yaade-mono-font-picker]"));

    await page.locator('[data-yaade-theme-option="tokyonight-night"]').click();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("jet-theme-id")))
      .toBe("tokyonight-night");
    await testInfo.attach("tool-session-settings.png", {
      body: Buffer.from(await page.screenshot(), "base64"),
      contentType: "image/png",
    });

    await page.getByRole("button", { name: "Close settings" }).click();
    await page.keyboard.press(
      `${process.platform === "darwin" ? "Meta" : "Control"}+Comma`,
    );
    await expectLocatorVisible(page.locator("[data-yaade-settings-overlay]"));
  } finally {
    await app.app.close();
  }
});

/** 20 */ test("prefix Ctrl-a shows the tool HUD; s opens Search", async () => {
  const app = await launchWeb({});
  try {
    const page = app.page;
    await openToolSessionShell(page);
    await page.locator("[data-yaade-session-tabs]").click();
    await page.keyboard.down("Control");
    await page.keyboard.press("a");
    await page.keyboard.up("Control");
    await expectSelectorVisible(page, "[data-yaade-which-key]");
    await expectContainsText(page, "[data-yaade-which-key]", "New Agent");
    await expectContainsText(page, "[data-yaade-which-key]", "New Search");
    await expectContainsText(page, "[data-yaade-which-key]", "Open");
    await expectLocatorCount(
      page.getByRole("button", { name: "New Search (s)" }),
      1,
    );
    const searchShortcut = page.locator('[data-yaade-which-key-item="s"]');
    await searchShortcut.focus();
    await searchShortcut.press("Enter");
    await page.waitForSelector('[data-yaade-list-panel="project-search"]', {
      timeout: 30_000,
    });
    await expectLocatorCount(page.locator("[data-yaade-which-key]"), 0);
  } finally {
    await app.app.close();
  }
});

/** 21 */ test("closing every ToolUse shows the tool launcher", async () => {
  const app = await launchWeb({});
  try {
    const page = app.page;
    await openToolSessionShell(page);
    await page.waitForFunction(
      () => Array.isArray(window.__yaadeAgent?.getState().toolUses),
    );
    const toolUseCount = await page.evaluate(
      () => window.__yaadeAgent!.getState().toolUses?.length ?? 0,
    );
    if (toolUseCount === 0) {
      await page.locator('[data-yaade-empty-tool="terminal"]').click();
      await waitForVisibleTerminalSurface(page);
      await page.waitForFunction(
        () => (window.__yaadeAgent?.getState().toolUses?.length ?? 0) >= 1,
      );
    }
    await page.evaluate(async () => {
      const uses = window.__yaadeAgent!.getState().toolUses ?? [];
      for (const use of uses) {
        await window.__yaadeAgent!.closeToolUse!(use.id);
      }
    });
    await expectSelectorVisible(page, "[data-yaade-session-empty]");
    await expectSelectorVisible(page, '[data-yaade-empty-tool="terminal"]');
    await expectSelectorVisible(page, '[data-yaade-empty-tool="search"]');
    await expectSelectorVisible(page, '[data-yaade-empty-tool="editor"]');
    await expectSelectorVisible(page, '[data-yaade-empty-tool="git"]');
    await expectContainsText(page, "[data-yaade-session-empty]", "Start a tool");
    await page.locator('[data-yaade-empty-tool="terminal"]').click();
    await waitForVisibleTerminalSurface(page);
  } finally {
    await app.app.close();
  }
});

/** 22 */ test(
  "pane tool menu creates a tool and tab right-click edits its context",
  async () => {
    const homeDir = fs.mkdtempSync(
      path.join(path.dirname(REPO_ROOT), "yaade-e2e-home-"),
    );
    const app = await launchWeb({ homeDir });
    try {
      const page = app.page;
      await openToolSessionShell(page);
      await ensureProjectGitRepo(page);

      await page.locator("[data-yaade-pane-new-tool]").click();
      await expectLocatorCount(
        page.locator("[data-yaade-pane-new-tool-kind]"),
        4,
      );
      await page.locator('[data-yaade-pane-new-tool-kind="terminal"]').click();
      await waitForVisibleTerminalSurface(page);
      await openToolContext(page);
      await expectSelectorVisible(page, "#tool-project");
      await expectSelectorVisible(page, "#tool-checkout");

      const branch = `yaade-launch-${Date.now()}`;
      await page.locator("#tool-checkout").click();
      await page
        .getByRole("option", { name: "New isolated branch…" })
        .click();
      await page.getByLabel("Isolated branch worktree").fill(branch);
      await page.getByLabel("Isolated branch worktree").press("Enter");

      await page.waitForFunction(
        (expectedBranch) => {
          const state = window.__yaadeAgent?.getState();
          // SAFETY: the find predicate selects the active tool-use context from the test state.
          const active = (state?.toolUses ?? []).find(
            (use: { id?: string }) => use.id === state?.activeToolUseId,
          ) as
            | { context?: { branch?: string; managedWorktree?: boolean } }
            | undefined;
          return (
            active?.context?.branch === expectedBranch &&
            active.context.managedWorktree === true
          );
        },
        branch,
        { timeout: 30_000 },
      );

      await openToolContext(page);
      await expectSelectorVisible(page, "[data-yaade-tool-context-popover]");
    } finally {
      await app.app.close();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  },
);

test("pane separators fill the gap and resize horizontal and vertical splits", async () => {
  const app = await launchWeb({})
  try {
    const page = app.page
    await openToolSessionShell(page)
    await createEditorToolUse(page)

    const firstPane = page.locator("[data-yaade-panel-leaf]").first()
    await firstPane.getByRole("button", { name: "Split right" }).click()
    await expect
      .poll(async () => page.locator("[data-yaade-panel-leaf]").count())
      .toBe(2)

    const horizontal = page.locator(
      '[data-yaade-pane-separator][data-orientation="horizontal"]',
    )
    const horizontalBox = await horizontal.boundingBox()
    expect(horizontalBox).toBeTruthy()
    expect(horizontalBox?.width).toBeGreaterThanOrEqual(4)
    expect(horizontalBox?.height).toBeGreaterThan(200)
    await expect
      .poll(async () => horizontal.evaluate(element => getComputedStyle(element).cursor))
      .toBe("col-resize")

    const widthBefore = (await firstPane.boundingBox())?.width
    if (widthBefore == null || horizontalBox == null) {
      throw new Error("horizontal pane geometry missing")
    }
    const horizontalStartX = horizontalBox.x + horizontalBox.width / 2
    const horizontalStartY = horizontalBox.y + horizontalBox.height / 2
    await page.mouse.move(horizontalStartX, horizontalStartY)
    await page.mouse.down()
    await page.mouse.move(horizontalStartX + 100, horizontalStartY, { steps: 10 })
    await page.mouse.up()
    await expect
      .poll(async () => Math.abs(((await firstPane.boundingBox())?.width ?? widthBefore) - widthBefore))
      .toBeGreaterThan(40)

    await firstPane.getByRole("button", { name: "Split down" }).click()
    await expect
      .poll(async () =>
        page.locator('[data-yaade-pane-separator][data-orientation="vertical"]').count(),
      )
      .toBe(1)

    const vertical = page.locator(
      '[data-yaade-pane-separator][data-orientation="vertical"]',
    )
    const verticalBox = await vertical.boundingBox()
    expect(verticalBox).toBeTruthy()
    expect(verticalBox?.height).toBeGreaterThanOrEqual(4)
    expect(verticalBox?.width).toBeGreaterThan(200)
    await expect
      .poll(async () => vertical.evaluate(element => getComputedStyle(element).cursor))
      .toBe("row-resize")

    const heightBefore = (await firstPane.boundingBox())?.height
    if (heightBefore == null || verticalBox == null) {
      throw new Error("vertical pane geometry missing")
    }
    const verticalStartX = verticalBox.x + verticalBox.width / 2
    const verticalStartY = verticalBox.y + verticalBox.height / 2
    await page.mouse.move(verticalStartX, verticalStartY)
    await page.mouse.down()
    await page.mouse.move(verticalStartX, verticalStartY + 80, { steps: 10 })
    await page.mouse.up()
    await expect
      .poll(async () => Math.abs(((await firstPane.boundingBox())?.height ?? heightBefore) - heightBefore))
      .toBeGreaterThan(30)
  } finally {
    await app.app.close()
  }
})

test("pane tiles contain ToolUse tabs and the sidebar lists sessions and agents", async () => {
  const app = await launchWeb({});
  try {
    const page = app.page;
    await openToolSessionShell(page);
    await expectContainsText(page, "[data-yaade-single-sidebar]", "Sessions");
    await expectContainsText(page, "[data-yaade-single-sidebar]", "Agents");

    const firstId = await createTerminalViaApi(page, "tile-one");
    const secondId = await createTerminalViaApi(page, "tile-two");

    await expectLocatorCount(page.locator("[data-yaade-panel-leaf]"), 1);
    await expectLocatorCount(page.locator("[data-yaade-tool-pane-tab]"), 2);
    await expectLocatorCount(page.locator("[data-yaade-tool-tile]"), 1);

    const firstTab = page.locator(
      `[data-yaade-tool-pane-tab="${firstId}"]`,
    );
    await firstTab.locator('button[aria-label^="Close "]').click();
    await expectLocatorCount(
      page.locator(`[data-yaade-tool-pane-tab="${firstId}"]`),
      0,
    );
    await page.waitForFunction(
      (id) =>
        !(window.__yaadeAgent?.getState().toolUses ?? []).some(
          (use: { id: string }) => use.id === id,
        ),
      firstId,
    );

    const pane = page.locator("[data-yaade-panel-leaf]").first();
    await pane.getByRole("button", { name: "Split right" }).click();
    await expectLocatorCount(page.locator("[data-yaade-panel-leaf]"), 2);
    const thirdId = await createTerminalViaApi(page, "tile-three");
    await expectLocatorCount(page.locator("[data-yaade-tool-tile]"), 2);

    const source = page
      .locator(`[data-yaade-tool-pane-tab="${thirdId}"]`)
      .getByRole("tab");
    const target = page.locator(`[data-yaade-tool-tile="${secondId}"]`);
    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    if (!sourceBox || !targetBox) throw new Error("tool tab drag target missing");
    await page.mouse.move(
      sourceBox.x + sourceBox.width / 2,
      sourceBox.y + sourceBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 12, sourceBox.y, {
      steps: 4,
    });
    await page.waitForTimeout(50);
    await page.mouse.move(
      targetBox.x + targetBox.width / 2,
      targetBox.y + targetBox.height / 2,
      { steps: 20 },
    );
    await page.mouse.up();
    await expectLocatorCount(page.locator("[data-yaade-panel-leaf]"), 1);
    await expectLocatorCount(page.locator("[data-yaade-tool-pane-tab]"), 2);

    const thirdPtyId = await page.evaluate((id) => {
      // SAFETY: the browser test harness exposes the optional process output fields.
      const use = (window.__yaadeAgent?.getState().toolUses ?? []).find(
        (candidate: { id: string }) => candidate.id === id,
      ) as { output?: { ptyId?: string } } | undefined;
      return use?.output?.ptyId ?? null;
    }, thirdId);
    if (!thirdPtyId) throw new Error("terminal PTY missing");
    await page.evaluate(() => {
      const terminal = window.yaade?.terminal;
      if (!terminal) throw new Error("terminal API missing");
      terminal.getForegroundProcess = async () => "claude";
    });
    await expectSelectorVisible(
      page,
      `[data-yaade-tool-use="${thirdId}"][data-yaade-detected-agent]`,
    );

    await page
      .locator(`[data-yaade-tool-pane-tab="${thirdId}"]`)
      .click({ button: "right" });
    await expectSelectorVisible(
      page,
      `[data-yaade-pane-tab-context="${thirdId}"]`,
    );
    await page.keyboard.press("Escape");

    await page.locator("[data-yaade-pane-new-tool]").click();
    await expectLocatorCount(
      page.locator("[data-yaade-pane-new-tool-kind]"),
      4,
    );
    await expectLocatorCount(
      page.locator('[data-yaade-pane-new-tool-kind="agent"]'),
      0,
    );
    await page.keyboard.press("Escape");

    const leftHoverZone = page.locator(
      '[data-yaade-sidebar-hover-zone="left"]',
    );
    await page.locator("[data-yaade-sidebar-toolbar-toggle]").click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-yaade-shell="tool-session"]')
          ?.getAttribute("data-yaade-sidebars-state") === "collapsed",
    );
    await leftHoverZone.hover();
    await leftHoverZone.getByRole("button", { name: "Show sidebars" }).click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-yaade-shell="tool-session"]')
          ?.getAttribute("data-yaade-sidebars-state") === "expanded",
    );
  } finally {
    await app.app.close();
  }
});
