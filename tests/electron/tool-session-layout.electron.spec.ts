import { expect, test } from "@playwright/test";
import type { ShellDriver } from "../shell/driver.js";
import { launchWeb } from "../shell/launch-web.js";
import {
  expectLocatorAttribute,
  expectLocatorHidden,
  expectLocatorVisible,
  expectSelectorVisible,
} from "../shell/assert.js";
import { pressMod } from "./_launch.js";

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

    await page.locator('[data-yaade-session-layout-option="two-sidebars"]').click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-yaade-shell="tool-session"]')
          ?.getAttribute("data-yaade-session-layout") === "two-sidebars",
      null,
    );
    await expectSelectorVisible(page, "[data-yaade-session-sidebar]");
    await expectSelectorVisible(page, "[data-yaade-tool-sidebar]");
  } finally {
    await app.app.close();
  }
});

test("shows tools above sessions in the single sidebar layout", async () => {
  const app = await launchWeb({});
  try {
    const page = app.page;
    await openToolSessionShell(page);

    await page.locator("[data-yaade-session-settings]").click();
    await expectLocatorVisible(page.locator("[data-yaade-settings-overlay]"));
    await page
      .locator('[data-yaade-session-layout-option="single-sidebar"]')
      .click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-yaade-shell="tool-session"]')
          ?.getAttribute("data-yaade-session-layout") === "single-sidebar",
      null,
    );
    await page.getByRole("button", { name: "Close settings" }).click();

    const shell = page.locator('[data-yaade-shell="tool-session"]');
    const sidebar = page.locator("[data-yaade-single-sidebar]");
    const tools = sidebar.locator("[data-yaade-tool-sidebar]");
    const sessions = sidebar.locator("[data-yaade-session-sidebar]");
    await expectLocatorVisible(sidebar);
    await expectLocatorVisible(tools);
    await expectLocatorVisible(sessions);
    const sidebarBox = await sidebar.boundingBox();
    const toolsBox = await tools.boundingBox();
    const sessionsBox = await sessions.boundingBox();
    const mainBox = await shell.locator("main").boundingBox();
    expect(sidebarBox?.x).toBe(0);
    expect(mainBox?.x).toBe(sidebarBox?.width ?? 0);
    expect(toolsBox?.y).toBe(sidebarBox?.y ?? 0);
    expect(sessionsBox?.y).toBeGreaterThan(toolsBox?.y ?? 0);
    expect(sessionsBox?.y).toBeGreaterThanOrEqual(
      (toolsBox?.y ?? 0) + (toolsBox?.height ?? 0) - 1,
    );
    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = localStorage.getItem("jet-appearance-settings");
          return raw ? JSON.parse(raw).sessionLayout : null;
        }),
      )
      .toBe("single-sidebar");

    await pressMod(page, "KeyB");
    await expectLocatorAttribute(sidebar, "data-yaade-sidebar-state", "collapsed");
    await expectLocatorAttribute(shell, "data-yaade-sidebars-state", "collapsed");
    expect(await shell.locator("main").boundingBox()).toMatchObject({ x: 0 });
    await pressMod(page, "KeyB");
    await expectLocatorAttribute(sidebar, "data-yaade-sidebar-state", "expanded");
  } finally {
    await app.app.close();
  }
});

test("Mod-B collapses and restores both sidebars", async () => {
  const app = await launchWeb({});
  try {
    const page = app.page;
    await openToolSessionShell(page);

    const shell = page.locator('[data-yaade-shell="tool-session"]');
    await expectLocatorAttribute(shell, "data-yaade-sidebars-state", "expanded");

    await pressMod(page, "KeyB");
    await expectLocatorAttribute(shell, "data-yaade-sidebars-state", "collapsed");
    await expectLocatorAttribute(
      page.locator("[data-yaade-session-sidebar]"),
      "data-yaade-sidebar-state",
      "collapsed",
    );
    await expectLocatorAttribute(
      page.locator("[data-yaade-tool-sidebar]"),
      "data-yaade-sidebar-state",
      "collapsed",
    );
    expect(
      await page.locator('[data-yaade-shell="tool-session"] main').boundingBox(),
    ).toMatchObject({ x: 0 });

    await pressMod(page, "KeyB");
    await expectLocatorAttribute(shell, "data-yaade-sidebars-state", "expanded");
    await expectLocatorAttribute(
      page.locator("[data-yaade-session-sidebar]"),
      "data-yaade-sidebar-state",
      "expanded",
    );
    await expectLocatorAttribute(
      page.locator("[data-yaade-tool-sidebar]"),
      "data-yaade-sidebar-state",
      "expanded",
    );
  } finally {
    await app.app.close();
  }
});

test("keeps two-sidebar navigation usable on a narrow viewport", async () => {
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

    await pressMod(page, "KeyB");
    await expectLocatorHidden(page.locator("[data-yaade-session-sidebar]"));
    await expectLocatorHidden(page.locator("[data-yaade-tool-sidebar]"));
  } finally {
    await app.app.close();
  }
});

test("keeps the single sidebar usable on a narrow viewport", async () => {
  const app = await launchWeb({});
  try {
    const page = app.page;
    await page.setViewportSize({ width: 390, height: 844 });
    await openToolSessionShell(page);
    await page.locator("[data-yaade-session-settings]").click();
    await page
      .locator('[data-yaade-session-layout-option="single-sidebar"]')
      .click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-yaade-shell="tool-session"]')
          ?.getAttribute("data-yaade-session-layout") === "single-sidebar",
      null,
    );
    await page.getByRole("button", { name: "Close settings" }).click();

    const sidebar = page.locator("[data-yaade-single-sidebar]");
    const tools = sidebar.locator("[data-yaade-tool-sidebar]");
    const sessions = sidebar.locator("[data-yaade-session-sidebar]");
    const sidebarBox = await sidebar.boundingBox();
    const toolsBox = await tools.boundingBox();
    const sessionsBox = await sessions.boundingBox();
    expect(sidebarBox?.width).toBe(390);
    expect(toolsBox?.width).toBe(390);
    expect(sessionsBox?.width).toBe(390);
    expect(sessionsBox?.y).toBeGreaterThanOrEqual(
      (toolsBox?.y ?? 0) + (toolsBox?.height ?? 0) - 1,
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
  } finally {
    await app.app.close();
  }
});
