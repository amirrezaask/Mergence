import assert from "node:assert/strict"
import { describe, it } from "vite-plus/test"
import { isDesktopClient, resolveCurrentHostUrl } from "./client-environment.js"

describe("client environment", () => {
  it("distinguishes browser and desktop locations", () => {
    assert.equal(
      isDesktopClient({
        hostname: "yaade.example",
        origin: "https://yaade.example",
        protocol: "https:",
      }),
      false,
    )
    assert.equal(
      isDesktopClient({
        hostname: "tauri.localhost",
        origin: "http://tauri.localhost",
        protocol: "http:",
      }),
      true,
    )
  })

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
      "http://127.0.0.1:7774",
    )
    assert.equal(
      resolveCurrentHostUrl({
        hostname: "tauri.localhost",
        origin: "http://tauri.localhost",
        protocol: "http:",
      }),
      "http://127.0.0.1:7774",
    )
  })
})
