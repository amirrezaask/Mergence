import type { FileSystemProvider } from "./types.js"

const IGNORE_DIRS = new Set([".git", "node_modules", "dist", ".turbo"])

export async function indexWorkspaceFiles(
  fs: FileSystemProvider,
  rootUri: string,
  maxFiles = 5000,
  listFiles?: (rootUri: string) => Promise<string[]>,
): Promise<string[]> {
  if (listFiles) {
    try {
      return await listFiles(rootUri)
    } catch {
      /* fall back to directory walk */
    }
  }
  const results: string[] = []

  async function walk(uri: string, rel: string, depth: number): Promise<void> {
    if (results.length >= maxFiles || depth > 12) return
    let entries
    try {
      entries = await fs.readDir(uri)
    } catch {
      return
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) return
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory) {
        if (IGNORE_DIRS.has(entry.name)) continue
        await walk(entry.uri, entryRel, depth + 1)
      } else {
        results.push(entryRel)
      }
    }
  }

  await walk(rootUri, "", 0)
  return results.sort()
}

export function fuzzyMatchFiles(query: string, files: string[], limit = 100): string[] {
  const trimmed = query.trim()
  if (!trimmed) return files.slice(0, limit)

  const terms = trimmed.toLowerCase().split(/\s+/).filter(Boolean)
  const scored: { path: string; score: number }[] = []

  for (const path of files) {
    const lower = path.toLowerCase()
    const base = (path.split("/").pop() ?? path).toLowerCase()
    let total = 0
    let matched = true
    for (const term of terms) {
      const s = scoreFileTerm(term, lower, base)
      if (s === null) {
        matched = false
        break
      }
      total += s
    }
    if (matched) scored.push({ path, score: total })
  }

  scored.sort((a, b) => a.score - b.score || a.path.localeCompare(b.path))
  return scored.slice(0, limit).map(s => s.path)
}

function scoreFileTerm(term: string, path: string, base: string): number | null {
  const idx = path.indexOf(term)
  if (idx >= 0) {
    let score = idx
    if (base.startsWith(term)) score -= 100
    if (base === term) score -= 200
    const baseIdx = base.indexOf(term)
    if (baseIdx >= 0) score -= 50
    return score
  }

  const baseSub = subsequenceScore(term, base)
  if (baseSub !== null) return baseSub + 80

  const pathSub = subsequenceScore(term, path)
  if (pathSub !== null) return pathSub + 160

  return null
}

function subsequenceScore(query: string, text: string): number | null {
  let qi = 0
  let score = 0
  let last = -1
  for (let ti = 0; ti < text.length && qi < query.length; ti++) {
    if (text[ti] !== query[qi]) continue
    if (last >= 0) score += ti - last
    const prev = text[ti - 1]
    if (ti === 0 || prev === "/" || prev === "." || prev === "-" || prev === "_") score -= 3
    last = ti
    qi++
  }
  return qi === query.length ? score : null
}
