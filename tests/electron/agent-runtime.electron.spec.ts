import { expect, test } from "@playwright/test"
import { expectLocatorContainsText, expectLocatorVisible } from "../shell/assert.js"
import { launchJet, waitForMux } from "./_launch.js"

async function openMockThread(
  page: Awaited<ReturnType<typeof launchJet>>["page"],
): Promise<void> {
  await page.locator('[data-yaade-project-tab="native-agents"]').click()
  const pane = page.locator('[data-yaade-tool-pane="agentChat"]')
  await pane.waitFor({ state: "visible", timeout: 15_000 })
  await pane.getByRole("button", { name: /Canonical Mock Driver/ }).click()
  await pane.locator('[aria-label="Message agent"]').waitFor({ state: "visible" })
}

async function submitMockTurn(
  page: Awaited<ReturnType<typeof launchJet>>["page"],
  text: string,
) {
  const pane = page.locator('[data-yaade-tool-pane="agentChat"]')
  await pane.locator('[aria-label="Message agent"]').fill(text)
  await pane.getByRole("button", { name: "Send message" }).click()
  return pane
}

test.describe("interactive agent runtime", () => {
  test("exposes provider lifecycle IPC and rejects a thread outside its project session", async () => {
    const { app, page } = await launchJet({
      withTerminal: false,
      env: { YAADE_AGENT_MOCK_SCENARIO: "simple-stream" },
      expectedHttpErrors: [
        { method: "POST", path: "/api/v1/rpc", status: 403 },
      ],
    })
    try {
      await openMockThread(page)
      const result = await page.evaluate(async () => {
        const sessionId = window.__yaadeAgent?.getState().sessionId
        if (!sessionId || !window.yaade?.agentRuntime) throw new Error("agent runtime unavailable")
        const runtime = window.yaade.agentRuntime
        const providers = await runtime.listProviders()
        const threads = await runtime.listThreads(sessionId)
        const thread = threads[0]
        if (!thread) throw new Error("mock thread missing")
        const attachment = await runtime.uploadAttachment({
          threadId: thread.state.id,
          name: "note.txt",
          mediaType: "text/plain",
          contentBase64: btoa("attachment cleanup"),
        })
        const closed = await runtime.closeThread(thread.state.id)
        const deleted = await runtime.deleteThread(thread.state.id)
        const missing = await runtime.getSnapshot(thread.state.id)
        let outsideRejected = false
        try {
          await runtime.createThread({
            projectSessionId: sessionId,
            driverId: "mock:canonical",
            cwdUri: "file:///tmp/outside-project-session",
          })
        } catch {
          outsideRejected = true
        }
        return {
          providers: providers.map(provider => provider.id),
          attachmentId: attachment.id,
          closed: closed.state.status,
          deleted,
          missing,
          outsideRejected,
        }
      })
      expect(result.providers).toContain("mock")
      expect(result.attachmentId).toMatch(/^aat-/)
      expect(result.closed).toBe("closed")
      expect(result.deleted).toBe(true)
      expect(result.missing).toBeNull()
      expect(result.outsideRejected).toBe(true)
    } finally {
      await app.close()
    }
  })

  test("restores a stream submitted immediately before a reload", async () => {
    const { app, page } = await launchJet({
      withTerminal: false,
      env: { YAADE_AGENT_MOCK_SCENARIO: "simple-stream" },
    })
    try {
      await openMockThread(page)
      await submitMockTurn(page, "Show the deterministic response")
      await page.reload()
      await waitForMux(page)
      const restored = page.locator('[data-yaade-tool-pane="agentChat"]')
      await expectLocatorVisible(restored)
      await expectLocatorContainsText(restored.locator('[data-yaade-agent-timeline]'),
        "Hello from mock.",
        { timeout: 15_000 },
      )
      await expectLocatorContainsText(restored, "Ready")
    } finally {
      await app.close()
    }
  })

  test("round-trips the exact permission option and resolves shared attention", async () => {
    const { app, page } = await launchJet({
      withTerminal: false,
      env: { YAADE_AGENT_MOCK_SCENARIO: "permission-race" },
    })
    try {
      await openMockThread(page)
      const pane = await submitMockTurn(page, "Update auth")

      const actionDock = pane.locator('[data-yaade-agent-action-dock]')
      await expectLocatorContainsText(actionDock, "Update src/auth.ts")
      const allow = actionDock.getByRole("button", { name: "Allow once" })
      await allow.evaluate(element => {
        element.click()
        element.click()
      })
      await expect.poll(() => actionDock.count()).toBe(0)
      await expectLocatorContainsText(pane, "Ready")
      await expect.poll(() => pane.getByRole("alert").count()).toBe(0)

      await expect.poll(async () => page.evaluate(async () => {
        const state = window.__yaadeAgent?.getState()
        const notifications = await window.yaade?.notifications?.list({
          sessionId: state?.sessionId ?? undefined,
        })
        return notifications?.items.map(item => ({
          type: item.type,
          status: item.status,
          resolved: item.actionResolvedAt !== null,
        })) ?? []
      })).toEqual(expect.arrayContaining([
        { type: "permission-required", status: "unread", resolved: true },
        { type: "turn-completed", status: "unread", resolved: false },
      ]))
    } finally {
      await app.close()
    }
  })

  for (const key of ["Enter", "Space"] as const) {
    test(`responds to a permission with Tab then ${key}`, async () => {
      const { app, page } = await launchJet({
        withTerminal: false,
        env: { YAADE_AGENT_MOCK_SCENARIO: "permission-race" },
      })
      try {
        await openMockThread(page)
        const pane = await submitMockTurn(page, `Keyboard permission ${key}`)
        const actionDock = pane.locator('[data-yaade-agent-action-dock]')
        const allow = actionDock.getByRole("button", { name: "Allow once" })
        const reject = actionDock.getByRole("button", { name: "Reject" })
        await allow.focus()
        await page.keyboard.press("Tab")
        await expect.poll(() => reject.evaluate(element => document.activeElement === element)).toBe(true)
        await page.keyboard.press("Shift+Tab")
        await expect.poll(() => allow.evaluate(element => document.activeElement === element)).toBe(true)
        await page.keyboard.press(key)
        await expect.poll(() => actionDock.count()).toBe(0)
        await expectLocatorContainsText(pane, "Ready")
      } finally {
        await app.close()
      }
    })
  }

  test("submits structured elicitation from the keyboard", async () => {
    const { app, page } = await launchJet({
      withTerminal: false,
      env: { YAADE_AGENT_MOCK_SCENARIO: "elicitation" },
    })
    try {
      await openMockThread(page)
      const pane = await submitMockTurn(page, "Deploy the release")
      const dock = pane.locator('[data-yaade-agent-action-dock]')
      await expectLocatorContainsText(dock, "Deployment details")
      await page.evaluate(() => {
        const dockElement = document.querySelector('[data-yaade-agent-action-dock]')
        const text = dockElement?.querySelector<HTMLInputElement>('input:not([type="checkbox"])')
        const confirm = dockElement?.querySelector<HTMLInputElement>('input[type="checkbox"]')
        const select = dockElement?.querySelector<HTMLSelectElement>("select")
        if (!text || !confirm || !select) throw new Error("elicitation controls missing")
        text.value = "release"
        text.dispatchEvent(new Event("input", { bubbles: true }))
        text.dispatchEvent(new Event("change", { bubbles: true }))
        confirm.click()
        select.value = "eu"
        select.dispatchEvent(new Event("change", { bubbles: true }))
      })
      const continueButton = dock.getByRole("button", { name: "Continue" })
      await continueButton.focus()
      await page.keyboard.press("Enter")
      await expect.poll(() => dock.count()).toBe(0)
      await expectLocatorContainsText(pane, "Ready")
    } finally {
      await app.close()
    }
  })

  test("completes an authentication request once", async () => {
    const { app, page } = await launchJet({
      withTerminal: false,
      env: { YAADE_AGENT_MOCK_SCENARIO: "authentication" },
    })
    try {
      await openMockThread(page)
      const pane = await submitMockTurn(page, "Authenticate")
      const dock = pane.locator('[data-yaade-agent-action-dock]')
      await expectLocatorContainsText(dock, "Sign in to Mock Cloud")
      const signedIn = dock.getByRole("button", { name: "I’m signed in" })
      await signedIn.evaluate(element => { element.click(); element.click() })
      await expect.poll(() => dock.count()).toBe(0)
      await expectLocatorContainsText(pane, "Ready")
    } finally {
      await app.close()
    }
  })

  test("uploads a valid attachment and rejects an invalid MIME type", async () => {
    const valid = await launchJet({
      withTerminal: false,
      env: { YAADE_AGENT_MOCK_SCENARIO: "attachments" },
    })
    try {
      await openMockThread(valid.page)
      const pane = valid.page.locator('[data-yaade-tool-pane="agentChat"]')
      await valid.page.evaluate(() => {
        const input = document.querySelector<HTMLInputElement>('[data-yaade-tool-pane="agentChat"] input[type="file"]')
        if (!input) throw new Error("attachment input missing")
        const transfer = new DataTransfer()
        transfer.items.add(new File(["# Context"], "context.md", { type: "text/markdown" }))
        Object.defineProperty(input, "files", { configurable: true, value: transfer.files })
        input.dispatchEvent(new Event("change", { bubbles: true }))
      })
      await expectLocatorContainsText(valid.page.getByLabel("Agent attachments"), "context.md")
      await pane.getByRole("button", { name: "Send message" }).click()
      await expectLocatorContainsText(pane, "Ready")
    } finally {
      await valid.app.close()
    }

    const invalid = await launchJet({
      withTerminal: false,
      env: { YAADE_AGENT_MOCK_SCENARIO: "attachments" },
      expectedHttpErrors: [{ method: "POST", path: "/api/v1/rpc", status: 400 }],
    })
    try {
      await openMockThread(invalid.page)
      const pane = invalid.page.locator('[data-yaade-tool-pane="agentChat"]')
      await invalid.page.evaluate(() => {
        const input = document.querySelector<HTMLInputElement>('[data-yaade-tool-pane="agentChat"] input[type="file"]')
        if (!input) throw new Error("attachment input missing")
        const transfer = new DataTransfer()
        transfer.items.add(new File([new Uint8Array([0])], "payload.exe", { type: "application/octet-stream" }))
        Object.defineProperty(input, "files", { configurable: true, value: transfer.files })
        input.dispatchEvent(new Event("change", { bubbles: true }))
      })
      await expectLocatorContainsText(pane.getByRole("alert"), "unsupported agent attachment type")
    } finally {
      await invalid.app.close()
    }
  })

  test("applies dynamic configuration and surfaces provider rejection", async () => {
    const accepted = await launchJet({
      withTerminal: false,
      env: { YAADE_AGENT_MOCK_SCENARIO: "configuration-change" },
    })
    try {
      await openMockThread(accepted.page)
      const pane = accepted.page.locator('[data-yaade-tool-pane="agentChat"]')
      await pane.getByText("Configuration", { exact: true }).click()
      await accepted.page.getByLabel("Model").evaluate((element: Element) => {
        const select = element as HTMLSelectElement
        select.value = "mock-deep"
        select.dispatchEvent(new Event("change", { bubbles: true }))
      })
      await expect.poll(async () => accepted.page.getByLabel("Model").inputValue()).toBe("mock-deep")
      await submitMockTurn(accepted.page, "Use the selected model")
      await expectLocatorContainsText(pane, "Ready")
    } finally {
      await accepted.app.close()
    }

    const rejected = await launchJet({
      withTerminal: false,
      env: { YAADE_AGENT_MOCK_SCENARIO: "configuration-rejection" },
    })
    try {
      await openMockThread(rejected.page)
      const pane = rejected.page.locator('[data-yaade-tool-pane="agentChat"]')
      await pane.getByText("Configuration", { exact: true }).click()
      await rejected.page.getByLabel("Model").evaluate((element: Element) => {
        const select = element as HTMLSelectElement
        select.value = "mock-deep"
        select.dispatchEvent(new Event("change", { bubbles: true }))
      })
      await expectLocatorContainsText(pane.getByRole("alert"), "Configuration is locked")
      await submitMockTurn(rejected.page, "Continue with the original model")
      await expectLocatorContainsText(pane, "Ready")
    } finally {
      await rejected.app.close()
    }
  })

  test("interrupts a running turn and cleans up the pending stream", async () => {
    const { app, page } = await launchJet({
      withTerminal: false,
      env: { YAADE_AGENT_MOCK_SCENARIO: "interrupt" },
    })
    try {
      await openMockThread(page)
      const pane = await submitMockTurn(page, "Start long work")
      const interrupt = pane.getByRole("button", { name: "Interrupt agent" })
      await interrupt.waitFor({ state: "visible" })
      await interrupt.click()
      await expect.poll(async () => page.evaluate(async () => {
        const sessionId = window.__yaadeAgent?.getState().sessionId
        return (await window.yaade?.agentRuntime?.listThreads(sessionId))?.[0]?.state.status
      })).toBe("interrupted")
      await expect.poll(() => interrupt.count()).toBe(0)
    } finally {
      await app.close()
    }
  })

  for (const scenario of ["provider-error", "disconnect", "oversized-output"] as const) {
    test(`surfaces the ${scenario} terminal failure`, async () => {
      const { app, page } = await launchJet({
        withTerminal: false,
        env: { YAADE_AGENT_MOCK_SCENARIO: scenario },
      })
      try {
        await openMockThread(page)
        await submitMockTurn(page, scenario)
        await expect.poll(async () => page.evaluate(async () => {
          const sessionId = window.__yaadeAgent?.getState().sessionId
          return (await window.yaade?.agentRuntime?.listThreads(sessionId))?.[0]?.state.status
        })).toBe("failed")
      } finally {
        await app.close()
      }
    })
  }

  for (const scenario of ["replay-duplicate", "replay-gap", "backpressure"] as const) {
    test(`recovers the ${scenario} stream without duplicate timeline state`, async () => {
      const { app, page } = await launchJet({
        withTerminal: false,
        env: { YAADE_AGENT_MOCK_SCENARIO: scenario },
      })
      try {
        await openMockThread(page)
        await submitMockTurn(page, scenario)
        await expect.poll(async () => page.evaluate(async () => {
          const sessionId = window.__yaadeAgent?.getState().sessionId
          const thread = (await window.yaade?.agentRuntime?.listThreads(sessionId))?.[0]
          return thread ? {
            status: thread.state.status,
            turnCount: thread.state.turns.length,
            itemCount: thread.state.itemOrder.length,
          } : null
        })).toMatchObject({ status: "idle", turnCount: 1 })
      } finally {
        await app.close()
      }
    })
  }

  test("keeps two mock threads isolated", async () => {
    const { app, page } = await launchJet({
      withTerminal: false,
      env: { YAADE_AGENT_MOCK_SCENARIO: "multi-thread-isolation" },
    })
    try {
      await openMockThread(page)
      const result = await page.evaluate(async () => {
        const runtime = window.yaade?.agentRuntime
        const sessionId = window.__yaadeAgent?.getState().sessionId
        if (!runtime || !sessionId) throw new Error("agent runtime unavailable")
        const current = (await runtime.listThreads(sessionId))[0]
        if (!current) throw new Error("current mock thread unavailable")
        const second = await runtime.createThread({
          projectSessionId: sessionId,
          driverId: "mock:canonical",
          cwdUri: current.state.cwdUri,
        })
        const submit = async (threadId: string, text: string) => runtime.sendCommand({
          protocolVersion: 1,
          commandId: crypto.randomUUID(),
          threadId,
          issuedAt: new Date().toISOString(),
          command: { type: "turn.submit", input: [{ type: "text", text }] },
        })
        await Promise.all([
          submit(current.state.id, "first"),
          submit(second.state.id, "second"),
        ])
        return [current.state.id, second.state.id]
      })
      await expect.poll(async () => page.evaluate(async ids => {
        const threads = await window.yaade?.agentRuntime?.listThreads()
        return ids.map(id => threads?.find(thread => thread.state.id === id)?.state.turns.length ?? 0)
      }, result)).toEqual([1, 1])
      expect(new Set(result).size).toBe(2)
    } finally {
      await app.close()
    }
  })

  test("suppresses duplicate completion notifications for the same native event", async () => {
    const { app, page } = await launchJet({
      withTerminal: false,
      env: { YAADE_AGENT_MOCK_SCENARIO: "notification-deduplication" },
    })
    try {
      await openMockThread(page)
      await submitMockTurn(page, "Notify once")
      await expect.poll(async () => page.evaluate(async () => {
        const sessionId = window.__yaadeAgent?.getState().sessionId
        const notifications = await window.yaade?.notifications?.list({ sessionId })
        return notifications?.items.filter(item => item.type === "turn-completed").length ?? 0
      })).toBe(1)
    } finally {
      await app.close()
    }
  })

  test("renders the complete agent UI showcase flow", async () => {
    const { app, page } = await launchJet({
      withTerminal: false,
      env: { YAADE_AGENT_MOCK_SCENARIO: "ui-showcase" },
    })
    try {
      await openMockThread(page)
      const pane = await submitMockTurn(page, "Review the authentication flow")
      await expectLocatorContainsText(pane, "Fix authentication regression")
      await expectLocatorContainsText(pane, "Read src/auth.ts")
      await expectLocatorContainsText(pane, "Run authentication tests")

      const dock = pane.locator('[data-yaade-agent-action-dock]')
      await expectLocatorContainsText(dock, "Apply the authentication fix?")
      await dock.getByRole("button", { name: "Apply fix" }).click()
      await expect.poll(() => dock.count()).toBe(0)

      await expectLocatorContainsText(pane, "Update src/auth.ts")
      await expectLocatorContainsText(pane, "Verify authentication tests")
      await expectLocatorContainsText(pane, "Proposed change: file:///workspace/src/auth.ts")
      await expectLocatorContainsText(pane, "authentication suite now passes all 13 tests")
      await expectLocatorContainsText(pane, "Ready")
      await expect.poll(async () => page.evaluate(async () => {
        const sessionId = window.__yaadeAgent?.getState().sessionId
        return (await window.yaade?.agentRuntime?.listThreads(sessionId))?.[0]?.state.status
      })).toBe("idle")
    } finally {
      await app.close()
    }
  })
})
