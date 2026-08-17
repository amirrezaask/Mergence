import { resolve } from "node:path"
import { execSync } from "node:child_process"
import { launchWeb } from "../shell/launch-web.js"
import type { LaunchShellResult, ShellDriver } from "../shell/driver.js"

export type { ShellDriver }
export type LaunchJetOptions = {
  workspaceRel?: string
  env?: Record<string, string>
  userDataDir?: string
  launchWithoutWorkspace?: boolean
  startPath?: string
  homeDir?: string
  /**
   * Stay on the GitHub-style project page (session list) instead of opening a
   * session workspace. Default false — most mux/terminal E2E specs need a session.
   */
  projectPage?: boolean
  /** Return after rendering an intentional boot error instead of waiting for the agent bridge. */
  expectBootError?: boolean
  /** Stay on the host-wide HQ route (`/`). */
  hq?: boolean
  /**
   * After mux mounts, open a terminal pane. Default true so historical specs
   * keep working; product default for new sessions is empty (pass false to
   * assert the empty picker).
   */
  withTerminal?: boolean
  /** Narrow allowlist for a test that intentionally requests an HTTP error. */
  expectedHttpErrors?: Array<{
    method: string
    path: string
    status: number
  }>
}

export const REPO_ROOT = resolve(__dirname, "..", "..")
export const SAMPLE = "fixtures/sample-workspace"

/**
 * PTY availability. On macOS ensure node-pty spawn-helper is +x
 * (`packages/yaade-node-host/scripts/fix-node-pty-perms.mjs`).
 */
export function hasPtySpawn(): boolean {
  return process.platform !== "win32"
}

export function hasCursorAgent(): boolean {
  try {
    execSync("which cursor-agent", { stdio: "ignore" })
    return true
  } catch {
    try {
      execSync("which agent", { stdio: "ignore" })
      return true
    } catch {
      return false
    }
  }
}

/**
 * Shared E2E entry. Historical specs remain under tests/electron/.
 *
 * Each `launchJet()` call spins up its own `@yaade/host-server` + browser
 * context and tears it down in the test's `finally` via `app.close()`.
 * The default suite is serial because PTY/LSP timing becomes flaky under host
 * contention; `PLAYWRIGHT_WORKERS=N` remains available for targeted runs.
 *
 * A shared host-per-worker fixture was intentionally NOT adopted: several active
 * specs assert against fresh host state — e.g. `mux.electron.spec.ts` /
 * `url-session.electron.spec.ts` reload to restore persisted layouts and expect
 * to start from a single pane, and PTYs/workspace-sessions would leak between
 * tests sharing a host. Reusing one host across tests in a worker would make
 * these order-dependent and flaky. Keep the per-test host lifecycle. If a
 * shared host is ever revisited, migrate one
 * spec (mux) as a pilot behind a worker-scoped Playwright fixture and prove
 * isolation (reset sessions + dispose PTYs between tests) before expanding.
 */
export async function launchJet(
  workspaceRelOrOpts: string | LaunchJetOptions = SAMPLE,
): Promise<LaunchShellResult> {
  const opts: LaunchJetOptions =
    typeof workspaceRelOrOpts === "string" ? { workspaceRel: workspaceRelOrOpts } : workspaceRelOrOpts
  const result = await launchWeb(opts)
  try {
    if (opts.expectBootError) return result
    if (opts.hq) {
      await waitForHq(result.page)
    } else if (!opts.projectPage) {
      await waitForMux(result.page)
      if (opts.withTerminal !== false) {
        await openMuxTerminal(result.page)
      }
    } else {
      await waitForProjectPage(result.page)
    }
    return result
  } catch (error) {
    // launchWeb has already created the host process by this point. If a
    // readiness helper fails, the caller never receives `result` and cannot
    // run its normal finally block, so tear the host down here as well.
    await result.app.close().catch(() => {})
    throw error
  }
}

export async function waitForHq(
  page: ShellDriver,
  timeoutMs = 30_000,
): Promise<void> {
  await page.waitForSelector('[data-yaade-shell="hq"]', {
    timeout: timeoutMs,
  })
  await page.waitForSelector('[data-yaade-list-panel="hq-agents"]', {
    timeout: Math.min(timeoutMs, 10_000),
  })
  await page.evaluate(() => window.__yaadeAgent?.waitForReady())
}

export async function waitForHome(page: ShellDriver, timeoutMs = 30_000): Promise<void> {
  await waitForMux(page, timeoutMs)
}

