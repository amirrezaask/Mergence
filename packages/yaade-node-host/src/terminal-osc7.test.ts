import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import {
  applyShellCwdReporting,
  parseOsc7Cwd,
} from "./terminal-osc7.js"

test("parseOsc7Cwd extracts file URI paths", () => {
  assert.equal(
    parseOsc7Cwd("\x1b]7;file:///tmp/proj\x07"),
    "/tmp/proj",
  )
  assert.equal(
    parseOsc7Cwd("noise\x1b]7;file://host/Users/me/work\x1b\\more"),
    "/Users/me/work",
  )
  assert.equal(parseOsc7Cwd("no osc here"), null)
})

test("fish shells emit an OSC 7 prompt event without polling", () => {
  const wrapped = applyShellCwdReporting("fish", [], {})
  assert.equal(wrapped.args[0], "--init-command")
  assert.match(wrapped.args[1] ?? "", /--on-event fish_prompt/)
})
