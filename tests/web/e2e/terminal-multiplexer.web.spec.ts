import { expect } from "@playwright/test";
import { test } from "../../fixtures/e2e.js";
import { focusTerminal } from "./_launch.js";

test("Session shell exposes only Terminal", async ({ launchApp }) => {
  const { page } = await launchApp();
  await expect(page.locator('[data-yaade-shell="terminal-multiplexer"]')).toBeVisible();
  await expect(page.locator("[data-yaade-terminal-panel]")).toBeVisible();
  await expect(page.locator('[data-yaade-session-empty=""]')).toHaveCount(0);
  const topBar = page.locator("[data-yaade-top-tabbar]");
  await expect(topBar).toBeVisible();
  await expect(topBar.getByRole("button", { name: "Switch terminal" })).toHaveCount(0);
  await expect(topBar.getByRole("button", { name: /Switch session/ })).toBeVisible();
  await expect(topBar.locator('[data-yaade-session-settings=""]')).toBeVisible();
  await expect(topBar.getByRole("button", { name: "Settings" })).toBeVisible();

  await expect(page.locator("[data-yaade-which-key]")).toHaveCount(0);
});

test("responsive layout moves one resident terminal without reattach", async ({ launchApp }) => {
  const { page } = await launchApp({ workspaceRel: "fixtures/sample-workspace" });
  await page.setViewportSize({ width: 900, height: 700 });
  await expect(page.locator("[data-ghostty-terminal-canvas]")).toHaveCount(1, {
    timeout: 30_000,
  });
  const terminalId = await page.evaluate(
    () => window.__yaadeTest?.getState().activeMuxTerminalId ?? null,
  );
  if (!terminalId) throw new Error("active terminal is unavailable");
  let before: Awaited<ReturnType<NonNullable<typeof window.__yaadeTest>["getTerminalLifecycle"]>> = null;
  await expect.poll(async () => {
    before = await page.evaluate(
      id => window.__yaadeTest?.getTerminalLifecycle(id) ?? null,
      terminalId,
    );
    return before;
  }, { timeout: 30_000 }).not.toBeNull();

  await focusTerminal(page);
  const marker = "YAADE_RESIDENT_BREAKPOINT";
  await page.keyboard.type(`printf '${marker}\\n'`);
  await page.keyboard.press("Enter");
  await expect.poll(
    () => page.evaluate(id => window.__yaadeTest?.getTerminalText(id) ?? "", terminalId),
  ).toContain(marker);

  for (const width of [760, 820, 760, 900]) {
    await page.setViewportSize({ width, height: 700 });
    await expect(page.locator("[data-ghostty-terminal-canvas]")).toHaveCount(1);
    if (width < 768) {
      await expect(page.locator("[data-yaade-mobile-layout-host]")).toBeVisible();
      await expect(page.locator(`[data-yaade-terminal-placement="${terminalId}"]`)).toBeVisible();
    } else {
      await expect(page.locator("[data-yaade-desktop-layout-host]")).toBeVisible();
    }
  }

  const after = await page.evaluate(
    id => window.__yaadeTest?.getTerminalLifecycle(id) ?? null,
    terminalId,
  );
  expect(after?.surfaceInstanceId).toBe(before?.surfaceInstanceId);
  expect(after?.runtimeGeneration).toBe(before?.runtimeGeneration);
  expect(after?.rendererGeneration).toBe(before?.rendererGeneration);
  expect(after?.attachCount).toBe(before?.attachCount);
  expect(after?.rendererRecoveries).toBe(before?.rendererRecoveries);
  await expect.poll(
    () => page.evaluate(id => window.__yaadeTest?.getTerminalText(id) ?? "", terminalId),
  ).toContain(marker);
});

