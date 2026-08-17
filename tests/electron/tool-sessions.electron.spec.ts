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
import {
  REPO_ROOT,
  focusTerminal,
  pressMuxPrefix,
  pressShellPrefix,
} from "./_launch.js";

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

async function openPaneToolContext(page: ShellDriver): Promise<void> {
  await page.locator("[data-yaade-mux-context-trigger]").click();
  await expectSelectorVisible(page, "[data-yaade-pane-tool-context-popover]");
}

async function waitForVisibleTerminalSurface(page: ShellDriver): Promise<void> {
  await page.waitForFunction(
    () => {
      return [...document.querySelectorAll("[data-yaade-terminal-canvas]")].some((el) => {
        if (!(el instanceof HTMLElement)) return false;
        if (el.clientWidth < 32 || el.clientHeight < 32) return false;
        const host = el.closest("[data-yaade-mux-terminal-host]");
        if (host instanceof HTMLElement) {
          if (host.classList.contains("opacity-0") || host.clientWidth < 32) {
            return false;
          }
        }
        const panel = el.closest("[data-yaade-terminal-panel]");
        if (
          panel instanceof HTMLElement &&
          panel.dataset.yaadeTerminalStatus === "exited"
        ) {
          return false;
        }
        return true;
      });
    },
    null,
    { timeout: 30_000 },
  );
}

async function createTerminalToolUse(page: ShellDriver): Promise<void> {
  await page.locator('[data-yaade-empty-tool="terminal"]').click();
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
  await page.locator('[data-yaade-empty-tool="search"]').click();
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
    await expectLocatorCount(page.locator('[data-yaade-empty-tool="editor"]'), 0);
    await expectSelectorVisible(page, '[data-yaade-empty-tool="git"]');
  } finally {
    await app.app.close();
  }
});

