import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import { execCommand, launchJet } from "../tests/electron/_launch.js"
import type { ShellDriver } from "../tests/shell/driver.js"

const repoRoot = fileURLToPath(new URL("..", import.meta.url))
const prompt = "Review the authentication flow, fix the failing test, and verify the result."

type DemoOptions = {
  headless: boolean
  skipBuild: boolean
  paceMs: number
  autoCloseMs: number | null
  captureDir: string | null
}

function parseOptions(args: ReadonlyArray<string>): DemoOptions {
  const value = (prefix: string): string | undefined =>
    args.find(argument => argument.startsWith(prefix))?.slice(prefix.length)
  const pace = Number(value("--pace=") ?? "1800")
  const autoCloseValue = value("--auto-close=")
  return {
    headless: args.includes("--headless"),
    skipBuild: args.includes("--skip-build"),
    paceMs: Number.isFinite(pace) && pace >= 0 ? pace : 1_800,
    autoCloseMs: autoCloseValue === undefined
      ? null
      : Math.max(0, Number(autoCloseValue) || 0),
    captureDir: value("--capture-dir=") ?? null,
  }
}

function runBuild(): Promise<void> {
  return new Promise((resolveBuild, rejectBuild) => {
    const child = spawn(process.execPath, ["scripts/build.mjs"], {
      cwd: repoRoot,
      stdio: "inherit",
    })
    child.once("error", rejectBuild)
    child.once("exit", code => {
      if (code === 0) resolveBuild()
      else rejectBuild(new Error(`YAADE build exited with code ${code ?? "unknown"}`))
    })
  })
}

function pause(ms: number): Promise<void> {
  return ms === 0 ? Promise.resolve() : new Promise(resolvePause => setTimeout(resolvePause, ms))
}

async function settleLayout(page: ShellDriver): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolveFrame => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))
  }))
}

async function capture(page: ShellDriver, directory: string | null, name: string): Promise<void> {
  if (!directory) return
  const target = resolve(repoRoot, directory)
  await mkdir(target, { recursive: true })
  const png = await page.screenshot()
  await writeFile(resolve(target, `${name}.png`), Buffer.from(png, "base64"))
}

async function waitForReviewer(): Promise<void> {
  if (!process.stdin.isTTY) return
  process.stdout.write("[agent-demo] Review the final UI, then press Enter to close.\n")
  process.stdin.resume()
  await new Promise<void>(resolveInput => {
    const finish = (): void => resolveInput()
    process.stdin.once("data", finish)
    process.once("SIGINT", finish)
  })
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes("--help")) {
    process.stdout.write([
      "Usage: pnpm agent:demo [options]",
      "",
      "  --pace=<ms>          Presentation pause between stages (default: 1800)",
      "  --auto-close=<ms>    Close after the completed state instead of waiting for Enter",
      "  --capture-dir=<path> Save permission and completion screenshots",
      "  --headless           Run without a visible browser (automation)",
      "  --skip-build         Reuse the existing apps/yaade/dist build",
      "",
    ].join("\n"))
    return
  }
  const options = parseOptions(args)
  if (!options.skipBuild) {
    process.stdout.write("[agent-demo] Building the current YAADE UI…\n")
    await runBuild()
  }

  process.env.YAADE_HEADED = options.headless ? "0" : "1"
  process.stdout.write("[agent-demo] Launching YAADE with the deterministic showcase agent…\n")
  const launched = await launchJet({
    withTerminal: false,
    env: { YAADE_AGENT_MOCK_SCENARIO: "ui-showcase" },
  })

  try {
    const { page } = launched
    await page.setViewportSize({ width: 1440, height: 960 })
    await execCommand(page, "agentChat.focus")
    const pane = page.locator('[data-yaade-tool-pane="agentChat"]')
    await pane.waitFor({ state: "visible", timeout: 15_000 })
    await execCommand(page, "mux.zoomPane")
    await settleLayout(page)

    process.stdout.write("[agent-demo] Starting the canonical MockDriver thread…\n")
    await pane.getByRole("button", { name: /Canonical Mock Driver/ }).click()
    const composer = pane.locator('[aria-label="Message agent"]')
    await composer.waitFor({ state: "visible", timeout: 15_000 })
    await pause(options.paceMs)

    process.stdout.write("[agent-demo] Submitting a realistic coding task…\n")
    await composer.fill(prompt)
    await pause(Math.round(options.paceMs * 0.65))
    await pane.getByRole("button", { name: "Send message" }).click()

    const permission = pane.getByText("Apply the authentication fix?", { exact: true })
    await permission.waitFor({ state: "visible", timeout: 15_000 })
    await settleLayout(page)
    process.stdout.write("[agent-demo] Timeline now shows reasoning, a plan, tool calls, and permission gating.\n")
    await capture(page, options.captureDir, "01-permission")
    await pause(options.paceMs * 2)

    process.stdout.write("[agent-demo] Approving the advertised one-time permission…\n")
    await pane.getByRole("button", { name: "Apply fix" }).click()
    const finalAnswer = pane.getByText(/authentication suite now passes all 13 tests/i)
    await finalAnswer.waitFor({ state: "visible", timeout: 15_000 })
    await pane.getByText("Ready", { exact: true }).waitFor({ state: "visible", timeout: 15_000 })

    const timeline = pane.locator("[data-yaade-agent-timeline]")
    await timeline.evaluate(element => { element.scrollTop = 0 })
    const reasoning = pane.getByRole("button", { name: /Reasoning/ })
    await reasoning.waitFor({ state: "visible", timeout: 15_000 })
    await reasoning.click()
    await settleLayout(page)
    process.stdout.write("[agent-demo] Expanding the normalized reasoning item for review…\n")
    await pause(options.paceMs * 2)

    await timeline.evaluate(element => { element.scrollTop = element.scrollHeight })
    await finalAnswer.waitFor({ state: "visible", timeout: 15_000 })
    await settleLayout(page)
    await capture(page, options.captureDir, "02-complete")
    process.stdout.write(`[agent-demo] Demo complete at ${launched.baseUrl ?? "the launched YAADE window"}.\n`)

    if (options.autoCloseMs !== null) await pause(options.autoCloseMs)
    else await waitForReviewer()
  } finally {
    await launched.app.close()
  }
}

void main().catch(error => {
  process.stderr.write(`[agent-demo] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
