import assert from "node:assert/strict"
import { describe, it } from "vite-plus/test"
import {
  getFsReadDiagnostics,
  readFileWithDiagnostics,
  readTextFileWithDiagnostics,
} from "./fs-read-diagnostics.js"

describe("fs read diagnostics", () => {
  it("stays dormant until observed, then records cumulative reads and bytes", async () => {
    await readFileWithDiagnostics("file:///before.txt", async () => "not counted")
    const baseline = getFsReadDiagnostics()
    assert.equal(baseline.totalCount, 0)

    await readFileWithDiagnostics("file:///moon.txt", async () => "a🌙")
    await readTextFileWithDiagnostics("file:///text.txt", async () => ({
      content: "text",
      version: "1:4",
      size: 4,
    }))
    await assert.rejects(() =>
      readFileWithDiagnostics("file:///missing.txt", async () => {
        throw new Error("missing")
      }),
    )

    const snapshot = getFsReadDiagnostics()
    assert.equal(snapshot.totalCount, 3)
    assert.equal(snapshot.totalBytes, 9)
    assert.equal(snapshot.errorCount, 1)
    assert.equal(snapshot.inFlightCount, 0)
    assert.deepEqual(
      snapshot.byUri.map(entry => ({
        uri: entry.uri,
        count: entry.count,
        bytes: entry.bytes,
        errorCount: entry.errorCount,
      })),
      [
        { uri: "file:///missing.txt", count: 1, bytes: 0, errorCount: 1 },
        { uri: "file:///moon.txt", count: 1, bytes: 5, errorCount: 0 },
        { uri: "file:///text.txt", count: 1, bytes: 4, errorCount: 0 },
      ],
    )
  })
})
