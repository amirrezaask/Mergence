#!/usr/bin/env node
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(fileURLToPath(import.meta.url), "..", "..")
const DEFAULTS_FILE = join(ROOT, "packages/yaade-workspace/src/default-keybindings.ts")
const MAP_FILE = join(ROOT, "packages/yaade-workspace/data/jet-vscode-command-map.json")

const YAADE_COMMAND_KEY = {
  "workspace.quickOpen": "quickOpen",
  "ui.showCommandPalette": "palette",
  "workspace.saveFile": "save",
  "workspace.openFile": "openFile",
  "workspace.openFolder": "openFolder",
  "layout.closeTab": "closeTab",
  "editor.find": "find",
  "editor.replace": "replace",
  "editor.gotoLine": "gotoLine",
  "search.show": "search",
  "git.showChanges": "git",
  "explorer.show": "explorer",
  "terminal.show": "terminal",
  "problems.show": "problems",
}

async function main() {
  const src = await readFile(DEFAULTS_FILE, "utf8")
  const map = JSON.parse(await readFile(MAP_FILE, "utf8"))
  let failed = false

  for (const row of map) {
    const fn = YAADE_COMMAND_KEY[row.yaade] ?? row.yaade.split(".").pop()
    const pattern = new RegExp(
      `^\\s*bind\\(${JSON.stringify(row.key)}, cmd\\.${fn}\\b`,
      "m",
    )
    if (!pattern.test(src)) {
      console.error(
        `MISSING active bind(${row.key}, cmd.${fn}) for ${row.vscode} — run vp run extract:vscode-keybindings`,
      )
      failed = true
    }
  }

  if (!/^\s*bind\("Cmd-n", cmd\.newFile\b/m.test(src)) {
    console.error("MISSING active bind(Cmd-n, cmd.newFile) — run vp run extract:vscode-keybindings")
    failed = true
  }

  const activeCount = (src.match(/^\s*bind\(/gm) ?? []).length
  const todoCount = (src.match(/^\s*\/\/ TODO: bind\(/gm) ?? []).length
  console.log(
    `default-keybindings.ts: ${activeCount} active bind(), ${todoCount} TODO comments, ${map.length} implemented mappings checked`,
  )

  if (failed) process.exit(1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