test("session switcher creates and archives a session", async ({ launchApp }) => {
  const { page } = await launchApp({
    workspaceRel: "fixtures/sample-workspace",
  });
  const switcher = page.getByRole("button", { name: /Switch session/ });
  await expect(page.locator("[data-yaade-terminal-tile]")).toHaveCount(1, {
    timeout: 30_000,
  });

  await switcher.click();
  const popover = page.locator('[data-yaade-session-switcher-popover=""]');
  await expect(popover).toBeVisible();
  const newSessionButton = popover.locator('[data-yaade-new-session=""]');
  await expect(newSessionButton).toBeVisible();
  await newSessionButton.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Switch session, current New session" }),
  ).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: /Switch session/ }).click();
  await expect(popover).toHaveAttribute("data-yaade-glass-material", "floating");
  const renameButton = popover.getByRole("button", { name: "Rename New session" });
  await renameButton.focus();
  await page.keyboard.press("Enter");
  const renameInput = popover.getByRole("textbox", { name: "Rename New session" });
  await renameInput.fill("API work");
  await renameInput.press("Enter");
  await expect(
    page.getByRole("button", { name: "Switch session, current API work" }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(popover.getByRole("option", { name: "API work" })).toBeVisible();

  await popover.getByRole("button", { name: "Close API work" }).click();
  await expect(page.getByRole("dialog", { name: "Close session?" })).toBeVisible();
  await page.getByRole("button", { name: "Stop terminals and archive" }).click();
  await expect(page.getByRole("button", { name: "Switch session, current Session 1" })).toBeVisible(
    { timeout: 30_000 },
  );
});

test("two browser clients can both write to the same terminal", async ({ launchApp, browser }) => {
  const launched = await launchApp({
    workspaceRel: "fixtures/sample-workspace",
  });
  if (!launched.baseUrl) throw new Error("host URL is unavailable");
  await expect(
    launched.page.locator("[data-yaade-terminal-panel] [data-ghostty-terminal-canvas]"),
  ).toBeVisible({ timeout: 30_000 });

  const secondContext = await browser.newContext();
  const secondPage = await secondContext.newPage();
  const secondErrors: string[] = [];
  secondPage.on("pageerror", (error) => secondErrors.push(error.message));
  secondPage.on("console", (message) => {
    if (message.type() === "error") secondErrors.push(message.text());
  });

  try {
    await secondPage.goto(launched.baseUrl, { waitUntil: "domcontentloaded" });
    await secondPage.waitForFunction(() => window.__yaadeTest != null);
    await secondPage.evaluate(() => window.__yaadeTest!.waitForReady());
    await expect(
      secondPage.locator("[data-yaade-terminal-panel] [data-ghostty-terminal-canvas]"),
    ).toBeVisible({ timeout: 30_000 });

    const terminalIds = async () =>
      Promise.all([
        launched.page.evaluate(() => window.__yaadeTest?.getState().activeMuxTerminalId ?? null),
        secondPage.evaluate(() => window.__yaadeTest?.getState().activeMuxTerminalId ?? null),
      ]);
    await expect
      .poll(terminalIds, { timeout: 15_000 })
      .toEqual([expect.any(String), expect.any(String)]);
    const [firstTerminalId, secondTerminalId] = await terminalIds();
    expect(secondTerminalId).toBe(firstTerminalId);
    if (!firstTerminalId) throw new Error("shared terminal is unavailable");

    const terminalText = (page: typeof launched.page) =>
      page.evaluate((id) => window.__yaadeTest?.getTerminalText?.(id) ?? "", firstTerminalId);
    const firstMarker = "YAADE_FIRST_CLIENT_WROTE";
    const secondMarker = "YAADE_SECOND_CLIENT_WROTE";

    await focusTerminal(launched.page);
    await launched.page.keyboard.type(`printf '${firstMarker}\\n'`);
    await launched.page.keyboard.press("Enter");
    await expect
      .poll(() => terminalText(launched.page), { timeout: 15_000 })
      .toContain(firstMarker);
    await expect.poll(() => terminalText(secondPage), { timeout: 15_000 }).toContain(firstMarker);

    await focusTerminal(secondPage);
    await secondPage.keyboard.type(`printf '${secondMarker}\\n'`);
    await secondPage.keyboard.press("Enter");
    await expect
      .poll(() => terminalText(launched.page), { timeout: 15_000 })
      .toContain(secondMarker);
    await expect.poll(() => terminalText(secondPage), { timeout: 15_000 }).toContain(secondMarker);
    expect(secondErrors).toEqual([]);
  } finally {
    await secondContext.close();
  }
});