/** Wait for the terminal mux shell, creating a session from the project page if needed. */
export async function waitForMux(page: ShellDriver, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let attemptedOpen = false
  let sessionParamWaitStarted: number | null = null
  while (Date.now() < deadline) {
    if ((await page.locator('[data-yaade-shell="tool-session"]').count()) > 0) {
      try {
        await page.evaluate(() => window.__yaadeAgent!.waitForReady())
        return
      } catch {
        await page.waitForTimeout(100)
        continue
      }
    }
    if ((await page.locator('[data-yaade-search-results="fullscreen"]').count()) > 0) {
      try {
        await page.evaluate(() => window.__yaadeAgent!.waitForReady())
        return
      } catch {
        await page.waitForTimeout(150)
        continue
      }
    }
    if ((await page.locator("[data-yaade-mux]").count()) > 0) {
      try {
        await page.evaluate(() => window.__yaadeAgent!.waitForReady())
        return
      } catch {
        // Mux DOM can mount before the agent bridge is ready — retry.
        await page.waitForTimeout(150)
        continue
      }
    }
    if ((await page.locator("[data-yaade-boot='loading']").count()) > 0) {
      await page.waitForTimeout(50)
      continue
    }
    const onProject =
      (await page.locator("[data-yaade-shell='project']").count()) > 0
    if (!onProject) {
      await page.waitForTimeout(100)
      continue
    }

    const sessionId = await page.evaluate(
      () => new URL(location.href).searchParams.get("s"),
    )
    if (sessionId) {
      // AppRoot is still mounting MuxApp from ?s=, or fell back to project.
      if (sessionParamWaitStarted == null) sessionParamWaitStarted = Date.now()
      if (Date.now() - sessionParamWaitStarted < 2_500) {
        await page.waitForTimeout(100)
        continue
      }
      if (!attemptedOpen) {
        const agentReady = await page.evaluate(
          () => Boolean(window.__yaadeAgent?.openProjectSession),
        )
        if (!agentReady) {
          await page.waitForTimeout(100)
          continue
        }
        attemptedOpen = true
        await page.evaluate(async id => {
          await window.__yaadeAgent!.openProjectSession!(id)
        }, sessionId)
      }
      await page.waitForTimeout(100)
      continue
    }
    sessionParamWaitStarted = null

    if (attemptedOpen) {
      await page.waitForTimeout(100)
      continue
    }

    const createDialogOpen =
      (await page.locator("[data-yaade-create-worktree-dialog]").count()) > 0 ||
      (await page.locator("[data-yaade-new-session-dialog]").count()) > 0
    if (createDialogOpen) {
      await page.waitForTimeout(100)
      continue
    }

    const agentReady = await page.evaluate(
      () => Boolean(window.__yaadeAgent?.createProjectSession),
    )
    if (!agentReady) {
      await page.waitForTimeout(100)
      continue
    }

    attemptedOpen = true
    try {
      await page.evaluate(async () => {
        await window.__yaadeAgent!.createProjectSession!({ title: "E2E session" })
      })
    } catch {
      attemptedOpen = false
      await page.waitForTimeout(150)
      continue
    }
    await page.locator("[data-yaade-mux]").waitFor({
      state: "visible",
      timeout: Math.max(1_000, deadline - Date.now()),
    })
    try {
      await page.evaluate(() => window.__yaadeAgent!.waitForReady())
      return
    } catch {
      attemptedOpen = false
      await page.waitForTimeout(150)
      continue
    }
  }
  throw new Error("waitForMux: timed out waiting for project page or mux shell")
}

async function confirmTerminalCheckout(page: ShellDriver): Promise<void> {
  const main = page.locator("[data-yaade-worktree-main]")
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if ((await main.count()) > 0) {
      await main.click()
      return
    }
    await page.waitForTimeout(50)
  }
}

