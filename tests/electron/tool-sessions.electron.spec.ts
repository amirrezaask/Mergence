import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ShellDriver } from "../shell/driver.js";
import { launchWeb } from "../shell/launch-web.js";
import {
  expectContainsText,
  expectLocatorVisible,
  expectNotContainsText,
  expectSelectorVisible,
} from "../shell/assert.js";
import { expectListRows } from "../helpers/list.js";
import { REPO_ROOT, focusTerminal } from "./_launch.js";

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

async function waitForVisibleXterm(page: ShellDriver): Promise<void> {
  await page.waitForFunction(
    () => {
      return [...document.querySelectorAll(".xterm")].some((el) => {
        const root = el.closest(".absolute") as HTMLElement | null;
        if (!root) return true;
        return !root.classList.contains("hidden");
      });
    },
    null,
    { timeout: 30_000 },
  );
}

async function createTerminalToolUse(page: ShellDriver): Promise<void> {
  await page.locator('button[title="New Terminal"]').click();
  await waitForVisibleXterm(page);
  await expectSelectorVisible(page, "#tool-project");
}

async function createSearchToolUse(
  page: ShellDriver,
  query: string,
): Promise<void> {
  await page.locator('button[title="New Search"]').click();
  await page.waitForSelector('[data-yaade-list-panel="project-search"]', {
    timeout: 30_000,
  });
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
      const created = await tools.createUse({
        _tag: "CreateToolUse",
        sessionId,
        ...(nextTitle ? { title: nextTitle } : {}),
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
  await waitForVisibleXterm(page);
  return id;
}

/** 1 */ test("boots a visible Session and empty ToolUse state", async () => {
  const app = await launchWeb({});
  try {
    const page = app.page;
    await openToolSessionShell(page);
    await expectContainsText(
      page,
      '[data-yaade-shell="tool-session"]',
      "Add a tool to start this session",
    );
    await expectSelectorVisible(page, '[role="tablist"] [role="tab"]');
    await expectSelectorVisible(page, 'button[title="New Search"]');
    await expectSelectorVisible(page, 'button[title="New Agent"]');
    await expectSelectorVisible(page, 'button[title="New Terminal"]');
    await page.locator('button[title="New Search"]').click();
    await expectSelectorVisible(page, "#tool-project");
    await expectSelectorVisible(
      page,
      '[data-yaade-list-panel="project-search"]',
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
    await focusTerminal(page);
    const marker = `yaade-tool-pty-${Date.now()}`;
    await page.keyboard.type(`echo ${marker}`);
    await page.keyboard.press("Enter");
    await waitForToolTerminalText(page, marker);
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
    const firstSessionId = await page.evaluate(
      () => window.__yaadeAgent!.getState().activeSessionId,
    );
    expect(firstSessionId).toBeTruthy();
    await page.getByRole("button", { name: "New session" }).click();
    await page.waitForFunction(
      () => (window.__yaadeAgent?.getState().sessions?.length ?? 0) >= 2,
    );
    await page.evaluate(async (id) => {
      await window.__yaadeAgent!.selectSession!(id!);
    }, firstSessionId);
    await waitForVisibleXterm(page);
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
    const provider = await page.evaluate(async () => {
      const list = await window.yaade?.agents?.listProviders?.(true);
      return list?.find((item) => item.available)?.provider ?? null;
    });
    test.skip(!provider, "no agent CLI provider available on this host");
    await page.locator('button[title="New Agent"]').click();
    await page.waitForFunction(
      () =>
        (window.__yaadeAgent?.getState().toolUses ?? []).some(
          (use: { kind: string }) => use.kind === "agent",
        ),
      null,
      { timeout: 30_000 },
    );
    await expectSelectorVisible(page, "#tool-provider");
    const use = await page.evaluate(() =>
      (window.__yaadeAgent!.getState().toolUses ?? []).find(
        (item: { kind: string }) => item.kind === "agent",
      ),
    );
    expect(use).toBeTruthy();
    await waitForVisibleXterm(page);
  } finally {
    await app.app.close();
  }
});

/** 6 */ test("SearchTool renders file cards and opens a Monaco buffer", async () => {
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
    await expectSelectorVisible(
      page,
      '[data-yaade-project-search-file*="src/index.ts"]',
    );
    await page.locator("[data-yaade-project-search-hit]").first().click();
    await expectSelectorVisible(
      page,
      '[data-yaade-search-editor*="/src/index.ts"] [data-yaade-monaco-editor]',
    );
  } finally {
    await app.app.close();
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
    await page.locator('button[title="New Terminal"]').click();
    await waitForVisibleXterm(page);
    await page.locator("#tool-checkout").click();
    await page.getByRole("option", { name: "New isolated branch…" }).click();
    await page.getByLabel("Isolated branch worktree").fill(branch);
    await page.getByLabel("Isolated branch worktree").press("Enter");
    await page.waitForFunction(
      () => {
        const use = (window.__yaadeAgent?.getState().toolUses ?? [])[0] as
          | { context?: { managedWorktree?: boolean } }
          | undefined;
        return use?.context?.managedWorktree === true;
      },
      null,
      { timeout: 30_000 },
    );
    const checkout = await page.evaluate(() => {
      const use = (window.__yaadeAgent!.getState().toolUses ?? [])[0] as
        | {
            context?: {
              checkoutPath?: string;
              checkoutLabel?: string;
              managedWorktree?: boolean;
            };
          }
        | undefined;
      return use?.context;
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

/** 13 */ test("LRU keeps at most six process viewports while host PTYs survive", async () => {
  const app = await launchWeb({});
  try {
    const page = app.page;
    await openToolSessionShell(page);
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      ids.push(await createTerminalViaApi(page, `term-${i}`));
    }
    await page.waitForFunction(
      () =>
        Number(
          document
            .querySelector("[data-yaade-viewport-count]")
            ?.getAttribute("data-yaade-viewport-count") ?? "0",
        ) <= 6,
      null,
      { timeout: 15_000 },
    );
    const viewportCount = await page.evaluate(() =>
      Number(
        document
          .querySelector("[data-yaade-viewport-count]")
          ?.getAttribute("data-yaade-viewport-count") ?? "0",
      ),
    );
    expect(viewportCount).toBeLessThanOrEqual(6);
    const firstId = ids[0]!;
    await page.evaluate(async (id) => {
      await window.__yaadeAgent!.selectToolUse!(id);
    }, firstId);
    await page.waitForSelector(".xterm", { timeout: 30_000 });
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
    await page.locator(".xterm").first().click();
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
    await waitForVisibleXterm(page);
    await page.locator(".absolute.inset-0.flex .xterm, .xterm").first().click();
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

/** 17 */ test("mobile sidebar opens and keeps the selected ToolUse visible", async () => {
  const app = await launchWeb({});
  try {
    const page = app.page;
    await page.setViewportSize({ width: 390, height: 844 });
    await openToolSessionShell(page);
    await createTerminalViaApi(page, "mobile-term");
    await page.getByRole("button", { name: "Open tool sidebar" }).click();
    await expectSelectorVisible(page, '[data-yaade-shell="tool-session"]');
    await expectContainsText(
      page,
      '[data-yaade-shell="tool-session"]',
      "sample-workspace",
    );
    await page
      .getByRole("button", { name: "Close tool sidebar" })
      .first()
      .click();
    await waitForVisibleXterm(page);
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
    await waitForVisibleXterm(page);
    const result = await page.evaluate(async (toolUseId) => {
      const tools = window.yaade?.tools;
      if (!tools) throw new Error("tools API missing");
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
    await expectSelectorVisible(page, "#tool-project");
    await waitForVisibleXterm(page);
  } finally {
    await app.app.close();
  }
});
