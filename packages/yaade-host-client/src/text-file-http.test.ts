import assert from "node:assert/strict"
import { describe, it } from "vite-plus/test"
import {
  TextFileHttpError,
  readTextFileHttp,
  writeTextFileHttp,
} from "./text-file-http.js"

describe("versioned text-file HTTP client", () => {
  it("reads raw UTF-8 content and version headers", async () => {
    let requested = ""
    const result = await readTextFileHttp("file:///tmp/hello world.ts", {
      fetcher: async input => {
        requested = String(input)
        return new Response("hello 🌙", {
          status: 200,
          headers: {
            "x-yaade-file-version": "100:10",
            "x-yaade-file-size": "10",
          },
        })
      },
    })
    assert.match(requested, /^\/api\/v1\/fs\/text-file\?uri=/)
    assert.match(requested, /hello\+world\.ts/)
    assert.deepEqual(result, {
      content: "hello 🌙",
      version: "100:10",
      size: 10,
    })
  })

  it("writes document text as a raw body instead of JSON", async () => {
    const content = "x".repeat(2 * 1024 * 1024 + 1)
    let requested = ""
    let requestBody: BodyInit | null | undefined
    const result = await writeTextFileHttp(
      "file:///tmp/large.ts",
      content,
      { expectedVersion: "10:1" },
      {
        fetcher: async (input, init) => {
          requested = String(input)
          requestBody = init?.body
          return new Response(null, {
            status: 200,
            headers: {
              "x-yaade-file-version": "20:2097153",
              "x-yaade-file-size": "2097153",
            },
          })
        },
      },
    )
    assert.equal(requestBody, content)
    assert.match(requested, /expectedVersion=10%3A1/)
    assert.deepEqual(result, { version: "20:2097153", size: 2_097_153 })
  })

  it("preserves FILE_CHANGED status and details", async () => {
    await assert.rejects(
      () =>
        writeTextFileHttp("file:///tmp/a.ts", "next", { create: true }, {
          fetcher: async () =>
            new Response(
              JSON.stringify({
                error: {
                  code: "FILE_CHANGED",
                  message: "file already exists",
                  details: { actualVersion: "30:4" },
                },
              }),
              { status: 409 },
            ),
        }),
      error => {
        assert.ok(error instanceof TextFileHttpError)
        assert.equal(error.code, "FILE_CHANGED")
        assert.equal(error.status, 409)
        assert.deepEqual(error.details, { actualVersion: "30:4" })
        return true
      },
    )
  })

  it("rejects malformed success metadata", async () => {
    await assert.rejects(
      () =>
        readTextFileHttp("file:///tmp/a.ts", {
          fetcher: async () => new Response("text", { status: 200 }),
        }),
      /invalid text file response headers/,
    )
  })
})
