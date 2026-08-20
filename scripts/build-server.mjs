#!/usr/bin/env node
/** Build the standalone server runtime without the web application. */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { packSelfExtracting } from "./pack-sef.mjs"
import { stageServerPack } from "./stage-runtime-pack.mjs"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const runtimeDir = path.join(repoRoot, "dist/server-runtime")
const serverOut = path.join(repoRoot, "dist/yaade-server")

await stageServerPack(runtimeDir)
// Remove the pre-isolation combined artifact so a build cannot be mistaken
// for a server-only release.
fs.rmSync(path.join(repoRoot, "dist/yaade"), { recursive: true, force: true })
fs.rmSync(serverOut, { recursive: true, force: true })
packSelfExtracting(runtimeDir, serverOut, {
  launcher: "yaade-server",
  requireWeb: false,
  cacheName: "yaade-server",
})

console.log(`Standalone server binary: ${serverOut}`)