test("two clients keep independent Window navigation", async ({
  launchApp,
  browser,
}) => {
  const launched = await launchApp({
    workspaceRel: "fixtures/sample-workspace",
  })
  if (!launched.baseUrl) throw new Error("host URL is unavailable")
  const tabs = launched.page.locator(
    "[data-yaade-window-tabs] [data-yaade-session-tab]",
  )
  await launched.page.getByRole("button", { name: "New tab" }).click()
  await expect(tabs).toHaveCount(2)
  await expect
    .poll(() =>
      launched.page.evaluate(
        () => window.__yaadeTest?.getState().muxTerminals.length ?? 0,
      ),
    )
    .toBe(2)

  const secondContext = await browser.newContext()
  const secondPage = await secondContext.newPage()
  try {
    await secondPage.goto(launched.baseUrl, { waitUntil: "domcontentloaded" })
    await secondPage.waitForFunction(() => window.__yaadeTest != null)
    await secondPage.evaluate(() => window.__yaadeTest!.waitForReady())

    const initial = await launched.page.evaluate(() => {
      const state = window.__yaadeTest?.getState()
      return {
        sessionId: state?.activeSessionId ?? null,
        revision: state?.sessions[0]?.revision ?? 0,
        tabIds: state?.tabs.map(tab => tab.id) ?? [],
      }
    })
    const [firstTabId, secondTabId] = initial.tabIds
    if (!initial.sessionId || !firstTabId || !secondTabId) {
      throw new Error("two Window ids are required")
    }
    await tabs.nth(0).getByRole("tab").click()
    await expect
      .poll(() =>
        launched.page.evaluate(
          () => window.__yaadeTest?.getState().activeTabId ?? null,
        ),
      )
      .toBe(firstTabId)

    await secondPage.evaluate(
      async ({ sessionId, tabId }) => {
        if (!window.yaade?.mux) throw new Error("mux API is unavailable")
        await window.yaade.mux.selectTab({
          _tag: "SelectSessionTab",
          sessionId,
          tabId,
        })
      },
      { sessionId: initial.sessionId, tabId: secondTabId },
    )
    await expect
      .poll(() =>
        launched.page.evaluate(
          ({ expectedTabId, previousRevision }) => {
            const state = window.__yaadeTest?.getState()
            return (
              state?.activeTabId === expectedTabId &&
              (state.sessions[0]?.revision ?? 0) > previousRevision
            )
          },
          {
            expectedTabId: firstTabId,
            previousRevision: initial.revision,
          },
        ),
      )
      .toBe(true)
  } finally {
    await secondContext.close()
  }
})

test("terminal output is replayed after a browser reload", async ({ launchApp }) => {
  const { page } = await launchApp({
    workspaceRel: "fixtures/sample-workspace",
  });
  const marker = "YAADE_DURABLE_REPLAY";

  await focusTerminal(page);
  await page.keyboard.type(`printf '${marker}\\n'`);
  await page.keyboard.press("Enter");

  const terminalText = () =>
    page.evaluate(() => {
      const id = window.__yaadeTest?.getState().activeMuxTerminalId;
      return id ? (window.__yaadeTest?.getTerminalText?.(id) ?? "") : "";
    });
  await expect.poll(terminalText, { timeout: 15_000 }).toContain(marker);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator('[data-yaade-shell="terminal-multiplexer"]')).toBeVisible();
  await page.evaluate(() => window.__yaadeTest!.waitForReady());
  await expect(page.locator("[data-yaade-terminal-panel]")).toBeVisible();
  await expect.poll(terminalText, { timeout: 15_000 }).toContain(marker);
});

