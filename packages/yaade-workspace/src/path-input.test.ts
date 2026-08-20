import { describe, it } from "vite-plus/test"
import assert from "node:assert/strict"
import {
  applyPathCompletion,
  deletePathSegmentBackward,
  expandHomePath,
  parsePathCompletionContext,
  resolvePathForOpen,
} from "./path-input.js"

const HOME = "/Users/test"

describe("parsePathCompletionContext", () => {
  it("parses absolute path at end", () => {
    const input = "/Users/amir/dev/jet"
    const ctx = parsePathCompletionContext(input, input.length, HOME)
    assert.equal(ctx.parentPath, "/Users/amir/dev")
    assert.equal(ctx.partial, "jet")
    assert.equal(ctx.segmentStart, 16)
    assert.equal(ctx.segmentEnd, input.length)
  })

  it("parses cursor mid-segment", () => {
    const input = "/Users/amir/dev"
    const ctx = parsePathCompletionContext(input, 10, HOME)
    assert.equal(ctx.parentPath, "/Users")
    assert.equal(ctx.partial, "ami")
    assert.equal(ctx.segmentStart, 7)
    assert.equal(ctx.segmentEnd, 10)
  })

  it("parses trailing slash as empty partial", () => {
    const input = "/Users/foo/"
    const ctx = parsePathCompletionContext(input, input.length, HOME)
    assert.equal(ctx.parentPath, "/Users/foo")
    assert.equal(ctx.partial, "")
  })

  it("expands tilde parent", () => {
    const input = "~/dev/jet"
    const ctx = parsePathCompletionContext(input, input.length, HOME)
    assert.equal(ctx.parentPath, "/Users/test/dev")
    assert.equal(ctx.partial, "jet")
  })

  it("lists home for bare tilde slash", () => {
    const input = "~/"
    const ctx = parsePathCompletionContext(input, input.length, HOME)
    assert.equal(ctx.parentPath, HOME)
    assert.equal(ctx.partial, "")
  })

  it("lists root children for leading slash only segment", () => {
    const input = "/Us"
    const ctx = parsePathCompletionContext(input, input.length, HOME)
    assert.equal(ctx.parentPath, "/")
    assert.equal(ctx.partial, "Us")
  })
})

describe("applyPathCompletion", () => {
  it("replaces partial segment and appends slash", () => {
    const input = "/Users/am"
    const ctx = parsePathCompletionContext(input, input.length, HOME)
    const { value, cursor } = applyPathCompletion(input, ctx, "amirrezaask")
    assert.equal(value, "/Users/amirrezaask/")
    assert.equal(cursor, "/Users/amirrezaask/".length)
  })
})

describe("deletePathSegmentBackward", () => {
  it("deletes last segment", () => {
    const input = "/Users/foo/bar"
    const result = deletePathSegmentBackward(input, input.length, input.length)
    assert.deepEqual(result, { value: "/Users/foo/", cursor: 11 })
  })

  it("deletes segment when cursor after trailing slash", () => {
    const input = "/Users/foo/"
    const result = deletePathSegmentBackward(input, input.length, input.length)
    assert.deepEqual(result, { value: "/Users/", cursor: 7 })
  })

  it("returns null for collapsed selection at root segment", () => {
    assert.equal(deletePathSegmentBackward("/", 1, 1), null)
  })

  it("returns null when selection is not collapsed", () => {
    assert.equal(deletePathSegmentBackward("/Users/foo", 1, 5), null)
  })
})

describe("expandHomePath", () => {
  it("expands tilde forms", () => {
    assert.equal(expandHomePath("~", HOME), HOME)
    assert.equal(expandHomePath("~/dev", HOME), "/Users/test/dev")
    assert.equal(expandHomePath("/abs", HOME), "/abs")
  })
})

describe("resolvePathForOpen", () => {
  it("trims trailing slashes and expands home", () => {
    assert.equal(resolvePathForOpen("~/dev/", HOME), "/Users/test/dev")
  })

  it("keeps root path as / instead of collapsing to empty string", () => {
    assert.equal(resolvePathForOpen("/", HOME), "/")
  })
})
