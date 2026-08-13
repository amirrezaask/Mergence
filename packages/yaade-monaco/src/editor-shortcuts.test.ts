import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  interceptPrimaryQuickOpenShortcut,
  interceptPrimarySaveShortcut,
  isPrimaryCommandPaletteShortcut,
  isPrimaryQuickOpenShortcut,
  isPrimarySaveShortcut,
} from "./editor-shortcuts.js"

function keyEvent(
  overrides: Partial<Parameters<typeof isPrimaryQuickOpenShortcut>[0]> = {},
) {
  return {
    key: "p",
    code: "KeyP",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  }
}

describe("isPrimaryQuickOpenShortcut", () => {
  it("matches Cmd+P on macOS and Ctrl+P elsewhere", () => {
    assert.equal(
      isPrimaryQuickOpenShortcut(keyEvent({ metaKey: true }), "MacIntel"),
      true,
    )
    assert.equal(
      isPrimaryQuickOpenShortcut(keyEvent({ ctrlKey: true }), "Linux x86_64"),
      true,
    )
  })

  it("matches Cmd+Shift+P for the command palette on macOS", () => {
    assert.equal(
      isPrimaryCommandPaletteShortcut(
        keyEvent({ metaKey: true, shiftKey: true }),
        "MacIntel",
      ),
      true,
    )
    assert.equal(
      isPrimaryCommandPaletteShortcut(keyEvent({ metaKey: true }), "MacIntel"),
      false,
    )
  })

  it("matches and intercepts the platform save shortcut", () => {
    const mac = keyEvent({ key: "s", code: "KeyS", metaKey: true })
    const linux = keyEvent({ key: "s", code: "KeyS", ctrlKey: true })
    assert.equal(isPrimarySaveShortcut(mac, "MacIntel"), true)
    assert.equal(isPrimarySaveShortcut(linux, "Linux x86_64"), true)
    assert.equal(
      isPrimarySaveShortcut({ ...mac, shiftKey: true }, "MacIntel"),
      false,
    )

    let saved = 0
    assert.equal(
      interceptPrimarySaveShortcut(
        {
          ...mac,
          repeat: false,
          preventDefault: () => {},
          stopPropagation: () => {},
        },
        "MacIntel",
        () => {
          saved += 1
        },
      ),
      true,
    )
    assert.equal(saved, 1)
  })

  it("does not treat cross-platform modifiers as Quick Open", () => {
    assert.equal(
      isPrimaryQuickOpenShortcut(keyEvent({ ctrlKey: true }), "MacIntel"),
      false,
    )
    assert.equal(
      isPrimaryQuickOpenShortcut(keyEvent({ metaKey: true }), "Linux x86_64"),
      false,
    )
    assert.equal(
      isPrimaryQuickOpenShortcut(
        keyEvent({ ctrlKey: true, altKey: true }),
        "Linux x86_64",
      ),
      false,
    )
  })

  it("intercepts only the exact shortcut and invokes Quick Open once", () => {
    let prevented = 0
    let stopped = 0
    let opened = 0
    const event = {
      ...keyEvent({ metaKey: true }),
      repeat: false,
      preventDefault: () => {
        prevented += 1
      },
      stopPropagation: () => {
        stopped += 1
      },
    }

    assert.equal(
      interceptPrimaryQuickOpenShortcut(event, "MacIntel", () => {
        opened += 1
      }),
      true,
    )
    assert.deepEqual({ prevented, stopped, opened }, {
      prevented: 1,
      stopped: 1,
      opened: 1,
    })

    assert.equal(
      interceptPrimaryQuickOpenShortcut(
        { ...event, shiftKey: true },
        "MacIntel",
        () => {
          opened += 1
        },
      ),
      false,
    )
    assert.deepEqual({ prevented, stopped, opened }, {
      prevented: 1,
      stopped: 1,
      opened: 1,
    })
  })

  it("consumes key repeat without opening another overlay", () => {
    let opened = 0
    let prevented = false
    const handled = interceptPrimaryQuickOpenShortcut(
      {
        ...keyEvent({ metaKey: true }),
        repeat: true,
        preventDefault: () => {
          prevented = true
        },
        stopPropagation: () => {},
      },
      "MacIntel",
      () => {
        opened += 1
      },
    )

    assert.equal(handled, true)
    assert.equal(prevented, true)
    assert.equal(opened, 0)
  })
})