test("Windows and pane state survive a browser reload", async ({ launchApp }) => {
  const { page } = await launchApp({
    workspaceRel: "fixtures/sample-workspace",
  });
  const windowTabs = page.locator("[data-yaade-window-tabs] [data-yaade-session-tab]");

  await expect(windowTabs).toHaveCount(1);
  await page.getByRole("button", { name: "New tab" }).click();
  await expect(windowTabs).toHaveCount(2);
  await expect(page.locator("[data-yaade-terminal-tile]")).toHaveCount(1, {
    timeout: 30_000,
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator('[data-yaade-shell="terminal-multiplexer"]')).toBeVisible();
  await page.evaluate(() => window.__yaadeTest!.waitForReady());
  await expect(windowTabs).toHaveCount(2);
  await expect(page.locator("[data-yaade-terminal-tile]")).toHaveCount(1, {
    timeout: 30_000,
  });
});

test("switching Windows reconstructs each shell before releasing live output", async ({
  launchApp,
}) => {
  const { page } = await launchApp({
    workspaceRel: "fixtures/sample-workspace",
  });
  const activeTerminal = () =>
    page.evaluate(() => {
      const state = window.__yaadeTest?.getState();
      const id = state?.activeMuxTerminalId;
      const terminal = state?.muxTerminals.find((candidate) => candidate.id === id);
      return {
        id: id ?? null,
        tabId: state?.activeTabId ?? null,
        ptyId: terminal?.output.kind === "process" ? (terminal.output.ptyId ?? null) : null,
        text: id ? (window.__yaadeTest?.getTerminalText?.(id) ?? "") : "",
      };
    });

  await focusTerminal(page);
  await page.keyboard.type("printf 'FIRST_WINDOW_MARKER\\n'");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await activeTerminal()).text).toContain("FIRST_WINDOW_MARKER");
  const first = await activeTerminal();
  expect(first.id).not.toBeNull();
  expect(first.ptyId).not.toBeNull();
  const windowTabs = page.locator("[data-yaade-window-tabs] [data-yaade-session-tab]");
  await page.getByRole("button", { name: "New tab" }).click();
  await expect(windowTabs).toHaveCount(2);

  // A later terminal-create response must not steal focus from this newer
  // navigation intent.
  await windowTabs.nth(0).getByRole("tab").click();
  await expect.poll(async () => (await activeTerminal()).tabId).toBe(first.tabId);
  await expect
    .poll(() => page.evaluate(() => window.__yaadeTest?.getState().muxTerminals.length ?? 0), {
      timeout: 30_000,
    })
    .toBe(2);
  await expect.poll(async () => (await activeTerminal()).id).toBe(first.id);
  await windowTabs.nth(1).getByRole("tab").click();
  await expect(page.locator("[data-yaade-terminal-panel]")).toBeVisible({
    timeout: 30_000,
  });
  await focusTerminal(page);
  await page.keyboard.type("printf 'SECOND_WINDOW_MARKER\\n'");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await activeTerminal()).text).toContain("SECOND_WINDOW_MARKER");
  const second = await activeTerminal();
  expect(second.id).not.toBe(first.id);

  await page.evaluate(async (ptyId) => {
    if (!ptyId || !window.yaade?.terminal) {
      throw new Error("first PTY is unavailable");
    }
    await window.yaade.terminal.write(ptyId, "printf 'FIRST_WINDOW_HIDDEN_OUTPUT\\n'\\n");
  }, first.ptyId);

  await windowTabs.nth(0).getByRole("tab").click();
  await expect
    .poll(async () => (await activeTerminal()).text, {
      timeout: 15_000,
    })
    .toContain("FIRST_WINDOW_HIDDEN_OUTPUT");
  const restoredFirst = await activeTerminal();
  expect(restoredFirst.id).toBe(first.id);
  expect(restoredFirst.ptyId).toBe(first.ptyId);
  await expect(
    page.locator("[data-yaade-terminal-panel] [data-ghostty-terminal-canvas]"),
  ).toBeVisible();

  await windowTabs.nth(1).getByRole("tab").click();
  await expect
    .poll(async () => (await activeTerminal()).text, {
      timeout: 15_000,
    })
    .toContain("SECOND_WINDOW_MARKER");
});

