import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import { RadScrollController, type RadScrollFrameCallback } from "./rad-scroll.js"

function harness(reduced = false) {
  let value = 0
  let nextId = 1
  const frames = new Map<number, RadScrollFrameCallback>()
  const writes: number[] = []
  const controller = new RadScrollController({
    read: () => value,
    write: next => {
      value = next
      writes.push(next)
    },
    max: () => 1_000,
    reducedMotion: () => reduced,
    requestFrame: callback => {
      const id = nextId++
      frames.set(id, callback)
      return id
    },
    cancelFrame: id => {
      frames.delete(id)
    },
  })
  const step = (time: number) => {
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach(callback => callback(time))
  }
  return { controller, frames, writes, step, value: () => value }
}

test("retargets without overshoot and stops scheduling at the target", () => {
  const h = harness()
  h.controller.setTarget(400)
  for (let frame = 0; frame < 120 && h.frames.size; frame++) h.step(frame * (1_000 / 120))
  assert.equal(h.value(), 400)
  assert.equal(h.frames.size, 0)
  assert.ok(h.writes.length > 2)
  assert.ok(h.writes.every((value, index) => index === 0 || value >= h.writes[index - 1]!))

  h.controller.pushDelta(-250)
  h.step(1_100)
  assert.ok(h.value() < 400)
  for (let frame = 1; frame < 120 && h.frames.size; frame++) h.step(1_100 + frame * (1_000 / 120))
  assert.equal(h.value(), 150)
  assert.equal(h.frames.size, 0)
})

test("clamps targets and synchronizes external scroll changes", () => {
  const h = harness()
  h.controller.setTarget(2_000)
  for (let frame = 0; frame < 120 && h.frames.size; frame++) h.step(frame * 16.67)
  assert.equal(h.value(), 1_000)
  h.controller.setTarget(500)
  assert.equal(h.frames.size, 1)
  h.controller.sync(80)
  assert.equal(h.controller.current, 80)
  assert.equal(h.controller.target, 80)
  assert.equal(h.frames.size, 0)
})

test("reduced motion snaps without requesting a frame", () => {
  const h = harness(true)
  h.controller.setTarget(320)
  assert.equal(h.value(), 320)
  assert.equal(h.frames.size, 0)
  assert.deepEqual(h.writes, [320])
})
