import { getSingularPatch, type DiffLineAnnotation, type FileDiffMetadata, type Hunk } from "@pierre/diffs"

/**
 * One hunk ready for `git apply --cached [--reverse]`.
 *
 * Pierre supplies typed metadata (header / +− counts). The `patch` string is
 * always a substring of the original `git diff` output — never rebuilt from
 * `diffAcceptRejectHunk`, which only mutates in-memory FileDiffMetadata.
 */
export type ApplyHunk = {
  index: number
  header: string
  patch: string
  added: number
  deleted: number
}

type RawHunkSlice = { header: string; body: string }

/**
 * Split a single-file unified diff into per-hunk bodies that keep the file
 * header (diff --git / --- / +++ / index / rename …). Git apply needs that
 * prefix on every hunk payload.
 */
export function sliceRawHunkBodies(patch: string): RawHunkSlice[] {
  const lines = patch.split("\n")
  const headerEnd = lines.findIndex(line => line.startsWith("@@"))
  if (headerEnd < 0) return []
  const fileHeader = lines.slice(0, headerEnd).join("\n")
  const slices: RawHunkSlice[] = []
  let start = -1
  const flush = (end: number) => {
    if (start < 0) return
    const hunkLines = lines.slice(start, end)
    const header = (hunkLines[0] ?? "").trim()
    let body = `${fileHeader}\n${hunkLines.join("\n")}`
    if (!body.endsWith("\n")) body += "\n"
    slices.push({ header, body })
  }
  for (let i = headerEnd; i < lines.length; i++) {
    if (lines[i]!.startsWith("@@")) {
      flush(i)
      start = i
    }
  }
  flush(lines.length)
  return slices
}

/**
 * Parse a git unified patch with Pierre, then pair each typed hunk to a raw
 * apply payload sliced from the same string.
 *
 * Returns [] when Pierre and the raw slicer disagree on hunk count — better
 * to show "no hunks" than feed git a misaligned patch.
 */
export function listApplyHunks(patch: string): ApplyHunk[] {
  const trimmed = patch.trim()
  if (!trimmed) return []

  let fileDiff: FileDiffMetadata
  try {
    fileDiff = getSingularPatch(patch)
  } catch {
    return []
  }

  const slices = sliceRawHunkBodies(patch)
  if (slices.length === 0 || slices.length !== fileDiff.hunks.length) return []

  return fileDiff.hunks.map((hunk, index) => {
    const slice = slices[index]!
    return {
      index,
      header: normalizeHunkHeader(hunk.hunkSpecs) || slice.header,
      patch: slice.body,
      added: hunk.additionLines,
      deleted: hunk.deletionLines,
    }
  })
}

/** Map a rendered addition/deletion line number to a Pierre hunk index. */
export function hunkIndexForLine(
  fileDiff: FileDiffMetadata,
  lineNumber: number,
  side: "additions" | "deletions",
): number | null {
  for (let i = 0; i < fileDiff.hunks.length; i++) {
    const hunk = fileDiff.hunks[i]!
    if (lineInHunk(hunk, lineNumber, side)) return i
  }
  return null
}

export type HunkActionMeta = { hunkIndex: number }

/** One annotation per hunk, anchored on the first changed line. */
export function buildHunkActionAnnotations(
  fileDiff: FileDiffMetadata,
): DiffLineAnnotation<HunkActionMeta>[] {
  return fileDiff.hunks.map((hunk, hunkIndex) => {
    const preferAdditions = hunk.additionLines > 0
    return {
      side: preferAdditions ? "additions" : "deletions",
      lineNumber: preferAdditions ? hunk.additionStart : hunk.deletionStart,
      metadata: { hunkIndex },
    }
  })
}

function lineInHunk(
  hunk: Hunk,
  lineNumber: number,
  side: "additions" | "deletions",
): boolean {
  if (side === "additions") {
    const start = hunk.additionStart
    const end = start + hunk.additionCount - 1
    return lineNumber >= start && lineNumber <= end
  }
  const start = hunk.deletionStart
  const end = start + hunk.deletionCount - 1
  return lineNumber >= start && lineNumber <= end
}

function normalizeHunkHeader(hunkSpecs: string | undefined): string {
  return (hunkSpecs ?? "").replace(/\n+$/, "").trim()
}