test("closing a new Window during automatic terminal creation stays quiet", async ({
  launchApp,
}) => {
  const { page } = await launchApp({
    workspaceRel: "fixtures/sample-workspace",
    // The intentionally delayed create races tab archival; the host rejects
    // that stale command while the UI must treat it as an expected close.
    expectedHttpErrors: [{ method: "POST", path: "/api/v1/rpc", status: 400 }],
  });
  await expect(page.locator("[data-yaade-terminal-panel]")).toBeVisible();

  await page.evaluate(() => {
    const terminals = window.yaade?.mux;
    if (!terminals?.createTerminal) throw new Error("terminal API is not ready");
    const createTerminal = terminals.createTerminal;
    terminals.createTerminal = async (command) => {
      const released = new Promise<void>((resolve) => {
        window.addEventListener("yaade:test-release-create", () => resolve(), {
          once: true,
        });
      });
      document.documentElement.dataset.yaadeTestCreateState = "started";
      await released;
      try {
        return await createTerminal(command);
      } finally {
        document.documentElement.dataset.yaadeTestCreateState = "settled";
      }
    };
  });

  const windowTabs = page.locator("[data-yaade-window-tabs] [data-yaade-session-tab]");
  await expect(windowTabs).toHaveCount(1);
  await page.getByRole("button", { name: "New tab" }).click();
  await expect(windowTabs).toHaveCount(2);
  await expect
    .poll(() => page.locator("html").getAttribute("data-yaade-test-create-state"))
    .toBe("started");
  const secondWindow = windowTabs.filter({ hasText: "Window 2" });
  await secondWindow.getByRole("button", { name: "Close Window 2" }).click();
  await expect(windowTabs).toHaveCount(1);
  await page.evaluate(() => window.dispatchEvent(new Event("yaade:test-release-create")));
  await expect
    .poll(() => page.locator("html").getAttribute("data-yaade-test-create-state"))
    .toBe("settled");
  await expect(page.getByRole("alert").filter({ hasText: "Action failed" })).toHaveCount(0);
});

test("mobile Terminal exposes accessory keys and keeps its surface mounted", async ({
  launchApp,
}) => {
  const { page } = await launchApp({
    workspaceRel: "fixtures/sample-workspace",
    mobile: true,
  });
  await expect(
    page.locator(
      '[data-yaade-terminal-panel][data-yaade-terminal-status="running"]',
    ),
  ).toHaveCount(1, { timeout: 30_000 });
  await page.evaluate(() => {
    localStorage.removeItem("yaade:last-terminal-multiplexer-route");
    history.pushState(null, "", "/");
    window.dispatchEvent(new Event("popstate"));
  });
  const session = page.locator("[data-yaade-mobile-session-group]").first();
  await expect(session).toBeVisible();
  await expect(session.getByRole("button", { name: /Session actions for/ })).toBeVisible();

  await session.locator("[data-yaade-mobile-new-terminal]").first().click();
  await page.locator('[data-yaade-mobile-new-terminal-kind="terminal"]').click();
  await expect(page.locator('[data-yaade-mobile-terminal-detail=""]')).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page.locator("[data-yaade-mobile-terminal-detail] [data-yaade-terminal-placement]"),
  ).toHaveCount(1, { timeout: 30_000 });
  await expect(
    page.locator('[data-yaade-mobile-retained-terminal][data-active="true"]'),
  ).toHaveCount(0);

  const keys = page.locator("[data-yaade-mobile-terminal-keys]");
  await expect(keys).toBeVisible();
  const ctrl = keys.getByRole("button", { name: "Ctrl", exact: true });
  await ctrl.click();
  await expect(ctrl).toHaveAttribute("aria-pressed", "true");
  await keys.getByRole("button", { name: "Arrow left", exact: true }).click();
  await expect(ctrl).toHaveAttribute("aria-pressed", "false");

  await page.getByRole("button", { name: "Back to terminals" }).click();
  await expect(
    page.locator('[data-yaade-mobile-shell][data-yaade-mobile-view="terminals"]'),
  ).toBeVisible();
  await expect(
    page.locator(`[data-yaade-mobile-terminal][data-terminal-kind="terminal"]`),
  ).toHaveCount(2);
});