test.skip("Editor tabs preserve dirty state, save, and reconnect the language server", async () => {
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
    await expectSelectorVisible(page, "[data-yaade-browser-editor]");
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
      "[data-yaade-browser-editor] textarea.inputarea",
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

test.skip("Editor references render and the compact Explorer toggles", async () => {
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
    await expectSelectorVisible(page, "[data-yaade-browser-editor]");
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
      .locator("[data-yaade-browser-editor] .view-line")
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
      "[data-yaade-browser-editor] textarea.inputarea",
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
    const referenceRows = `${references} .browser-editor-list-row`;
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

test.skip("Mod-P opens Editor Quick Open before and after a file is open", async () => {
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
      '[data-yaade-editor-tool] [data-yaade-browser-editor]',
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

/** 5 */ test("does not expose AgentTool launchers", async () => {
  const app = await launchWeb({});
  try {
    const page = app.page;
    await openToolSessionShell(page);
    await expectLocatorCount(
      page.locator('[data-yaade-new-tool="agent"]'),
      0,
    );
    await expectLocatorCount(
      page.locator('[data-yaade-empty-tool="agent"]'),
      0,
    );
    await expectLocatorCount(
      page.locator('[data-yaade-pane-new-tool-kind="agent"]'),
      0,
    );
    await expectLocatorCount(
      page.locator('[data-yaade-new-tool-kind="agent"]'),
      0,
    );
    await expectLocatorCount(
      page.getByRole("button", { name: "New Agent" }),
      0,
    );
  } finally {
    await app.app.close();
  }
});

/** 6 */ test("SearchTool renders file cards and reuses a Neovim terminal", async () => {
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
    await page.locator('[data-yaade-project-search-hit="src/index.ts:2"]').click();
    await expectSelectorVisible(page, "[data-yaade-search-neovim]");
    await expectContainsText(
      page,
      "[data-yaade-search-neovim]",
      path.join(project, "src/index.ts"),
    );
    await waitForVisibleTerminalSurface(page);
    await expect
      .poll(() =>
        page
          .locator("[data-yaade-terminal-panel]")
          .getAttribute("data-yaade-terminal-pty-id"),
      )
      .not.toBe("");
    const firstPtyId = await page
      .locator("[data-yaade-terminal-panel]")
      .getAttribute("data-yaade-terminal-pty-id");
    expect(firstPtyId).toBeTruthy();

    await page.getByRole("button", { name: "Search results" }).click();
    await expectSelectorVisible(page, '[data-yaade-list-panel="project-search"]');
    await searchInput.fill("other");
    await expectListRows(page, {
      panel: "project-search",
      minItems: 1,
      needle: "excludedSearchFixture",
    });
    await page.locator('[data-yaade-project-search-hit="src/other.ts:1"]').click();
    await expectSelectorVisible(page, "[data-yaade-search-neovim]");
    await expectContainsText(
      page,
      "[data-yaade-search-neovim]",
      path.join(project, "src/other.ts"),
    );
    await waitForVisibleTerminalSurface(page);
    await expect
      .poll(() =>
        page
          .locator("[data-yaade-terminal-panel]")
          .getAttribute("data-yaade-terminal-pty-id"),
      )
      .toBe(firstPtyId);
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

/** 13 */ test("one ToolUse per pane keeps every process viewport mounted", async () => {
  const app = await launchWeb({});
  try {
    const page = app.page;
    await openToolSessionShell(page);
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      ids.push(await createTerminalViaApi(page, `term-${i}`));
    }
    await expectLocatorCount(page.locator("[data-yaade-tool-pane-tab]"), 0);
    await expectLocatorCount(page.locator("[data-yaade-panel-leaf]"), 6);
    await expectLocatorCount(page.locator("[data-yaade-tool-tile]"), 6);
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

    const fullWindowId = await page.evaluate(
      () => window.__yaadeAgent?.getState().activeTabId,
    );
    await pressMuxPrefix(page, "KeyT");
    await page.waitForFunction(
      id => window.__yaadeAgent?.getState().activeTabId !== id,
      fullWindowId,
      { timeout: 30_000 },
    );
    await expectLocatorCount(page.locator("[data-yaade-session-tab]"), 2);
    await expectLocatorCount(page.locator("[data-yaade-panel-leaf]"), 1);
    await expectLocatorCount(page.locator("[data-yaade-tool-tile]"), 1);
  } finally {
    await app.app.close();
  }
});

test("prefix-launched tools split instead of replacing the focused pane", async () => {
  const app = await launchWeb({});
  try {
    const page = app.page;
    await openToolSessionShell(page);
    await createTerminalViaApi(page, "shortcut-one");
    const firstId = await page.evaluate(
      () => window.__yaadeAgent?.getState().activeToolUseId,
    );
    if (!firstId) throw new Error("first terminal missing");
    await focusTerminal(page);
    await pressMuxPrefix(page, "KeyT");
    await page.waitForFunction(
      id =>
        (window.__yaadeAgent?.getState().toolUses ?? []).filter(
          (use: { archivedAt?: string }) => !use.archivedAt,
        ).length >= 2 &&
        window.__yaadeAgent?.getState().activeToolUseId !== id,
      firstId,
      { timeout: 30_000 },
    );
    await expectLocatorCount(page.locator("[data-yaade-panel-leaf]"), 2);
    await expectLocatorVisible(
      page.locator(`[data-yaade-tool-tile="${firstId}"]`),
    );
    await expectLocatorCount(page.locator("[data-yaade-tool-tile]"), 2);
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

/** 15 */ test("prefix Mod-k c creates a Session; double prefix does not", async () => {
  const app = await launchWeb({});
  try {
    const page = app.page;
    await openToolSessionShell(page);
    await createTerminalToolUse(page);
    const before = await page.evaluate(
      () => window.__yaadeAgent!.getState().sessions?.length ?? 0,
    );
    await page.locator("[data-yaade-terminal-canvas]").first().click();
    await pressMuxPrefix(page, "KeyC");
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
    await pressShellPrefix(page);
    await page.waitForTimeout(50);
    await pressShellPrefix(page);
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

/** 20 */ test("prefix Mod-k shows the tool HUD; s opens Search", async () => {
  const app = await launchWeb({});
  try {
    const page = app.page;
    await openToolSessionShell(page);
    await expectLocatorCount(
      page.locator('[data-yaade-new-tool="agent"]'),
      0,
    );
    await expectLocatorCount(
      page.getByRole("button", { name: "New Agent" }),
      0,
    );
    await page.locator("[data-yaade-session-tabs]").click();
    await pressShellPrefix(page);
    await expectSelectorVisible(page, "[data-yaade-which-key]");
    await expectNotContainsText(page, "[data-yaade-which-key]", "New Agent");
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
    await expectLocatorCount(page.locator('[data-yaade-empty-tool="editor"]'), 0);
    await expectSelectorVisible(page, '[data-yaade-empty-tool="git"]');
    await expectLocatorCount(
      page.locator('[data-yaade-session-empty] [data-slot="empty-title"]'),
      0,
    );
    await expectLocatorCount(
      page.locator('[data-yaade-session-empty] [data-slot="empty-description"]'),
      0,
    );
    await expectNotContainsText(page, "[data-yaade-session-empty]", "Start a tool");
    await page.locator('[data-yaade-empty-tool="terminal"]').click();
    await waitForVisibleTerminalSurface(page);
    const canvas = page.locator("[data-yaade-terminal-canvas]").first();
    const box = await canvas.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(32);
    expect(box?.height ?? 0).toBeGreaterThan(32);
    await expect
      .poll(async () =>
        page.evaluate(() => window.__yaadeAgent?.getTerminalText?.() ?? ""),
      )
      .not.toBe("");
  } finally {
    await app.app.close();
  }
});

/** 22 */ test(
  "pane title bar arrow edits its tool context",
  async () => {
    const homeDir = fs.mkdtempSync(
      path.join(path.dirname(REPO_ROOT), "yaade-e2e-home-"),
    );
    const app = await launchWeb({ homeDir });
    try {
      const page = app.page;
      await openToolSessionShell(page);
      await ensureProjectGitRepo(page);

      await page.locator('[data-yaade-empty-tool="terminal"]').click();
      await waitForVisibleTerminalSurface(page);
      await openPaneToolContext(page);
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
    await createTerminalViaApi(page, "resize-one")

    const firstPane = page.locator("[data-yaade-panel-leaf]").first()
    await expect
      .poll(async () => firstPane.locator("[data-yaade-mux-pane-title]").count())
      .toBe(1)
    await expect
      .poll(async () =>
        firstPane.locator('[data-yaade-mux-pane-chrome] [data-slot="button"]').count(),
      )
      .toBe(4)
    await firstPane.getByRole("button", { name: "Split right" }).click()
    await expect
      .poll(async () => page.locator("[data-yaade-panel-leaf]").count())
      .toBe(2)
    await expect
      .poll(async () => firstPane.locator("[data-yaade-mux-zoom]").count())
      .toBe(0)
    await expect
      .poll(async () => firstPane.locator("[data-yaade-mux-close-pane]").count())
      .toBe(1)

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

    // Layout writes are debounced; reload proves the Window split tree and ratios
    // are host-owned rather than transient React state.
    await page.waitForTimeout(500)
    await page.reload()
    await openToolSessionShell(page)
    await expectLocatorCount(page.locator("[data-yaade-panel-leaf]"), 3)
  } finally {
    await app.app.close()
  }
})

test("pane plus opens the new tool picker", async () => {
  const app = await launchWeb({})
  try {
    const page = app.page
    await openToolSessionShell(page)
    await createTerminalViaApi(page, "pane-plus")

    const firstPane = page.locator("[data-yaade-panel-leaf]").first()
    await firstPane.getByRole("button", { name: "New tool" }).click()
    await expectSelectorVisible(page, "[data-yaade-pane-tool-menu]")
    await expectLocatorCount(
      page.locator("[data-yaade-pane-new-tool-kind]"),
      5,
    )

    await page
      .locator('[data-yaade-pane-new-tool-kind="search"]')
      .click()
    await expect
      .poll(async () => page.locator("[data-yaade-panel-leaf]").count())
      .toBe(2)
  } finally {
    await app.app.close()
  }
})

test("ToolUses render one-per-pane with draggable translucent chrome", async () => {
  const app = await launchWeb({});
  try {
    const page = app.page;
    await openToolSessionShell(page);
    const firstId = await createTerminalViaApi(page, "tile-one");
    const secondId = await createTerminalViaApi(page, "tile-two");

    await expectLocatorCount(page.locator("[data-yaade-panel-leaf]"), 2);
    await expectLocatorCount(page.locator("[data-yaade-tool-tile]"), 2);
    await expectLocatorCount(page.locator("[data-yaade-tool-pane-tab]"), 0);

    const firstTile = page.locator(`[data-yaade-tool-tile="${firstId}"]`);
    const secondTile = page.locator(`[data-yaade-tool-tile="${secondId}"]`);
    const secondChrome = page.locator(
      `[data-yaade-mux-pane-chrome="${secondId}"]`,
    );
    const [firstBox, secondBox, chromeBox] = await Promise.all([
      firstTile.boundingBox(),
      secondTile.boundingBox(),
      secondChrome.boundingBox(),
    ]);
    if (!firstBox || !secondBox || !chromeBox) {
      throw new Error("one-tool pane geometry missing");
    }
    const material = await secondChrome.evaluate(element => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, backdrop: style.backdropFilter };
    });
    expect(material.background).toContain("/");
    expect(material.backdrop).toContain("blur");

    await page.mouse.move(
      chromeBox.x + chromeBox.width * 0.55,
      chromeBox.y + chromeBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(chromeBox.x + chromeBox.width * 0.55 + 12, chromeBox.y, {
      steps: 4,
    });
    await page.mouse.move(
      firstBox.x + firstBox.width / 2,
      firstBox.y + firstBox.height / 2,
      { steps: 20 },
    );
    await page.mouse.up();
    await expectLocatorCount(page.locator("[data-yaade-panel-leaf]"), 2);
    await expectLocatorCount(page.locator("[data-yaade-tool-tile]"), 2);

    const firstChrome = page.locator(
      `[data-yaade-mux-pane-chrome="${firstId}"]`,
    );
    await firstChrome.hover();
    await firstChrome.getByRole("button", { name: "Close pane" }).click();
    await page.waitForFunction(
      id => !(window.__yaadeAgent?.getState().toolUses ?? []).some(
        (use: { id: string }) => use.id === id,
      ),
      firstId,
    );
    await expectLocatorCount(page.locator("[data-yaade-panel-leaf]"), 1);
  } finally {
    await app.app.close();
  }
});

async function clickLocatorPadding(
  page: ShellDriver,
  locator: ReturnType<ShellDriver["locator"]>,
  inset = { x: 4, y: 4 },
): Promise<void> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("clickLocatorPadding: missing geometry");
  await page.mouse.click(box.x + inset.x, box.y + inset.y);
}

test("Window tabs and pane chrome focus from their full hit targets", async () => {
  const app = await launchWeb({});
  try {
    const page = app.page;
    await openToolSessionShell(page);
    const firstTermId = await createTerminalViaApi(page, "hit-target-one");
    const firstTabId = await page.evaluate(
      () => window.__yaadeAgent!.getState().activeTabId,
    );
    if (!firstTabId) throw new Error("first Window missing");

    await page.locator("[data-yaade-new-session-tab]").click();
    await page.waitForFunction(
      id => window.__yaadeAgent?.getState().activeTabId !== id,
      firstTabId,
    );
    const secondTabId = await page.evaluate(
      () => window.__yaadeAgent!.getState().activeTabId,
    );
    if (!secondTabId) throw new Error("second Window missing");
    const secondTermId = await createTerminalViaApi(page, "hit-target-two");

    const firstTab = page.locator(`[data-yaade-session-tab="${firstTabId}"]`);
    const secondTab = page.locator(`[data-yaade-session-tab="${secondTabId}"]`);
    await clickLocatorPadding(page, firstTab, { x: 8, y: 16 });
    await page.waitForFunction(
      id => window.__yaadeAgent?.getState().activeTabId === id,
      firstTabId,
    );
    await expectLocatorVisible(
      page.locator(`[data-yaade-tool-tile="${firstTermId}"][data-focused]`),
    );

    await clickLocatorPadding(page, secondTab, { x: 8, y: 16 });
    await page.waitForFunction(
      id => window.__yaadeAgent?.getState().activeTabId === id,
      secondTabId,
    );
    await page.evaluate(() => history.back());
    await page.waitForFunction(
      id => window.__yaadeAgent?.getState().activeTabId === id,
      firstTabId,
    );
    await page.evaluate(() => history.forward());
    await page.waitForFunction(
      id => window.__yaadeAgent?.getState().activeTabId === id,
      secondTabId,
    );
    const extraTermId = await createTerminalViaApi(page, "hit-target-three");
    await expectLocatorCount(page.locator("[data-yaade-panel-leaf]"), 2);

    const inactiveChrome = page.locator(
      `[data-yaade-mux-pane-chrome="${secondTermId}"]`,
    );
    await clickLocatorPadding(page, inactiveChrome, { x: 80, y: 14 });
    await page.waitForFunction(
      id => window.__yaadeAgent?.getState().activeToolUseId === id,
      secondTermId,
    );
    await expectLocatorVisible(
      page.locator(`[data-yaade-tool-tile="${secondTermId}"][data-focused]`),
    );

    await clickLocatorPadding(
      page,
      page.locator(`[data-yaade-mux-pane-chrome="${extraTermId}"]`),
      { x: 80, y: 14 },
    );
    await page.waitForFunction(
      id => window.__yaadeAgent?.getState().activeToolUseId === id,
      extraTermId,
    );
  } finally {
    await app.app.close();
  }
});
