#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import { gzipSync } from "node:zlib"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const dist = path.join(root, "dist")
const htmlPath = path.join(dist, "index.html")
const html = fs.readFileSync(htmlPath, "utf8")
const entryMatch = html.match(/<script[^>]+src="\/?assets\/(index-[^"]+\.js)"/)
if (!entryMatch) throw new Error("web entry chunk not found")

const assets = path.join(dist, "assets")
const mandatoryChunks = new Map()
const visitStaticImports = fileName => {
  if (mandatoryChunks.has(fileName)) return
  const source = fs.readFileSync(path.join(assets, fileName), "utf8")
  mandatoryChunks.set(fileName, source)
  for (const match of source.matchAll(/(?:from|import)\s*["']\.\/([^"']+\.js)["']/g)) {
    visitStaticImports(match[1])
  }
}
visitStaticImports(entryMatch[1])
const mandatorySource = [...mandatoryChunks.values()].join("\n")
const forbidden = ["shiki-", "diffs-", "agents-entry-"]
const forbiddenMarkers = [
  "lexical.dev",
  "LegendList",
  "react-markdown",
  "rehype-raw",
  "data-yaade-settings-tabs",
  "data-yaade-todo-board-columns",
]
const violations = [
  ...forbidden.filter(name => [...mandatoryChunks.keys()].some(chunk => chunk.startsWith(name))),
  ...forbiddenMarkers.filter(name => mandatorySource.includes(name)),
]
if (violations.length > 0) {
  throw new Error(`optional chunks leaked into the startup graph: ${violations.join(", ")}`)
}

const mandatoryGzipBytes = [...mandatoryChunks.values()].reduce(
  (total, source) => total + gzipSync(source).byteLength,
  0,
)
// Measured 307.1 KiB after moving the compatibility shell behind its route
// boundary. Keep ~7.4% headroom without giving that startup win back.
const mandatoryGzipBudget = 330 * 1024
if (mandatoryGzipBytes > mandatoryGzipBudget) {
  throw new Error(
    `mandatory startup JS is ${mandatoryGzipBytes} gzip bytes; budget is ${mandatoryGzipBudget}`,
  )
}

const preloads = [...html.matchAll(/rel="modulepreload"[^>]+href="([^"]+)"/g)].map(match => match[1])
console.log(JSON.stringify({
  entry: entryMatch[1],
  mandatoryChunks: [...mandatoryChunks.keys()],
  mandatoryGzipBytes,
  mandatoryGzipBudget,
  preloads,
}, null, 2))