test("split shortcuts split the focused pane in both directions", async ({ launchApp }) => {
  const { page } = await launchApp({
    workspaceRel: "fixtures/sample-workspace",
  });
  await expect(page.locator("[data-yaade-terminal-panel]")).toBeVisible();
  await expect(page.locator("[data-yaade-terminal-tile]")).toHaveCount(1, {
    timeout: 30_000,
  });

  await expect(page.locator('[data-yaade-mux-split="right"]').first()).toHaveAttribute(
    "aria-label",
    "Split right",
  );
  await expect(page.locator('[data-yaade-mux-split="down"]').first()).toHaveAttribute(
    "aria-label",
    "Split down",
  );

  await focusTerminal(page);
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${modifier}+d`);
  await expect(page.locator("[data-yaade-mux-pane-chrome]")).toHaveCount(2);

  await page.keyboard.press(`${modifier}+Shift+d`);
  await expect(page.locator("[data-yaade-mux-pane-chrome]")).toHaveCount(3);
});

test("dragging a pane tab to a dock target retiles both terminals", async ({ launchApp }) => {
  const { page } = await launchApp({
    workspaceRel: "fixtures/sample-workspace",
  });
  await expect(page.locator("[data-yaade-terminal-tile]")).toHaveCount(1, {
    timeout: 30_000,
  });

  await focusTerminal(page);
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${modifier}+d`);

  const panes = page.locator("[data-yaade-panel-leaf]");
  await expect(panes).toHaveCount(2, { timeout: 30_000 });
  await expect(page.locator("[data-yaade-terminal-tile]")).toHaveCount(2, {
    timeout: 30_000,
  });
  const source = panes.nth(1).locator("[data-yaade-mux-pane-title]");
  const sourceBox = await source.boundingBox();
  if (!sourceBox) throw new Error("pane tab has no bounds");

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    sourceBox.x + sourceBox.width / 2 + 24,
    sourceBox.y + sourceBox.height / 2 + 24,
    { steps: 4 },
  );

  const targetPane = panes.nth(0);
  const bottomTarget = targetPane.locator('[data-drop-site="bottom"]');
  await expect(bottomTarget).toBeVisible();
  const targetBox = await bottomTarget.boundingBox();
  if (!targetBox) throw new Error("bottom dock target has no bounds");
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, {
    steps: 10,
  });

  const dragGhost = page.locator("[data-yaade-tab-drag-ghost]");
  await expect(dragGhost).toBeVisible();
  await expect(bottomTarget).toHaveAttribute("data-yaade-drop-hot", "");
  await expect(targetPane.locator("[data-yaade-dock-preview]")).toBeVisible();
  await expect
    .poll(async () => (await dragGhost.boundingBox())?.width ?? Number.POSITIVE_INFINITY)
    .toBeLessThan(320);
  await expect
    .poll(async () => {
      const paneBox = await targetPane.boundingBox();
      const previewBox = await targetPane.locator("[data-yaade-dock-preview]").boundingBox();
      if (!paneBox || !previewBox) return false;
      return (
        previewBox.y >= paneBox.y + paneBox.height * 0.45 &&
        previewBox.width >= paneBox.width * 0.95 &&
        previewBox.height >= paneBox.height * 0.45 &&
        previewBox.height <= paneBox.height * 0.55
      );
    })
    .toBe(true);

  await page.mouse.up();
  await expect(dragGhost).toHaveCount(0);
  await expect(page.locator("[data-drop-site]")).toHaveCount(0);
  await expect(page.locator("[data-yaade-terminal-tile]")).toHaveCount(2);
  await expect
    .poll(async () => {
      const boxes = await panes.evaluateAll((elements) =>
        elements.map((element) => {
          const rect = element.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }),
      );
      const [first, second] = boxes;
      if (!first || !second) return false;
      return (
        Math.abs(first.x - second.x) < 2 &&
        Math.abs(first.width - second.width) < 2 &&
        Math.abs(first.height - second.height) < 2 &&
        Math.abs(first.y - second.y) > first.height * 0.9
      );
    })
    .toBe(true);
});