/** Open a terminal pane from the instance sidebar / empty CTA (or no-op if one exists). */
export async function openMuxTerminal(
  page: ShellDriver,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const terminal = page.locator("[data-yaade-terminal-panel]")
  const emptyTile = page.locator('[data-yaade-mux-empty-action="terminal"]')
  const sessionEmptyTool = page.locator('[data-yaade-empty-tool="terminal"]')
  const sidebarNew = page.locator(
    '[data-yaade-mux] [data-yaade-instance-sidebar="running"] [data-yaade-instance-sidebar-new]',
  )
  const projectNew = page.locator('[data-yaade-project-process-new="running"]')
  const emptyCta = page.locator(
    '[data-yaade-project-surface="running"] [data-yaade-running-empty-new-terminal], [data-yaade-project-surface="running"] button:has-text("New terminal")',
  )
  while (Date.now() < deadline) {
    // Restored sessions can hydrate their terminal after waitForMux resolves.
    // Do not wait exclusively for the empty picker in that transition window.
    if ((await terminal.count()) > 0) return
    // Prefer the project process launcher — embedded mux no longer mounts a
    // second InstanceSidebar, and project-scoped instances reconcile into mux.
    if ((await projectNew.count()) > 0) {
      await projectNew.first().click()
      const shellProvider = page.locator('[data-yaade-agent-provider="terminal"]')
      const providerDeadline = Date.now() + 3_000
      while (Date.now() < providerDeadline && (await shellProvider.count()) === 0) {
        await page.waitForTimeout(50)
      }
      if ((await shellProvider.count()) > 0) await shellProvider.click()
      await confirmTerminalCheckout(page)
      await page.waitForSelector("[data-yaade-terminal-panel]", {
        timeout: Math.max(1_000, deadline - Date.now()),
      })
      return
    }
    if ((await emptyTile.count()) > 0) {
      await emptyTile.click()
      await confirmTerminalCheckout(page)
      await page.waitForSelector("[data-yaade-terminal-panel]", {
        timeout: Math.max(1_000, deadline - Date.now()),
      })
      return
    }
    if ((await sessionEmptyTool.count()) > 0) {
      await sessionEmptyTool.click()
      await page.waitForSelector("[data-yaade-terminal-panel]", {
        timeout: Math.max(1_000, deadline - Date.now()),
      })
      return
    }
    if ((await emptyCta.count()) > 0) {
      await emptyCta.first().click()
      await confirmTerminalCheckout(page)
      await page.waitForSelector("[data-yaade-terminal-panel]", {
        timeout: Math.max(1_000, deadline - Date.now()),
      })
      return
    }
    if ((await sidebarNew.count()) > 0) {
      await sidebarNew.first().click()
      await confirmTerminalCheckout(page)
      await page.waitForSelector("[data-yaade-terminal-panel]", {
        timeout: Math.max(1_000, deadline - Date.now()),
      })
      return
    }
    await page.waitForTimeout(50)
  }
  throw new Error("openMuxTerminal: terminal or empty picker did not become available")
}

/** Wait for the project shell. */
export async function waitForProjectPage(
  page: ShellDriver,
  timeoutMs = 30_000,
): Promise<void> {
  await page.waitForSelector("[data-yaade-shell='project']", {
    timeout: timeoutMs,
  })
}

/** @deprecated Alias — mux shell is the session workspace. */
export async function waitForMuxAlias(page: ShellDriver, timeoutMs = 30_000): Promise<void> {
  await waitForMux(page, timeoutMs)
}

/** Mission Control sidebar removed — mux shell is the home surface. */
export async function ensureSidebarLayout(page: ShellDriver): Promise<void> {
  await waitForMux(page, 15_000)
}

/** @deprecated Use ensureSidebarLayout — cards layout removed. */
export async function ensureCardsLayout(page: ShellDriver): Promise<void> {
  await ensureSidebarLayout(page)
}

export async function waitForDialog(page: ShellDriver, timeoutMs = 30_000): Promise<void> {
  await page
    .locator('[role="dialog"][data-state="open"], [data-slot="dialog-content"][data-state="open"]')
    .first()
    .waitFor({ state: "visible", timeout: timeoutMs })
}

export async function openThemePicker(page: ShellDriver): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    await execCommand(page, "ui.showThemePicker")
    try {
      await page.locator("[data-yaade-settings-overlay]").waitFor({ state: "visible", timeout: 2_000 })
      return
    } catch {
      await page.waitForTimeout(250)
    }
  }
  throw new Error("Theme picker did not appear")
}

export async function focusTerminal(page: ShellDriver): Promise<void> {
  await page.locator("[data-yaade-terminal-panel] .yaade-terminal-surface").click()
  await page.evaluate(() => {
    window.__yaadeAgent?.focusTerminal?.()
  })
  // Best-effort DOM focus — the registry focus path above is authoritative.
  await page
    .locator("[data-yaade-terminal-panel] [data-yaade-terminal-input]")
    .first()
    .focus({ timeout: 5_000 })
    .catch(() => undefined)
}

