import { describe, it } from "vite-plus/test"
import assert from "node:assert/strict"
import { KeymapService, bind, createDefaultKeybindings } from "./keymaps.js"

describe("KeymapService registerUser cache invalidation", () => {
  const noop = () => {}

  it("registerUser populates user layer", () => {
    const keymaps = new KeymapService()
    assert.equal(keymaps.allBindings().length, 0)
    keymaps.registerUser(createDefaultKeybindings({ quickOpen: noop } as never))
    const keys = keymaps.allBindings().map(b => b.key)
    assert.ok(keys.includes("Cmd-p"))
  })

  it("stale memo without revision bump keeps empty cache", () => {
    const keymaps = new KeymapService()
    let revision = 0
    let cachedRevision = -1
    let cached = keymaps.allBindings()

    const getBindings = () => {
      if (cachedRevision !== revision) {
        cached = keymaps.allBindings()
        cachedRevision = revision
      }
      return cached
    }

    assert.equal(getBindings().length, 0)
    keymaps.registerUser(createDefaultKeybindings({ quickOpen: noop } as never))
    assert.equal(getBindings().length, 0)
  })

  it("revision bump after registerUser refreshes cached bindings", () => {
    const keymaps = new KeymapService()
    let revision = 0
    let cachedRevision = -1
    let cached = keymaps.allBindings()

    const getBindings = () => {
      if (cachedRevision !== revision) {
        cached = keymaps.allBindings()
        cachedRevision = revision
      }
      return cached
    }

    assert.equal(getBindings().length, 0)
    keymaps.registerUser(createDefaultKeybindings({ quickOpen: noop } as never))
    revision++
    const bindings = getBindings()
    assert.ok(bindings.length > 0)
    assert.ok(bindings.some(b => b.key === "Cmd-p"))
  })

  it("onDidChange fires when registerUser runs", () => {
    const keymaps = new KeymapService()
    let changes = 0
    const sub = keymaps.onDidChange.event(() => {
      changes++
    })
    keymaps.registerUser(createDefaultKeybindings({ quickOpen: noop } as never))
    assert.equal(changes, 1)
    sub.dispose()
  })

  it("extension layer precedes user layer in allBindings", () => {
    const keymaps = new KeymapService()
    keymaps.registerUser([bind("Cmd-p", noop)])
    keymaps.registerExtension([bind("Cmd-Shift-p", noop)])
    const keys = keymaps.allBindings().map(b => b.key)
    assert.deepEqual(keys.slice(0, 2), ["Cmd-Shift-p", "Cmd-p"])
  })
})