test("dragging a Window tab into the workspace docks its focused terminal", async ({
  launchApp,
}) => {
  const { page } = await launchApp({
    workspaceRel: "fixtures/sample-workspace",
  });
  await expect(page.locator("[data-yaade-terminal-tile]")).toHaveCount(1, {
    timeout: 30_000,
  });

  const first = await page.evaluate(() => {
    const state = window.__yaadeTest?.getState();
    return {
      tabId: state?.activeTabId ?? null,
      terminalId: state?.activeMuxTerminalId ?? null,
    };
  });
  if (!first.tabId || !first.terminalId) throw new Error("first Window is unavailable");

  const windowTabs = page.locator("[data-yaade-window-tabs] [data-yaade-session-tab]");
  await page.getByRole("button", { name: "New tab" }).click();
  await expect(windowTabs).toHaveCount(2);
  await expect
    .poll(() => page.evaluate(() => window.__yaadeTest?.getState().muxTerminals.length ?? 0), {
      timeout: 30_000,
    })
    .toBe(2);
  const targetTabId = await page.evaluate(() => window.__yaadeTest?.getState().activeTabId ?? null);
  if (!targetTabId || targetTabId === first.tabId) {
    throw new Error("target Window was not selected");
  }

  const sourceTab = page.locator(`[data-yaade-session-tab="${first.tabId}"]`);
  const sourceButton = sourceTab.getByRole("tab");
  const targetButton = page.locator(`[data-yaade-session-tab="${targetTabId}"]`).getByRole("tab");
  await expect(sourceButton).toHaveAttribute("data-yaade-window-tab-dockable", "");

  const reorderSourceBox = await sourceButton.boundingBox();
  const reorderTargetBox = await targetButton.boundingBox();
  if (!reorderSourceBox || !reorderTargetBox) throw new Error("Window tabs have no bounds");
  await page.mouse.move(
    reorderSourceBox.x + reorderSourceBox.width / 2,
    reorderSourceBox.y + reorderSourceBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    reorderTargetBox.x + reorderTargetBox.width / 2,
    reorderTargetBox.y + reorderTargetBox.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect(page.locator("[data-yaade-tab-drag-ghost]")).toHaveCount(0);
  await expect
    .poll(() =>
      windowTabs.evaluateAll((tabs) =>
        tabs.map((tab) => tab.getAttribute("data-yaade-session-tab")),
      ),
    )
    .toEqual([targetTabId, first.tabId]);

  const sourceBox = await sourceButton.boundingBox();
  if (!sourceBox) throw new Error("Window tab has no bounds");
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height + 28, {
    steps: 5,
  });

  const targetPane = page.locator("[data-yaade-panel-leaf]").first();
  const bottomTarget = targetPane.locator('[data-drop-site="bottom"]');
  await expect(bottomTarget).toBeVisible();
  await expect(page.locator("[data-yaade-tab-drag-ghost]")).toContainText("Window 1");
  const targetBox = await bottomTarget.boundingBox();
  if (!targetBox) throw new Error("bottom dock target has no bounds");
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, {
    steps: 10,
  });
  await expect(bottomTarget).toHaveAttribute("data-yaade-drop-hot", "");
  await expect(targetPane.locator("[data-yaade-dock-preview]")).toBeVisible();

  await page.mouse.up();
  await expect(page.locator("[data-yaade-tab-drag-ghost]")).toHaveCount(0);
  await expect(windowTabs).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator("[data-yaade-terminal-tile]")).toHaveCount(2, {
    timeout: 30_000,
  });
  await expect
    .poll(() =>
      page.evaluate(
        ({ terminalId, tabId }) => {
          const state = window.__yaadeTest?.getState();
          const terminal = state?.muxTerminals.find((candidate) => candidate.id === terminalId);
          return {
            activeTerminalId: state?.activeMuxTerminalId ?? null,
            movedTabId: terminal?.tabId ?? null,
            visibleTabIds: state?.tabs.map((tab) => tab.id) ?? [],
            layoutJson: state?.tabs.find((tab) => tab.id === tabId)?.layoutJson ?? "",
          };
        },
        { terminalId: first.terminalId, tabId: targetTabId },
      ),
    )
    .toEqual({
      activeTerminalId: first.terminalId,
      movedTabId: targetTabId,
      visibleTabIds: [targetTabId],
      layoutJson: expect.stringContaining(first.terminalId),
    });

  const marker = "WINDOW_TAB_DOCK_SURVIVED";
  await page
    .locator(`[data-yaade-terminal-tile="${first.terminalId}"] .yaade-terminal-surface`)
    .click();
  await page.evaluate(() => window.__yaadeTest?.focusTerminal?.());
  await page.keyboard.type(`printf '${marker}\\n'`);
  await page.keyboard.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(
        (terminalId) => window.__yaadeTest?.getTerminalText?.(terminalId) ?? "",
        first.terminalId,
      ),
    )
    .toContain(marker);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.evaluate(() => window.__yaadeTest!.waitForReady());
  await expect(page.locator("[data-yaade-terminal-tile]")).toHaveCount(2, {
    timeout: 30_000,
  });
  await expect
    .poll(() =>
      page.evaluate(
        (terminalId) => window.__yaadeTest?.getTerminalText?.(terminalId) ?? "",
        first.terminalId,
      ),
    )
    .toContain(marker);
});