export async function openSettings(page: ShellDriver): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    await execCommand(page, "settings.show")
    try {
      await page.locator("[data-yaade-settings-overlay]").waitFor({ state: "visible", timeout: 2_000 })
      return
    } catch {
      await page.waitForTimeout(250)
    }
  }
  throw new Error("Settings overlay did not appear")
}

export async function showTerminal(page: ShellDriver): Promise<void> {
  await waitForMux(page)
  await page.waitForSelector("[data-yaade-terminal-panel] [data-yaade-terminal-canvas]", {
    timeout: 30_000,
  })
}

export async function readTerminalText(page: ShellDriver): Promise<string> {
  return page.evaluate(() => window.__yaadeAgent?.getTerminalText?.() ?? "")
}

/** Poll until the active terminal buffer contains `needle` (WebGL-safe). */
export async function waitForTerminalText(
  page: ShellDriver,
  needle: string | RegExp,
  timeoutMs = 15_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const text = await readTerminalText(page)
    if (typeof needle === "string" ? text.includes(needle) : needle.test(text)) {
      return text
    }
    await page.waitForTimeout(50)
  }
  throw new Error(
    `waitForTerminalText: timed out waiting for ${String(needle)}`,
  )
}

export async function confirmOverlay(page: ShellDriver): Promise<void> {
  await page.keyboard.press("Meta+Enter")
}

/** Platform primary chord modifier for Playwright (`Meta` on macOS, `Control` elsewhere). */
export function modChord(): "Meta" | "Control" {
  return process.platform === "darwin" ? "Meta" : "Control"
}

export async function pressMod(
  page: ShellDriver,
  key: string,
  opts?: { shift?: boolean },
): Promise<void> {
  const mods = [modChord()]
  if (opts?.shift) mods.push("Shift")
  await page.keyboard.press(`${mods.join("+")}+${key}`)
}

/**
 * Mux / Tool Session actions live behind Mod-k (⌘K / Ctrl+K). Playwright's
 * CDP input bypasses browser chrome, so a spec pressing `Meta+KeyT` would
 * pass while the same key does nothing for a real user — always drive shell
 * actions through the prefix.
 */
export async function pressShellPrefix(page: ShellDriver): Promise<void> {
  const mod = modChord()
  await page.keyboard.down(mod)
  await page.keyboard.press("KeyK")
  await page.keyboard.up(mod)
  // Mux second-keys reject leftover Meta/Ctrl. Playwright can latch them
  // after a Mod- chord, so force both modifiers up.
  await page.keyboard.up("Meta")
  await page.keyboard.up("Control")
}

export async function pressMuxPrefix(
  page: ShellDriver,
  key: string,
): Promise<void> {
  await pressShellPrefix(page)
  await page.keyboard.press(key)
}

export async function execCommand(page: ShellDriver, commandId: string): Promise<void> {
  await page.evaluate(async (cmd: string) => {
    await window.__yaadeAgent!.executeCommand(cmd)
  }, commandId)
}

export async function clickNewSession(page: ShellDriver): Promise<void> {
  const sidebarNew = page.locator("[data-yaade-sidebar-new-session]")
  if ((await sidebarNew.count()) > 0 && (await sidebarNew.first().isVisible())) {
    await sidebarNew.first().click()
    return
  }
  await page.getByRole("button", { name: /New session/i }).first().click()
}

/** Pick an agent CLI from the new-session lister (default: Codex). */
export async function pickAgentCli(
  page: ShellDriver,
  agentId: string = "codex",
): Promise<void> {
  const option = page.locator(`[data-yaade-agent-cli-option="${agentId}"]`)
  await option.waitFor({ state: "visible", timeout: 20_000 })
  await option.click()
}

/** Open a CLI-driven ADE session (picker → Agent surface / PTY). */
export async function openNewCliSession(
  page: ShellDriver,
  agentId: string = "codex",
): Promise<ReturnType<ShellDriver["locator"]>> {
  await clickNewSession(page)
  await pickAgentCli(page, agentId)
  const modal = page.locator("[data-yaade-terminal-modal]")
  await modal.waitFor({ state: "visible", timeout: 20_000 })
  await page.waitForFunction(
    () =>
      document
        .querySelector("[data-yaade-terminal-modal]")
        ?.getAttribute("data-yaade-session-mode") === "agent",
    null,
    { timeout: 20_000 },
  )
  return modal
}

/** @deprecated Use {@link openNewCliSession}. */
export async function openNewAgentSession(
  page: ShellDriver,
  providerId?: string,
): Promise<ReturnType<ShellDriver["locator"]>> {
  return openNewCliSession(page, providerId ?? "codex")
}
