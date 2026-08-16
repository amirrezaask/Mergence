#!/usr/bin/env node
/**
 * Extract macOS default keybindings from .vscode reference source.
 * Output: packages/yaade-workspace/data/vscode-mac-keybindings.json
 */
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises"
import { join, relative } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = join(fileURLToPath(import.meta.url), "..", "..")
const SRC_DIRS = [
  join(ROOT, ".vscode/src/vs/editor"),
  join(ROOT, ".vscode/src/vs/workbench"),
]
const EXTENSIONS_DIR = join(ROOT, ".vscode/extensions")
const OUT_DIR = join(ROOT, "packages/yaade-workspace/data")
const OUT_FILE = join(OUT_DIR, "vscode-mac-keybindings.json")

const WEIGHT_MAP = {
  EditorCore: 0,
  EditorContrib: 100,
  WorkbenchContrib: 200,
  SessionsContrib: 250,
  BuiltinExtension: 300,
  ExternalExtension: 400,
}

const KEY_CODE_MAP = {
  KeyA: "a", KeyB: "b", KeyC: "c", KeyD: "d", KeyE: "e", KeyF: "f", KeyG: "g",
  KeyH: "h", KeyI: "i", KeyJ: "j", KeyK: "k", KeyL: "l", KeyM: "m", KeyN: "n",
  KeyO: "o", KeyP: "p", KeyQ: "q", KeyR: "r", KeyS: "s", KeyT: "t", KeyU: "u",
  KeyV: "v", KeyW: "w", KeyX: "x", KeyY: "y", KeyZ: "z",
  Digit0: "0", Digit1: "1", Digit2: "2", Digit3: "3", Digit4: "4",
  Digit5: "5", Digit6: "6", Digit7: "7", Digit8: "8", Digit9: "9",
  F1: "F1", F2: "F2", F3: "F3", F4: "F4", F5: "F5", F6: "F6",
  F7: "F7", F8: "F8", F9: "F9", F10: "F10", F11: "F11", F12: "F12",
  Backquote: "`", Backspace: "Backspace", Tab: "Tab", Enter: "Enter",
  Escape: "Escape", Space: "Space", Delete: "Delete", Insert: "Insert",
  Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  UpArrow: "ArrowUp", DownArrow: "ArrowDown", LeftArrow: "ArrowLeft", RightArrow: "ArrowRight",
  Semicolon: ";", Equal: "=", Comma: ",", Period: ".", Slash: "/",
  BracketLeft: "[", BracketRight: "]", Minus: "-", Quote: "'",
}

/** @param {string} expr */
function decodeKeyExpr(expr) {
  if (!expr || expr.trim() === "0" || expr.trim() === "undefined") return null

  const chordMatch = expr.match(/KeyChord\s*\(\s*([^,]+),\s*([^)]+)\)/)
  if (chordMatch) {
    const first = decodeKeyExpr(chordMatch[1])
    const second = decodeKeyExpr(chordMatch[2])
    if (!first || !second) return null
    return `${first} ${second}`
  }

  const mods = []
  let key = null
  const tokens = expr.split("|").map(t => t.trim())
  for (const token of tokens) {
    if (token.includes("KeyMod.CtrlCmd")) mods.push("cmd")
    else if (token.includes("KeyMod.WinCtrl")) mods.push("ctrl")
    else if (token.includes("KeyMod.Alt")) mods.push("alt")
    else if (token.includes("KeyMod.Shift")) mods.push("shift")
    else {
      for (const [code, name] of Object.entries(KEY_CODE_MAP)) {
        if (token.includes(`KeyCode.${code}`)) {
          key = name
          break
        }
      }
    }
  }
  if (!key) return null
  const modStr = mods.length ? `${mods.join("+")}+` : ""
  return `${modStr}${key}`
}

