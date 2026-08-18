#!/usr/bin/env node
/** Fix node-pty macOS spawn-helper missing +x (pnpm + node-pty@1.1.0 packaging bug). */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"

function fixSpawnHelpers(ptyRoot) {
  const prebuilds = path.join(ptyRoot, "prebuilds")
  if (!fs.existsSync(prebuilds)) return 0
  let fixed = 0
  for (const platform of fs.readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, platform, "spawn-helper")
    if (!fs.existsSync(helper)) continue
    const mode = fs.statSync(helper).mode & 0o777
    if (mode === 0o755) continue
    fs.chmodSync(helper, 0o755)
    fixed += 1
  }
  return fixed
}

function resolvePtyRoot(fromDir) {
  const require = createRequire(path.join(fromDir, "package.json"))
  return path.dirname(require.resolve("node-pty/package.json"))
}

try {
  const arg = process.argv[2]
  let ptyRoot
  if (arg) {
    const resolved = path.resolve(arg)
    const asPkg = path.join(resolved, "package.json")
    if (fs.existsSync(asPkg)) {
      ptyRoot = resolvePtyRoot(resolved)
    } else if (fs.existsSync(path.join(resolved, "prebuilds"))) {
      ptyRoot = resolved
    } else {
      ptyRoot = resolvePtyRoot(resolved)
    }
  } else {
    ptyRoot = resolvePtyRoot(path.dirname(fileURLToPath(import.meta.url)))
  }
  const fixed = fixSpawnHelpers(ptyRoot)
  if (fixed > 0 && process.env.YAADE_FIX_NODE_PTY_VERBOSE === "1") {
    console.log(`[fix-node-pty-perms] chmod +x on ${fixed} spawn-helper(s) under ${ptyRoot}`)
  }
} catch (error) {
  console.warn(
    `[fix-node-pty-perms] skipped: ${error instanceof Error ? error.message : String(error)}`,
  )
}
