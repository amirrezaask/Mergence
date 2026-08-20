import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import {
  decodeStoredServerDefinitions,
  normalizeServerDefinition,
} from "./multi-server.js"

test("normalizes and de-duplicates saved server definitions", () => {
  const servers = decodeStoredServerDefinitions([
    { id: "srv-one", name: "One", url: "https://one.example/" },
    { id: "srv-two", name: "Two", url: "https://one.example" },
    { id: "srv-one", name: "Duplicate", url: "https://two.example" },
    { id: "bad id", name: "Invalid", url: "https://invalid.example" },
    { id: "srv-three", name: "Three", url: "ftp://three.example" },
  ])

  assert.deepEqual(servers, [
    { id: "srv-one", name: "One", url: "https://one.example" },
  ])
})

test("requires a stable id and rejects embedded credentials", () => {
  assert.equal(normalizeServerDefinition({ name: "One", url: "https://one.example" }), null)
  assert.equal(
    normalizeServerDefinition({
      id: "srv-one",
      name: "One",
      url: "https://user:pass@one.example",
    }),
    null,
  )
  assert.deepEqual(
    normalizeServerDefinition({
      id: "srv-one",
      name: "One",
      url: "https://one.example/",
      token: " secret ",
    }),
    {
      id: "srv-one",
      name: "One",
      url: "https://one.example",
      token: "secret",
    },
  )
})
