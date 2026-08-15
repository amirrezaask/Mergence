import { expect, test } from "@playwright/test";
import path from "node:path";
import { launchWeb } from "../shell/launch-web.js";
import { REPO_ROOT } from "./_launch.js";

const ptyAvailable = process.platform !== "win32";
const probeShell = path.join(
  REPO_ROOT,
  "tests/fixtures/terminal-primary-device-attributes.mjs",
);

test.describe("terminal compatibility", () => {
  test.skip(!ptyAvailable, "node-pty cannot spawn a shell on this machine");

  test("answers a startup Primary Device Attributes query", async () => {
    const app = await launchWeb({ env: { SHELL: probeShell } });
    try {
      const page = app.page;
      await page.evaluate(() => {
        history.pushState(null, "", "/");
        window.dispatchEvent(new Event("popstate"));
      });
      await page.waitForSelector('[data-yaade-shell="tool-session"]');
      await page.evaluate(() => window.__yaadeAgent?.waitForReady());

      const toolUseId = await page.evaluate(async () => {
        const tools = window.yaade?.tools;
        const state = window.__yaadeAgent?.getState();
        const sessionId = state?.activeSessionId;
        if (!tools || !sessionId)
          throw new Error("tools API or session missing");
        const project = (await tools.listProjects())[0];
        if (!project) throw new Error("no project");
        const created = await tools.createUse({
          _tag: "CreateToolUse",
          sessionId,
          kind: "terminal",
          project,
          checkout: { _tag: "MainCheckout", kind: "main" },
          input: { _tag: "TerminalToolInput", kind: "terminal" },
        });
        await window.__yaadeAgent?.selectToolUse?.(created.id);
        return created.id;
      });

      await page.waitForSelector("[data-yaade-terminal-canvas]", {
        timeout: 30_000,
      });
      await expect
        .poll(
          () =>
            page.evaluate(
              (id) => window.__yaadeAgent?.getTerminalText?.(id) ?? "",
              toolUseId,
            ),
          { timeout: 10_000 },
        )
        .toContain("DA1-PROBE-OK");
      await expect
        .poll(
          () =>
            page.evaluate(
              (id) => window.__yaadeAgent?.getTerminalText?.(id) ?? "",
              toolUseId,
            ),
          { timeout: 1_000 },
        )
        .not.toContain("DA1-PROBE-TIMEOUT");
    } finally {
      await app.app.close();
    }
  });
});
