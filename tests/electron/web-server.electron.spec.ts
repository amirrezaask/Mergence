import { expect, test } from "@playwright/test"
import { launchJet, waitForHome, waitForMux } from "./_launch.js"

test.describe("single-binary web server", () => {
  test("tears down, then rejects unexpected browser console errors", async () => {
    const { app, page } = await launchJet({ projectPage: true })
    await page.evaluate(() => {
      console.error("YAADE_E2E_UNEXPECTED_CONSOLE_SENTINEL")
    })
    await expect(app.close()).rejects.toThrow(
      /Unexpected browser failures:[\s\S]*YAADE_E2E_UNEXPECTED_CONSOLE_SENTINEL/,
    )
  })

  test("serves the SPA, health, system, WS, and workspace-session API", async ({}, testInfo) => {
    const { app, page } = await launchJet({
      expectedHttpErrors: [
        { method: "GET", path: "/api/v1/workspace-session", status: 403 },
        { method: "GET", path: "/api/v1/workspace-session", status: 404 },
      ],
    })
    try {
      await waitForHome(page)
      await waitForMux(page)
      const result = await page.evaluate(async () => {
        const health = await fetch("/health")
        const system = await fetch("/api/v1/system")
        const systemBody = (await system.json()) as {
          homeDir?: string
          machineHostname?: string
        }
        const deepRoute = await fetch("/dev/example")
        const websocket = await new Promise<string>((resolve, reject) => {
          const protocol = location.protocol === "https:" ? "wss:" : "ws:"
          const socket = new WebSocket(`${protocol}//${location.host}/ws?since=0`)
          socket.addEventListener("open", () => socket.send("ping"))
          socket.addEventListener("message", event => {
            if (event.data === "pong") {
              socket.close()
              resolve("pong")
            }
          })
          socket.addEventListener("error", () => reject(new Error("WebSocket failed")))
        })
        const sessionGet = await fetch(
          `/api/v1/workspace-session?root=${encodeURIComponent(systemBody.homeDir ?? "/")}`,
        )
        return {
          health: health.status,
          system: system.status,
          homeDir: typeof systemBody.homeDir === "string",
          deepRoute: deepRoute.status,
          deepContentType: deepRoute.headers.get("content-type"),
          websocket,
          sessionGet: sessionGet.status,
        }
      })
      expect(result.health).toBe(200)
      expect(result.system).toBe(200)
      expect(result.homeDir).toBe(true)
      expect(result.deepRoute).toBe(200)
      expect(result.deepContentType).toContain("text/html")
      expect(result.websocket).toBe("pong")
      expect([200, 403, 404]).toContain(result.sessionGet)

      const assetUrl = await page.evaluate(() => {
        const script = document.querySelector<HTMLScriptElement>("script[src*='/assets/']")
        if (!script) throw new Error("hashed entry asset not found")
        return new URL(script.src, location.href).href
      })
      const brotli = await fetch(assetUrl, {
        headers: { "accept-encoding": "br, gzip" },
      })
      expect(brotli.status).toBe(200)
      expect(brotli.headers.get("content-encoding")).toBe("br")
      expect(brotli.headers.get("vary")).toContain("Accept-Encoding")
      expect(brotli.headers.get("cache-control")).toContain("immutable")
      await brotli.arrayBuffer()

      const gzip = await fetch(assetUrl, {
        headers: { "accept-encoding": "gzip" },
      })
      expect(gzip.status).toBe(200)
      expect(gzip.headers.get("content-encoding")).toBe("gzip")
      await gzip.arrayBuffer()

      const raw = await fetch(assetUrl, {
        headers: { "accept-encoding": "identity" },
      })
      expect(raw.status).toBe(200)
      expect(raw.headers.get("content-encoding")).toBeNull()
      await raw.arrayBuffer()
      await page.reload()
      await waitForMux(page)
      await testInfo.attach("mux-after-reload", {
        body: Buffer.from(await page.screenshot(), "base64"),
        contentType: "image/png",
      })
    } finally {
      await app.close()
    }
  })

  test("rejects removed agents:* host RPC without aborting the server", async () => {
    const { app, page } = await launchJet({
      expectedHttpErrors: [{ method: "POST", path: "/api/v1/rpc", status: 400 }],
    })
    try {
      await waitForHome(page)
      const result = await page.evaluate(async () => {
        const response = await fetch("/api/v1/rpc", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            channel: "agents:listAgents",
            args: [],
          }),
        })
        const health = await fetch("/health")
        return {
          rpcStatus: response.status,
          errorCode: (await response.json()).error?.code,
          healthStatus: health.status,
        }
      })

      expect(result).toEqual({
        rpcStatus: 400,
        errorCode: "UNKNOWN_OPERATION",
        healthStatus: 200,
      })
    } finally {
      await app.close()
    }
  })

  test("exposes the authoritative agent provider registry over host RPC", async () => {
    const { app, page } = await launchJet({ projectPage: true })
    try {
      const providers = await page.evaluate(async () => window.yaade!.agents!.listProviders(true))
      expect(providers).toHaveLength(5)
      expect(providers.map(provider => provider.provider).sort()).toEqual([
        "claude",
        "codex",
        "cursor",
        "grok",
        "opencode",
      ])
      for (const provider of providers) {
        expect(provider.binary).not.toBe("")
        expect(typeof provider.available).toBe("boolean")
        expect(provider.error === null || typeof provider.error === "string").toBeTruthy()
      }
    } finally {
      await app.close()
    }
  })

  test("supports atomic 16 MiB text-file writes while JSON RPC stays capped", async () => {
    const { app, page } = await launchJet({
      projectPage: true,
      expectedHttpErrors: [
        { method: "PUT", path: "/api/v1/fs/text-file", status: 409 },
        { method: "PUT", path: "/api/v1/fs/text-file", status: 413 },
        { method: "POST", path: "/api/v1/rpc", status: 413 },
      ],
    })
    try {
      const result = await page.evaluate(async () => {
        const workspacePath = window.__yaadeAgent!.listWorkspaces()[0]!.path
        const fsApi = window.yaade!.fs
        const uriFor = (name: string) =>
          encodeURI(`file://${workspacePath}/${name}`)

        const uri = uriFor("versioned-text-file.txt")
        const created = await fsApi.writeTextFile(uri, "first", { create: true })
        const firstRead = await fsApi.readTextFile(uri)
        const saved = await fsApi.writeTextFile(uri, "second", {
          expectedVersion: firstRead.version,
        })

        let conflict: { code?: string; status?: number } = {}
        try {
          await fsApi.writeTextFile(uri, "stale", {
            expectedVersion: firstRead.version,
          })
        } catch (error) {
          if (typeof error === "object" && error !== null) {
            conflict = {
              code: "code" in error && typeof error.code === "string" ? error.code : undefined,
              status:
                "status" in error && typeof error.status === "number"
                  ? error.status
                  : undefined,
            }
          }
        }
        const afterConflict = await fsApi.readTextFile(uri)

        const maxBytes = 16 * 1024 * 1024
        const boundary = await fsApi.writeTextFile(
          uriFor("boundary.txt"),
          "a".repeat(maxBytes),
          { create: true },
        )
        let overflow: { code?: string; status?: number } = {}
        try {
          await fsApi.writeTextFile(
            uriFor("overflow.txt"),
            "b".repeat(maxBytes + 1),
            { create: true },
          )
        } catch (error) {
          if (typeof error === "object" && error !== null) {
            overflow = {
              code: "code" in error && typeof error.code === "string" ? error.code : undefined,
              status:
                "status" in error && typeof error.status === "number"
                  ? error.status
                  : undefined,
            }
          }
        }

        const rpc = await fetch("/api/v1/rpc", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            channel: "fs:writeFile",
            args: [uriFor("rpc-too-large.txt"), "c".repeat(2 * 1024 * 1024)],
          }),
        })

        return {
          created,
          firstRead,
          saved,
          conflict,
          afterConflict,
          boundary,
          overflow,
          rpcStatus: rpc.status,
        }
      })

      expect(result.created.size).toBe(5)
      expect(result.firstRead.content).toBe("first")
      expect(result.saved.size).toBe(6)
      expect(result.saved.version).not.toBe(result.firstRead.version)
      expect(result.conflict).toEqual({ code: "FILE_CHANGED", status: 409 })
      expect(result.afterConflict.content).toBe("second")
      expect(result.boundary.size).toBe(16 * 1024 * 1024)
      expect(result.overflow).toEqual({ code: "PAYLOAD_TOO_LARGE", status: 413 })
      expect(result.rpcStatus).toBe(413)
    } finally {
      await app.close()
    }
  })
})
