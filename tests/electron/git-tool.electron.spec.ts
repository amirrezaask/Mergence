import { test } from "@playwright/test";
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

test("Git History is available as a Session tool", async () => {
  const { app, page } = await launchWeb({
    workspaceRel: "fixtures/sample-workspace",
  });
  try {
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

    await openToolSessionShell(page);
    await page.locator('button[title="New Git History"]').click();
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