test("split controls open Terminal by default and the picker with a modifier", async ({
  launchApp,
}) => {
  const { page } = await launchApp({
    workspaceRel: "fixtures/sample-workspace",
  });
  await expect(page.locator('[data-yaade-shell="terminal-multiplexer"]')).toBeVisible();

  await expect(page.locator("[data-yaade-terminal-panel]")).toBeVisible();
  await expect(page.locator("[data-yaade-terminal-tile]")).toHaveCount(1, {
    timeout: 30_000,
  });

  const paneChrome = page.locator("[data-yaade-mux-pane-chrome]").first();
  await expect(paneChrome.locator('[data-yaade-mux-split="right"]')).toBeVisible();
  await expect(paneChrome.locator('[data-yaade-mux-split="down"]')).toBeVisible();
  await expect(paneChrome.locator('[data-yaade-mux-close-pane=""]')).toBeVisible();

  await paneChrome.locator('[data-yaade-mux-split="right"]').click({ force: true });
  await expect(page.locator("[data-yaade-terminal-tile]")).toHaveCount(2, {
    timeout: 30_000,
  });
  await expect(page.locator("[data-yaade-empty-terminal-tile]")).toHaveCount(0);
  await expect(page.locator("[data-yaade-pane-terminal-menu]")).toBeHidden();

  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await paneChrome.locator('[data-yaade-mux-split="down"]').click({
    force: true,
    modifiers: [modifier],
  });
  const picker = page.locator("[data-yaade-pane-terminal-menu]");
  await expect(picker).toBeVisible();
  await expect(picker).not.toContainText("New terminal");

  await picker.locator('[data-yaade-pane-new-terminal-kind="terminal"]').click({ force: true });
  await expect(page.locator("[data-yaade-terminal-tile]")).toHaveCount(3, {
    timeout: 30_000,
  });
  await expect(page.locator("[data-yaade-empty-terminal-tile]")).toHaveCount(0);
  await expect(page.locator('[data-yaade-mux-zoom=""]').first()).toBeVisible();
  await expect(page.locator('[data-yaade-mux-close-pane=""]').first()).toBeVisible();
  await expect(page.locator('[data-yaade-mux-split="right"]').first()).toBeVisible();
  await expect(page.locator('[data-yaade-mux-split="down"]').first()).toBeVisible();
});

test("closing Settings returns keyboard focus to the terminal", async ({ launchApp }) => {
  const { page } = await launchApp({
    workspaceRel: "fixtures/sample-workspace",
  });
  await expect(page.locator("[data-yaade-terminal-panel]")).toBeVisible();
  await focusTerminal(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(document.activeElement?.closest("[data-ghostty-terminal-input]")),
      ),
    )
    .toBe(true);
});
