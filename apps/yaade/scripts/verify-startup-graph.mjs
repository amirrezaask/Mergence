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
const forbidden = ["shiki-", "diffs-", "agents-entry-", "monaco-"]
const forbiddenMarkers = [
  "lexical.dev",
  "LegendList",
  "react-markdown",
  "rehype-raw",
  "data-yaade-settings-tabs",
  "data-yaade-todo-board-columns",
  'from"monaco-editor',
  "from'monaco-editor",
  "node_modules/monaco-editor",
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
// Measured 343.6 KiB after isolating optional overlays and marking UI modules
// side-effect-free. Keep ~7.7% headroom for product changes.
const mandatoryGzipBudget = 370 * 1024
if (mandatoryGzipBytes > mandatoryGzipBudget) {
  throw new Error(
    `mandatory startup JS is ${mandatoryGzipBytes} gzip bytes; budget is ${mandatoryGzipBudget}`,
  )
}

const monacoChunkNames = fs
  .readdirSync(assets)
  .filter(
    fileName =>
      /^monaco-.*\.js$/.test(fileName) &&
      !fileName.startsWith("monaco-lang-") &&
      !fileName.startsWith("monaco-workers-"),
  )
if (monacoChunkNames.length !== 1) {
  throw new Error(
    `expected one Monaco base chunk, found: ${monacoChunkNames.join(", ") || "none"}`,
  )
}
const monacoGzipBytes = gzipSync(
  fs.readFileSync(path.join(assets, monacoChunkNames[0])),
).byteLength
// Recorded before language contributions/workers were made demand-loaded.
// Raising this cap is an explicit editor bundle-budget decision.
const monacoGzipBudget = 974 * 1024
if (monacoGzipBytes > monacoGzipBudget) {
  throw new Error(
    `Monaco base chunk is ${monacoGzipBytes} gzip bytes; budget is ${monacoGzipBudget}`,
  )
}

const preloads = [...html.matchAll(/rel="modulepreload"[^>]+href="([^"]+)"/g)].map(match => match[1])
console.log(JSON.stringify({
  entry: entryMatch[1],
  mandatoryChunks: [...mandatoryChunks.keys()],
  mandatoryGzipBytes,
  mandatoryGzipBudget,
  monacoChunk: monacoChunkNames[0],
  monacoGzipBytes,
  monacoGzipBudget,
  preloads,
}, null, 2))
