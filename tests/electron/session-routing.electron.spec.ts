import { expect, test } from "@playwright/test"
import {
  launchJet,
  waitForMux,
  waitForProjectPage,
} from "./_launch.js"

async function locationHref(page: {
  evaluate: <R>(fn: () => R | Promise<R>) => Promise<R>
}): Promise<string> {
  return page.evaluate(() => location.href)
}

test.describe("session routing", () => {
  test("a canonical workspace opens Running and resumes after visiting Git", async () => {
    const { app, page } = await launchJet({ projectPage: true })
    try {
      await waitForProjectPage(page)
      const createdSessionId = await page.evaluate(async () => {
        const created = await window.__yaadeAgent!.createProjectSession?.({
          title: "Main session",
        })
        return created?.id ?? null
      })
      expect(createdSessionId).toMatch(/^ses-/)
      await page.locator("[data-yaade-mux]").waitFor({
        state: "visible",
        timeout: 30_000,
      })
      await waitForMux(page)

      // Project chrome stays; no Workspace tab; mux is in-page.
      await expect
        .poll(
          async () => page.locator("[data-yaade-shell='project']").count(),
          { timeout: 5_000 },
        )
        .toBe(1)
      await expect
        .poll(async () => page.locator("[data-yaade-mux]").count(), {
          timeout: 5_000,
        })
        .toBe(1)
      await expect
        .poll(
          async () =>
            page.locator("[data-yaade-project-tab='workspace']").count(),
          { timeout: 3_000 },
        )
        .toBe(0)
      await expect
        .poll(
          async () =>
            page.locator("[data-yaade-project-panel='running']").evaluate(el => {
              return !el.classList.contains("invisible")
            }),
          { timeout: 5_000 },
        )
        .toBe(true)

      await expect
        .poll(async () => new URL(await locationHref(page)).searchParams.get("s"), {
          timeout: 10_000,
        })
        .toMatch(/^ses-/)

      const state = await page.evaluate(() => window.__yaadeAgent!.getState())
      expect(state.route).toBe("session")
      expect(state.sessionId).toMatch(/^ses-/)

      // Git is the landing surface and does not keep a workspace in the URL.
      await page.locator('[data-yaade-project-worktree-item="main"]').click()
      await expect
        .poll(
          async () =>
            page.locator("[data-yaade-project-panel='history']").evaluate(el => {
              return !el.classList.contains("invisible")
            }),
          { timeout: 5_000 },
        )
        .toBe(true)
      await expect
        .poll(async () => new URL(await locationHref(page)).searchParams.get("s"))
        .toBeNull()

      await page.evaluate(id => {
        const url = new URL(location.href)
        url.searchParams.set("view", "running")
        url.searchParams.set("s", id)
        history.pushState({}, "", `${url.pathname}${url.search}`)
        window.dispatchEvent(new PopStateEvent("popstate"))
      }, createdSessionId)
      await waitForMux(page)
      await expect
        .poll(
          async () =>
            page.locator("[data-yaade-project-panel='running']").evaluate(el => {
              return !el.classList.contains("invisible")
            }),
          { timeout: 5_000 },
        )
        .toBe(true)
      await expect
        .poll(async () => new URL(await locationHref(page)).searchParams.get("s"))
        .toBe(createdSessionId)

      await page.evaluate(async () => {
        await window.__yaadeAgent!.backToProject?.()
      })
      await waitForProjectPage(page)
      await expect
        .poll(async () => new URL(await locationHref(page)).searchParams.get("s"), {
          timeout: 10_000,
        })
        .toBeNull()
      await expect
        .poll(async () => page.locator("[data-yaade-mux]").count(), {
          timeout: 5_000,
        })
        .toBe(0)
    } finally {
      await app.close()
    }
  })

  test("reload restores the open session layout", async () => {
    const { app, page } = await launchJet({ projectPage: true })
    try {
      await waitForProjectPage(page)
      const createdSessionId = await page.evaluate(async () => {
        const created = await window.__yaadeAgent!.createProjectSession?.({
          title: "Reload session",
        })
        return created?.id ?? null
      })
      expect(createdSessionId).toMatch(/^ses-/)
      await waitForMux(page)

      await page.reload()
      await waitForMux(page)
      await expect
        .poll(async () => new URL(await locationHref(page)).searchParams.get("s"), {
          timeout: 10_000,
        })
        .toBe(createdSessionId)
    } finally {
      await app.close()
    }
  })
})
