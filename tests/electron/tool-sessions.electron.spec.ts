import { expect, test } from "@playwright/test";
import { launchWeb } from "../shell/launch-web.js";
import { pressShellPrefix } from "./_launch.js";

test("Session shell exposes only Terminal and Git tools", async () => {
  const app = await launchWeb();
  try {
    const { page } = app;
    await page.waitForSelector('[data-yaade-shell="tool-session"]');
    await page.evaluate(() => window.__yaadeAgent?.waitForReady());

    await pressShellPrefix(page);
    const hudText = await page.locator("[data-yaade-which-key]").textContent();
    expect(hudText).toContain("New Terminal");
    expect(hudText).toContain("New Git");
    expect(hudText).not.toContain("Search");
    expect(hudText).not.toContain("Neovim");
  } finally {
    await app.app.close();
  }
});