/** @param {string} keyStr e.g. cmd+shift+p or cmd+k cmd+o */
export function parseVscodeKeyString(keyStr) {
  return keyStr
    .trim()
    .split(/\s+/)
    .map(part => {
      const segs = part.split("+").filter(Boolean)
      const key = segs.pop()
      const mods = segs.map(m => {
        if (m === "cmd") return "cmd"
        if (m === "ctrl") return "ctrl"
        if (m === "alt") return "alt"
        if (m === "shift") return "shift"
        return m
      })
      const modStr = mods.length ? `${mods.join("+")}+` : ""
      return `${modStr}${key}`
    })
    .join(" ")
}

/** Normalize vscode extract format to Yaade key string (Cmd-p style). */
export function vscodeKeyToJetKey(vscodeKey) {
  return vscodeKey
    .split(/\s+/)
    .map(part => {
      const segs = part.split("+").filter(Boolean)
      const key = segs.pop()
      const mods = segs.map(m => {
        if (m === "cmd") return "Cmd"
        if (m === "ctrl") return "Ctrl"
        if (m === "alt") return "Alt"
        if (m === "shift") return "Shift"
        return m
      })
      const keyName = key === "`" ? "`" : key && key.length === 1 ? key.toLowerCase() : key
      if (mods.length === 0) return keyName
      return `${mods.join("-")}-${keyName}`
    })
    .join(" ")
}

/** @param {string} block */
function extractWeight(block) {
  const match = block.match(/weight\s*:\s*KeybindingWeight\.(\w+)/)
  if (!match) return 100
  return WEIGHT_MAP[match[1]] ?? 100
}

/** @param {string} block */
function extractMacKeysFromBlock(block) {
  const weight = extractWeight(block)
  const keys = []

  const macBlock = block.match(/mac\s*:\s*\{([\s\S]*?)\}/)
  if (macBlock) {
    const mac = macBlock[1]
    const primary = mac.match(/primary\s*:\s*([^,\n}]+)/)
    if (primary) {
      const decoded = decodeKeyExpr(primary[1])
      if (decoded) keys.push(decoded)
    }
    const secondary = mac.match(/secondary\s*:\s*\[([^\]]+)\]/)
    if (secondary) {
      for (const part of secondary[1].split(",")) {
        const decoded = decodeKeyExpr(part.trim())
        if (decoded) keys.push(decoded)
      }
    }
  }

  if (keys.length === 0) {
    const primary = block.match(/primary\s*:\s*([^,\n}]+)/)
    if (primary) {
      const decoded = decodeKeyExpr(primary[1])
      if (decoded) keys.push(decoded)
    }
    const secondary = block.match(/secondary\s*:\s*\[([^\]]+)\]/)
    if (secondary) {
      for (const part of secondary[1].split(",")) {
        const decoded = decodeKeyExpr(part.trim())
        if (decoded) keys.push(decoded)
      }
    }
  }

  return keys.map(key => ({ key, weight }))
}

/** @param {string} content @param {string} filePath */
function extractAction2Bindings(content, filePath) {
  const results = []
  const rel = relative(ROOT, filePath)
  const actionRe = /super\s*\(\s*\{([\s\S]*?)\}\s*\)/g
  for (const match of content.matchAll(actionRe)) {
    const block = match[1]
    const idMatch = block.match(/\bid\s*:\s*['"]([^'"]+)['"]/)
    if (!idMatch) continue
    const keybindingMatch = block.match(/keybinding\s*:\s*\{([\s\S]*?)\}/)
    if (!keybindingMatch) continue
    for (const { key, weight } of extractMacKeysFromBlock(keybindingMatch[0])) {
      results.push({ commandId: idMatch[1], key, weight, sourceFile: rel })
    }
  }
  return results
}

