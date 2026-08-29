import assert from "node:assert/strict"
import { describe, it } from "vite-plus/test"
import { resolveCurrentHostUrl } from "./client-environment.js"

describe("resolveCurrentHostUrl", () => {
  it("uses the serving origin in a browser", () => {
    assert.equal(
      resolveCurrentHostUrl({
        hostname: "yaade.example",
        origin: "https://yaade.example",
        protocol: "https:",
      }),
      "https://yaade.example",
    )
  })

  it("connects production Tauri clients to the local host", () => {
    assert.equal(
      resolveCurrentHostUrl({
        hostname: "localhost",
        origin: "tauri://localhost",
        protocol: "tauri:",
      }),
      "http://127.0.0.1:4747",
    )
    assert.equal(
      resolveCurrentHostUrl({
        hostname: "tauri.localhost",
        origin: "http://tauri.localhost",
        protocol: "http:",
      }),
      "http://127.0.0.1:4747",
    )
  })
})
