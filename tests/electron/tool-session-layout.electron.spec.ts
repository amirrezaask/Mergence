import { expect, test } from "@playwright/test";
import type { ShellDriver } from "../shell/driver.js";
import { launchWeb } from "../shell/launch-web.js";
import {
  expectLocatorAttribute,
  expectLocatorCount,
  expectLocatorHidden,
  expectLocatorVisible,
  expectSelectorVisible,
} from "../shell/assert.js";
import { pressMuxPrefix } from "./_launch.js";

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

async function expectMainFillsShell(page: ShellDriver): Promise<void> {
  const shellBox = await page
    .locator('[data-yaade-shell="tool-session"]')
    .boundingBox();
  const mainBox = await page
    .locator('[data-yaade-shell="tool-session"] main')
    .boundingBox();
  if (!shellBox || !mainBox) throw new Error("tool shell layout is missing");
  expect(mainBox.x).toBeCloseTo(shellBox.x, 1);
  expect(mainBox.width).toBeCloseTo(shellBox.width, 1);
}

test("switches between the two-sidebar and tab-bar layouts", async () => {
  const app = await launchWeb({});
  try {
    const page = app.page;
    await openToolSessionShell(page);

    await expectSelectorVisible(page, "[data-yaade-session-sidebar]");
    await expectSelectorVisible(page, "[data-yaade-tool-sidebar]");
    await expectLocatorAttribute(
      page.locator('[data-yaade-session-sidebar] [role="tablist"]'),
      "aria-orientation",
      "vertical",
    );
    await expectLocatorAttribute(
      page.locator('[data-yaade-tool-sidebar] [role="tablist"]'),
      "aria-orientation",
      "vertical",
    );
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

    await page
      .locator('[data-yaade-session-layout-option="two-sidebars"]')
      .click();
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

test("resizes both sidebars and the single sidebar", async () => {
  const app = await launchWeb({});
  try {
    const page = app.page;
    await openToolSessionShell(page);

    const sessionSidebar = page.locator("[data-yaade-session-sidebar]");
    const toolSidebar = page.locator("[data-yaade-tool-sidebar]");
    const sessionHandle = page.getByRole("separator", {
      name: "Resize session sidebar",
    });
    const toolHandle = page.getByRole("separator", {
      name: "Resize tool sidebar",
    });
    const initialSessionWidth =
      (await sessionSidebar.boundingBox())?.width ?? 0;
    const initialToolWidth = (await toolSidebar.boundingBox())?.width ?? 0;

    const sessionHandleBox = await sessionHandle.boundingBox();
    if (!sessionHandleBox) throw new Error("session resize handle is missing");
    await page.mouse.move(
      sessionHandleBox.x + sessionHandleBox.width / 2,
      sessionHandleBox.y + sessionHandleBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      sessionHandleBox.x + sessionHandleBox.width / 2 + 32,
      sessionHandleBox.y + sessionHandleBox.height / 2,
      { steps: 4 },
    );
    await page.mouse.up();
    await expect
      .poll(async () => (await sessionSidebar.boundingBox())?.width ?? 0)
      .toBeGreaterThan(initialSessionWidth + 20);
    await expect
      .poll(async () => (await toolSidebar.boundingBox())?.width ?? 0)
      .toBeGreaterThan(initialToolWidth + 20);

    const toolHandleBox = await toolHandle.boundingBox();
    if (!toolHandleBox) throw new Error("tool resize handle is missing");
    await page.mouse.move(
      toolHandleBox.x + toolHandleBox.width / 2,
      toolHandleBox.y + toolHandleBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      toolHandleBox.x + toolHandleBox.width / 2 - 24,
      toolHandleBox.y + toolHandleBox.height / 2,
      { steps: 4 },
    );
    await page.mouse.up();
    await expect
      .poll(async () => (await toolSidebar.boundingBox())?.width ?? 0)
      .toBeGreaterThan(initialToolWidth + 36);

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

    const singleSidebar = page.locator("[data-yaade-single-sidebar]");
    const singleHandle = page.getByRole("separator", {
      name: "Resize sidebar",
    });
    const initialSingleWidth = (await singleSidebar.boundingBox())?.width ?? 0;
    const singleHandleBox = await singleHandle.boundingBox();
    if (!singleHandleBox) throw new Error("single resize handle is missing");
    await page.mouse.move(
      singleHandleBox.x + singleHandleBox.width / 2,
      singleHandleBox.y + singleHandleBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      singleHandleBox.x + singleHandleBox.width / 2 + 24,
      singleHandleBox.y + singleHandleBox.height / 2,
      { steps: 4 },
    );
    await page.mouse.up();
    await expect
      .poll(async () => (await singleSidebar.boundingBox())?.width ?? 0)
      .toBeGreaterThan(initialSingleWidth + 16);
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
    await expectLocatorCount(tools.locator('[data-yaade-new-tool="agent"]'), 0);
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

    await pressMuxPrefix(page, "KeyB");
    await expectLocatorAttribute(
      sidebar,
      "data-yaade-sidebar-state",
      "collapsed",
    );
    await expectLocatorAttribute(
      shell,
      "data-yaade-sidebars-state",
      "collapsed",
    );
    await expectMainFillsShell(page);
    await pressMuxPrefix(page, "KeyB");
    await expectLocatorAttribute(
      sidebar,
      "data-yaade-sidebar-state",
      "expanded",
    );
  } finally {
    await app.app.close();
  }
});

test("Ctrl-a b collapses and restores both sidebars", async () => {
  const app = await launchWeb({});
  try {
    const page = app.page;
    await openToolSessionShell(page);

    const shell = page.locator('[data-yaade-shell="tool-session"]');
    await expectLocatorAttribute(
      shell,
      "data-yaade-sidebars-state",
      "expanded",
    );

    await pressMuxPrefix(page, "KeyB");
    await expectLocatorAttribute(
      shell,
      "data-yaade-sidebars-state",
      "collapsed",
    );
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
    await expectMainFillsShell(page);

    await pressMuxPrefix(page, "KeyB");
    await expectLocatorAttribute(
      shell,
      "data-yaade-sidebars-state",
      "expanded",
    );
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

test("collapse keeps every available tool renderer full width", async () => {
  test.setTimeout(120_000);
  const app = await launchWeb({});
  try {
    const page = app.page;
    await openToolSessionShell(page);

    const providerAvailable = await page.evaluate(async () => {
      const providers = await window.yaade?.agents?.listProviders?.(true);
      return providers?.some((provider) => provider.available) ?? false;
    });
    const kinds = ["terminal", "search", "editor", "git"] as const;
    for (const kind of kinds) {
      await page.evaluate(
        async (nextKind) => window.__yaadeAgent?.createToolUse?.(nextKind),
        kind,
      );
    }
    if (providerAvailable) {
      await page.evaluate(async () =>
        window.__yaadeAgent?.createToolUse?.("agent"),
      );
    }

    const expectedKinds = providerAvailable ? [...kinds, "agent"] : [...kinds];
    for (const kind of expectedKinds) {
      await page.waitForFunction(
        (expectedKind) =>
          (window.__yaadeAgent?.getState().toolUses ?? []).some(
            (use: { kind: string }) => use.kind === expectedKind,
          ),
        kind,
        { timeout: 30_000 },
      );
      const useId = await page.evaluate(
        (expectedKind) =>
          window.__yaadeAgent
            ?.getState()
            .toolUses?.find(
              (use: { kind: string }) => use.kind === expectedKind,
            )?.id,
        kind,
      );
      if (!useId) throw new Error(`${kind} tool was not created`);
      await page.evaluate(
        async (id) => window.__yaadeAgent?.selectToolUse?.(id),
        useId,
      );
      await page.waitForFunction(
        (id) => window.__yaadeAgent?.getState().activeToolUseId === id,
        useId,
      );
      await page.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur();
      });

      await pressMuxPrefix(page, "KeyB");
      await expectLocatorAttribute(
        page.locator('[data-yaade-shell="tool-session"]'),
        "data-yaade-sidebars-state",
        "collapsed",
      );
      await expectMainFillsShell(page);
      await page.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur();
      });
      await pressMuxPrefix(page, "KeyB");
      await expectLocatorAttribute(
        page.locator('[data-yaade-shell="tool-session"]'),
        "data-yaade-sidebars-state",
        "expanded",
      );
    }
  } finally {
    await app.app.close();
  }
});

test("collapsing navigation dismisses sidebar overlays", async () => {
  const app = await launchWeb({});
  try {
    const page = app.page;
    await openToolSessionShell(page);
    await page.locator('[data-yaade-empty-tool="editor"]').click();
    await page.waitForSelector("[data-yaade-editor-tool]", { timeout: 30_000 });

    await page.locator('[data-yaade-tool-use][data-active="true"]').click();
    await expectSelectorVisible(page, "[data-yaade-tool-context-popover]");
    await page.locator("[data-yaade-tool-context-popover] p").first().click();
    await expectSelectorVisible(page, "[data-yaade-tool-context-popover]");
    await pressMuxPrefix(page, "KeyB");
    await expectLocatorAttribute(
      page.locator('[data-yaade-shell="tool-session"]'),
      "data-yaade-sidebars-state",
      "collapsed",
    );
    await expectLocatorHidden(
      page.locator("[data-yaade-tool-context-popover]"),
    );

    await pressMuxPrefix(page, "KeyB");
    await page.locator('[data-yaade-new-tool="agent"]').click();
    await expectSelectorVisible(page, "[data-yaade-agent-provider-menu]");
    await page
      .locator("[data-yaade-agent-provider-menu]")
      .getByText("Choose an agent provider")
      .click();
    await expectSelectorVisible(page, "[data-yaade-agent-provider-menu]");
    await pressMuxPrefix(page, "KeyB");
    await expectLocatorAttribute(
      page.locator('[data-yaade-shell="tool-session"]'),
      "data-yaade-sidebars-state",
      "collapsed",
    );
    await expectLocatorHidden(page.locator("[data-yaade-agent-provider-menu]"));
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
    await expectLocatorAttribute(
      page.locator('[data-yaade-session-sidebar] [role="tablist"]'),
      "aria-orientation",
      "horizontal",
    );
    await expectLocatorAttribute(
      page.locator('[data-yaade-tool-sidebar] [role="tablist"]'),
      "aria-orientation",
      "horizontal",
    );
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

    await pressMuxPrefix(page, "KeyB");
    await expectLocatorHidden(page.locator("[data-yaade-session-sidebar]"));
    await expectLocatorHidden(page.locator("[data-yaade-tool-sidebar]"));
    await expectMainFillsShell(page);
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
    await expectLocatorAttribute(
      tools.locator('[role="tablist"]'),
      "aria-orientation",
      "horizontal",
    );
    await expectLocatorAttribute(
      sessions.locator('[role="tablist"]'),
      "aria-orientation",
      "horizontal",
    );
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