/** @param {string} content @param {string} filePath */
function extractFromFile(content, filePath) {
  const results = []
  const rel = relative(ROOT, filePath)

  const ruleRe = /registerCommandAndKeybindingRule\s*\(\s*\{([\s\S]*?)\}\s*\)/g
  for (const match of content.matchAll(ruleRe)) {
    const block = match[1]
    const idMatch = block.match(/\bid\s*:\s*['"]([^'"]+)['"]/)
    if (!idMatch) continue
    for (const { key, weight } of extractMacKeysFromBlock(block)) {
      results.push({ commandId: idMatch[1], key, weight, sourceFile: rel })
    }
  }

  const kbOptsRe = /kbOpts\s*:\s*\{([\s\S]*?)\}(?=\s*[,}])/g
  for (const match of content.matchAll(kbOptsRe)) {
    const block = match[1]
    const before = content.slice(0, match.index)
    const idMatch =
      before.match(/\bid\s*:\s*['"]([^'"]+)['"]\s*,?\s*$/m) ??
      before.match(/static readonly ID = ['"]([^'"]+)['"]/)
    if (!idMatch) continue
    for (const { key, weight } of extractMacKeysFromBlock(block)) {
      results.push({ commandId: idMatch[1], key, weight, sourceFile: rel })
    }
  }

  const keybindingRe = /keybinding\s*:\s*\{([\s\S]*?)\}/g
  for (const match of content.matchAll(keybindingRe)) {
    const before = content.slice(Math.max(0, match.index - 600), match.index)
    const idMatch =
      before.match(/\bid\s*:\s*['"]([^'"]+)['"]\s*,?\s*$/m) ??
      before.match(/openCommandActionDescriptor\s*:\s*\{[\s\S]*?\bid\s*:\s*['"]([^'"]+)['"]/)
    if (!idMatch) continue
    for (const { key, weight } of extractMacKeysFromBlock(match[0])) {
      results.push({ commandId: idMatch[1], key, weight, sourceFile: rel })
    }
  }

  const keybindingsRe = /keybindings\s*:\s*\{([\s\S]*?)\}/g
  for (const match of content.matchAll(keybindingsRe)) {
    const before = content.slice(Math.max(0, match.index - 600), match.index)
    const idMatch = before.match(/\bid\s*:\s*['"]([^'"]+)['"]\s*,?\s*$/m)
    if (!idMatch) continue
    for (const { key, weight } of extractMacKeysFromBlock(match[0])) {
      results.push({ commandId: idMatch[1], key, weight, sourceFile: rel })
    }
  }

  results.push(...extractAction2Bindings(content, filePath))
  return results
}

/** @param {string} dir */
async function walkTs(dir) {
  const files = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "test") continue
      files.push(...(await walkTs(full)))
    } else if (entry.name.endsWith(".ts")) {
      files.push(full)
    }
  }
  return files
}

/** @param {string} dir */
async function extractExtensionKeybindings(dir) {
  const results = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return results
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const pkgPath = join(dir, entry.name, "package.json")
    try {
      const raw = await readFile(pkgPath, "utf8")
      const pkg = JSON.parse(raw)
      const bindings = pkg.contributes?.keybindings
      if (!Array.isArray(bindings)) continue
      for (const binding of bindings) {
        const macKey = binding.mac ?? binding.key
        if (!macKey || !binding.command) continue
        const key = parseVscodeKeyString(macKey.replace(/\s+/g, " "))
        results.push({
          commandId: binding.command,
          key,
          weight: WEIGHT_MAP.ExternalExtension,
          sourceFile: relative(ROOT, pkgPath),
        })
      }
    } catch {
      // skip invalid extension package.json
    }
  }
  return results
}

async function main() {
  const all = []
  for (const dir of SRC_DIRS) {
    for (const file of await walkTs(dir)) {
      const content = await readFile(file, "utf8")
      all.push(...extractFromFile(content, file))
    }
  }
  all.push(...(await extractExtensionKeybindings(EXTENSIONS_DIR)))

  const seen = new Set()
  const deduped = []
  for (const entry of all) {
    const jetKey = vscodeKeyToJetKey(entry.key)
    const sig = `${entry.commandId}\0${jetKey}`
    if (seen.has(sig)) continue
    seen.add(sig)
    deduped.push({ ...entry, jetKey })
  }

  deduped.sort((a, b) => {
    if (a.commandId !== b.commandId) return a.commandId.localeCompare(b.commandId)
    return b.weight - a.weight
  })

  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(OUT_FILE, `${JSON.stringify(deduped, null, 2)}\n`)
  console.log(
    `Wrote ${deduped.length} macOS keybindings (${new Set(deduped.map(e => e.commandId)).size} commands) to ${relative(ROOT, OUT_FILE)}`,
  )
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
