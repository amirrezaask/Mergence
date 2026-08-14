import { expect, test } from "@playwright/test";
import type { ShellDriver } from "../shell/driver.js";
import { launchWeb } from "../shell/launch-web.js";
import {
  expectLocatorVisible,
  expectSelectorVisible,
} from "../shell/assert.js";

async function openToolSessionShell(page: ShellDriver): Promise<void> {
  await page.evaluate(() => {
    history.pushState(null, "", "/");
    window.dispatchEvent(new Event("popstate"));
  });
  await page.waitForSelector('[data-yaade-shell="tool-session"]');
  await page.waitForFunction(
    () => (window.__yaadeAgent?.getState().sessions?.length ?? 0) >= 1,
    null,
    { timeout: 30_000 },
  );
}

test("switches between the two-sidebar and tab-bar layouts", async () => {
  const app = await launchWeb({});
  try {
    const page = app.page;
    await openToolSessionShell(page);

    await expectSelectorVisible(page, "[data-yaade-session-sidebar]");
    await expectSelectorVisible(page, "[data-yaade-tool-sidebar]");
    await expectSelectorVisible(
      page,
      '[data-yaade-session-sidebar] [role="toolbar"][aria-label="Session actions"]',
    );
    await expectSelectorVisible(
      page,
      '[data-yaade-tool-sidebar] [role="toolbar"][aria-label="New tool"]',
    );
    const sessionBox = await page
      .locator("[data-yaade-session-sidebar]")
      .boundingBox();
    const mainBox = await page
      .locator('[data-yaade-shell="tool-session"] main')
      .boundingBox();
    const toolBox = await page
      .locator("[data-yaade-tool-sidebar]")
      .boundingBox();
    expect(sessionBox?.x).toBe(0);
    expect(mainBox?.x).toBe(sessionBox?.width ?? 0);
    expect(toolBox?.x).toBeGreaterThan(
      (mainBox?.x ?? 0) + (mainBox?.width ?? 0) - 1,
    );

    await page.locator("[data-yaade-session-settings]").click();
    await expectLocatorVisible(page.locator("[data-yaade-settings-overlay]"));
    await page.locator('[data-yaade-session-layout-option="tabs"]').click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-yaade-shell="tool-session"]')
          ?.getAttribute("data-yaade-session-layout") === "tabs",
      null,
    );
    await expectSelectorVisible(page, "[data-yaade-session-tabs]");
    await expectSelectorVisible(page, "[data-yaade-tool-tabs]");
    expect(await page.locator("[data-yaade-session-sidebar]").count()).toBe(0);
    expect(await page.locator("[data-yaade-tool-sidebar]").count()).toBe(0);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = localStorage.getItem("jet-appearance-settings");
          return raw ? JSON.parse(raw).sessionLayout : null;
        }),
      )
      .toBe("tabs");

    await page.locator('[data-yaade-session-layout-option="sidebar"]').click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-yaade-shell="tool-session"]')
          ?.getAttribute("data-yaade-session-layout") === "sidebar",
      null,
    );
    await expectSelectorVisible(page, "[data-yaade-session-sidebar]");
    await expectSelectorVisible(page, "[data-yaade-tool-sidebar]");
  } finally {
    await app.app.close();
  }
});

test("keeps sidebar navigation usable on a narrow viewport", async () => {
  const app = await launchWeb({});
  try {
    const page = app.page;
    await page.setViewportSize({ width: 390, height: 844 });
    await openToolSessionShell(page);
    await expectSelectorVisible(page, "[data-yaade-session-sidebar]");
    await expectSelectorVisible(page, "[data-yaade-tool-sidebar]");
    const sessionBox = await page
      .locator("[data-yaade-session-sidebar]")
      .boundingBox();
    const toolBox = await page
      .locator("[data-yaade-tool-sidebar]")
      .boundingBox();
    expect(sessionBox?.width).toBe(390);
    expect(toolBox?.width).toBe(390);
    expect(toolBox?.y).toBeGreaterThan(sessionBox?.y ?? 0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
  } finally {
    await app.app.close();
  }
});
