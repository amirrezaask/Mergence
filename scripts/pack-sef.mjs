#!/usr/bin/env node
/**
 * Pack a staged runtime directory into a self-extracting single-file binary.
 *
 * Usage: node scripts/pack-sef.mjs <runtimeDir> <outfile>
 *
 * The resulting file extracts to ~/.cache/yaade/<hash>/ on first run, then
 * execs the inner `yaade` launcher (SPA + host API).
 */
import { spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

function die(msg) {
  console.error(msg)
  process.exit(1)
}

/** Count newline-terminated lines in a UTF-8 script that ends with `\n`. */
function countLines(text) {
  if (!text.endsWith("\n")) throw new Error("stub must end with newline")
  return text.split("\n").length - 1
}

/**
 * @param {string} runtimeDir
 * @param {string} outfile
 */
export function packSelfExtracting(runtimeDir, outfile) {
  const resolved = path.resolve(runtimeDir)
  const launcher = path.join(resolved, "yaade")
  if (!fs.existsSync(launcher)) {
    die(`Runtime launcher missing: ${launcher}`)
  }
  if (!fs.existsSync(path.join(resolved, "web", "index.html"))) {
    die(`Runtime SPA missing under ${resolved}/web`)
  }
  if (!fs.existsSync(path.join(resolved, "backend", "host-server.mjs"))) {
    die(`Runtime host-server.mjs missing under ${resolved}/backend`)
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-sef-"))
  const tarball = path.join(tmpDir, "runtime.tar.gz")
  try {
    // COPYFILE_DISABLE avoids macOS AppleDouble (._*) junk in the archive.
    const tarEnv = { ...process.env, COPYFILE_DISABLE: "1" }
    const tarResult = spawnSync("tar", ["-czf", tarball, "-C", resolved, "."], {
      cwd: process.cwd(),
      stdio: "inherit",
      env: tarEnv,
    })
    if (tarResult.status !== 0) process.exit(tarResult.status ?? 1)
    const archive = fs.readFileSync(tarball)
    const hash = crypto.createHash("sha256").update(archive).digest("hex").slice(0, 16)

    // Do NOT zero-pad LINES — `$((00000025 + 1))` is octal in sh (→ wrong offset).
    // Placeholder width is irrelevant: substitution stays on one line either way.
    const stubTemplate = `#!/bin/sh
# YAADE self-extracting server — extracts once, then runs the host + SPA.
set -eu
HASH="${hash}"
LINES=XXXXXXXX
SELF="$0"
case "$SELF" in
  /*) ;;
  *) SELF="$(pwd)/$SELF" ;;
esac
CACHE="\${XDG_CACHE_HOME:-$HOME/.cache}/yaade/$HASH"
READY="$CACHE/.ready"
if [ ! -f "$READY" ]; then
  TMP="$CACHE.tmp.$$"
  rm -rf "$TMP"
  mkdir -p "$TMP"
  tail -n +"$((LINES + 1))" "$SELF" | tar -xzf - -C "$TMP"
  rm -rf "$CACHE"
  mv "$TMP" "$CACHE"
  chmod +x "$CACHE/yaade" 2>/dev/null || true
  if [ -x "$CACHE/node/bin/node" ]; then chmod +x "$CACHE/node/bin/node"; fi
  find "$CACHE/backend/node_modules/node-pty" -name 'spawn-helper' -exec chmod +x {} + 2>/dev/null || true
  find "$CACHE/backend/node_modules/@vscode" -path '*/bin/rg' -exec chmod +x {} + 2>/dev/null || true
  find "$CACHE/backend/node_modules/@vscode" -path '*/bin/rg.exe' -exec chmod +x {} + 2>/dev/null || true
  touch "$READY"
fi
exec "$CACHE/yaade" "$@"
`
    if (!stubTemplate.endsWith("\n")) {
      die("internal: stub template must end with newline")
    }
    const lines = countLines(stubTemplate)
    const stub = stubTemplate.replace("LINES=XXXXXXXX", `LINES=${lines}`)
    if (countLines(stub) !== lines) {
      die(`internal: stub line count drifted (${countLines(stub)} vs ${lines})`)
    }

    const out = path.resolve(outfile)
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.rmSync(out, { recursive: true, force: true })
    fs.writeFileSync(out, Buffer.concat([Buffer.from(stub, "utf8"), archive]))
    fs.chmodSync(out, 0o755)
    console.log(`Self-extracting binary: ${out} (${hash})`)
    return out
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isMain) {
  const runtimeDir = process.argv[2]
  const outfile = process.argv[3]
  if (!runtimeDir || !outfile) {
    die("Usage: node scripts/pack-sef.mjs <runtimeDir> <outfile>")
  }
  packSelfExtracting(runtimeDir, outfile)
}
