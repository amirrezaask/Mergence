import { expect, test } from "@playwright/test"
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  controlUserService,
  installUserService,
  statusUserService,
  uninstallUserService,
  userServicePath,
} from "../../packages/yaade-host-server/src/service-install.js"
import { waitUntil } from "../runtime/harness/wait.js"
import { createDurableRuntimeHarness } from "../runtime/harness/index.js"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const RUN_TS_ENTRY = path.join(REPO_ROOT, "scripts/run-ts.mjs")
const HOST_SERVER_ENTRY = path.join(REPO_ROOT, "packages/yaade-host-server/src/cli.ts")

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        return reject(new Error("no test port"))
      }
      server.close(error => (error ? reject(error) : resolve(address.port)))
    })
  })
}

test.describe("O — service lifecycle", { tag: "@p2" }, () => {
  test("O01 user-service install/start/status/stop/uninstall leaves user data", async ({}, testInfo) => {
    test.skip(Boolean(process.env.CI) && !process.env.YAADE_SERVICE_E2E, "user-service install is release/cross-platform, not pull-request CI")
    test.skip(process.platform === "win32" && !process.env.YAADE_SERVICE_E2E, "Windows scheduled-task install needs an interactive runner")
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-service-e2e-"))
    const dataDir = path.join(root, "data")
    const workspace = path.join(root, "workspace")
    fs.mkdirSync(dataDir, { recursive: true })
    fs.mkdirSync(workspace, { recursive: true })
    const marker = path.join(dataDir, "user-marker.txt")
    fs.writeFileSync(marker, "keep\n")
    const port = await freePort()
    const serviceName = `com.yaade.e2e.${randomUUID().slice(0, 8)}`
    const options = {
      executable: process.execPath,
      dataDir,
      serviceName,
      args: [
        RUN_TS_ENTRY,
        HOST_SERVER_ENTRY,
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--data-dir",
        dataDir,
        "--allowed-roots",
        `${REPO_ROOT},${root}`,
        workspace,
      ],
      env: {
        JET_STATIC_DIR: path.join(REPO_ROOT, "apps/web/dist"),
      },
    }
    try {
      const installed = await installUserService(options)
      expect(installed.installed).toBe(true)
      expect(fs.existsSync(userServicePath(options))).toBe(true)
      if (!installed.running) {
        test.skip(true, `platform service manager did not start the unit: ${installed.message}`)
      }
      await waitUntil(
        () => fs.existsSync(path.join(dataDir, "runtime.json")),
        20_000,
        "runtime manifest after install",
      )
      const status = await statusUserService(options)
      expect(status.installed).toBe(true)
      expect(status.running).toBe(true)
      await controlUserService("stop", options)
      expect(fs.readFileSync(marker, "utf8")).toBe("keep\n")
      await controlUserService("start", options)
      await waitUntil(
        () => fs.existsSync(path.join(dataDir, "runtime.json")),
        20_000,
        "runtime manifest after restart",
      )
    } catch (error) {
      await testInfo.attach("service-data", {
        body: fs.existsSync(dataDir) ? fs.readdirSync(dataDir).join("\n") : "missing",
        contentType: "text/plain",
      }).catch(() => undefined)
      throw error
    } finally {
      await uninstallUserService(options)
      expect(fs.existsSync(userServicePath(options))).toBe(false)
      expect(fs.readFileSync(marker, "utf8")).toBe("keep\n")
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("O02 client discovers an auto-started daemon", async ({}, testInfo) => {
    test.skip(Boolean(process.env.CI) && !process.env.YAADE_SERVICE_E2E, "user-service install is release/cross-platform, not pull-request CI")
    test.skip(process.platform === "win32" && !process.env.YAADE_SERVICE_E2E, "Windows scheduled-task install needs an interactive runner")
    const harness = await createDurableRuntimeHarness()
    const port = harness.port
    const serviceName = `com.yaade.e2e.${randomUUID().slice(0, 8)}`
    const options = {
      executable: process.execPath,
      dataDir: harness.dataDir,
      serviceName,
      args: [
        RUN_TS_ENTRY,
        HOST_SERVER_ENTRY,
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--data-dir",
        harness.dataDir,
        "--allowed-roots",
        `${REPO_ROOT},${harness.root}`,
        harness.workspace,
      ],
      env: {
        JET_STATIC_DIR: path.join(REPO_ROOT, "apps/web/dist"),
      },
    }
    try {
      const installed = await installUserService(options)
      if (!installed.running) {
        test.skip(true, `platform service manager did not start the unit: ${installed.message}`)
      }
      await waitUntil(
        () => fs.existsSync(path.join(harness.dataDir, "runtime.json")),
        20_000,
        "auto-started runtime manifest",
      )
      await waitUntil(async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`)
          return response.ok
        } catch {
          return false
        }
      }, 20_000, "auto-started daemon health")
      const manifest = JSON.parse(
        fs.readFileSync(path.join(harness.dataDir, "runtime.json"), "utf8"),
      ) as { serverId?: string; port?: number }
      expect(manifest.port).toBe(port)
      expect(manifest.serverId).toBeTruthy()
      const browser = await harness.startBrowser()
      await browser.page.waitForFunction(() => window.__yaadeAgent != null, null, {
        timeout: 30_000,
      })
      const health = await fetch(`http://127.0.0.1:${port}/health`)
      expect(health.ok).toBe(true)
      const body = (await health.json()) as { identity?: { serverId?: string } }
      expect(body.identity?.serverId).toBe(manifest.serverId)
    } catch (error) {
      await harness.retainDiagnostics(testInfo.outputDir).catch(() => undefined)
      throw error
    } finally {
      await uninstallUserService(options)
      await harness.close()
    }
  })
})
