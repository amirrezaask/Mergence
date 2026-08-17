import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ShellDriver } from "../shell/driver.js";
import { launchWeb } from "../shell/launch-web.js";
import { expectContainsText } from "../shell/assert.js";
import { expectListRows } from "../helpers/list.js";

async function openToolSessionShell(page: ShellDriver): Promise<void> {
  await page.evaluate(() => {
    history.pushState(null, "", "/");
    window.dispatchEvent(new Event("popstate"));
  });
  await page.waitForSelector('[data-yaade-shell="tool-session"]');
}

async function ensureGitRepository(page: ShellDriver): Promise<string> {
  const projectPath = await page.evaluate(async () => {
    const project = (await window.yaade?.tools?.listProjects?.())?.[0];
    if (!project) throw new Error("No launch project");
    return project.projectPath;
  });
  if (!fs.existsSync(path.join(projectPath, ".git"))) {
    execFileSync("git", ["init", "-q"], { cwd: projectPath });
    execFileSync("git", ["config", "user.email", "e2e@yaade.test"], {
      cwd: projectPath,
    });
    execFileSync("git", ["config", "user.name", "yaade-e2e"], {
      cwd: projectPath,
    });
    fs.writeFileSync(path.join(projectPath, "history-seed.txt"), "seed\n");
    execFileSync("git", ["add", "."], { cwd: projectPath });
    execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: projectPath });
  }
  return projectPath;
}

test("Git History is available as a Session tool", async () => {
  const { app, page } = await launchWeb({
    workspaceRel: "fixtures/sample-workspace",
  });
  try {
    await ensureGitRepository(page);
    await openToolSessionShell(page);
    const existingGit = page
      .locator("[data-yaade-tool-tabs] [data-yaade-tool-use]")
      .filter({ hasText: "Git History" });
    if ((await existingGit.count()) > 0) await existingGit.click();
    else await page.locator('[data-yaade-empty-tool="git"]').click();
    await page.waitForSelector('[data-yaade-list-panel="git-history"]', {
      timeout: 30_000,
    });
    await expectListRows(page, {
      panel: "git-history",
      minItems: 2,
      needle: "seed",
      noResultsText: "No commit history",
    });
    await expectContainsText(
      page,
      '[data-yaade-list-panel="git-history"]',
      "Uncommitted",
    );

  } finally {
    await app.close();
  }
});

test("mobile Git drills from commits to files to an on-demand diff", async () => {
  const { app, page } = await launchWeb({
    workspaceRel: "fixtures/sample-workspace",
  });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await ensureGitRepository(page);
    await openToolSessionShell(page);
    const session = page.locator("[data-yaade-mobile-session-group]").first();
    await session.locator("[data-yaade-mobile-new-tool]").click();
    await page.locator("[data-yaade-mobile-new-tool-kind=git]").click();

    await page.waitForSelector('[data-yaade-git-mobile="true"]', {
      timeout: 30_000,
    });
    await page.waitForSelector('[data-yaade-list-panel="git-history"] [data-yaade-list-item]', {
      timeout: 30_000,
    });
    expect(await page.locator('[data-yaade-list-panel="commit-changes-files"]').count()).toBe(0);
    await test.info().attach("mobile-git-commits", {
      body: Buffer.from(await page.screenshot(), "base64"),
      contentType: "image/png",
    });

    const scrollable = await page.locator('[data-yaade-list-panel="git-history"]').evaluate(element => {
      if (!(element instanceof HTMLElement)) throw new Error("Git history panel is not HTML");
      const panel = element;
      panel.style.flex = "none";
      panel.style.height = "70px";
      panel.scrollTop = 40;
      return {
        overflowY: getComputedStyle(panel).overflowY,
        scrollTop: panel.scrollTop,
        scrollHeight: panel.scrollHeight,
        clientHeight: panel.clientHeight,
        touchAction: getComputedStyle(panel).touchAction,
      };
    });
    expect(scrollable.overflowY).toMatch(/auto|scroll/);
    expect(scrollable.scrollHeight).toBeGreaterThan(scrollable.clientHeight);
    expect(scrollable.scrollTop).toBeGreaterThan(0);
    expect(scrollable.touchAction).toContain("pan-y");

    const commit = page
      .locator('[data-yaade-list-panel="git-history"] [data-yaade-list-item]')
      .filter({ hasText: "seed" })
      .first();
    await commit.click();
    await page.waitForSelector('[data-yaade-list-panel="commit-changes-files"]', {
      timeout: 30_000,
    });
    expect(await page.locator('[data-yaade-git-diff]').count()).toBe(0);
    await test.info().attach("mobile-git-files", {
      body: Buffer.from(await page.screenshot(), "base64"),
      contentType: "image/png",
    });

    const file = page.locator('[data-yaade-pierre-file-tree] [role="treeitem"]').first();
    await file.waitFor({ state: "visible", timeout: 30_000 });
    await file.click();
    await page.waitForSelector('[data-yaade-git-diff]', { timeout: 30_000 });
    await page.waitForSelector('[aria-label="Back to changed files"]', {
      timeout: 30_000,
    });
    await test.info().attach("mobile-git-diff", {
      body: Buffer.from(await page.screenshot(), "base64"),
      contentType: "image/png",
    });

    const layout = await page.evaluate(() => ({
      width: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    }));
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.width);
  } finally {
    await app.close();
  }
});
