import { useEffect, useState, type ReactNode } from "react"
import type { SearchMatchRange } from "@yaade/shared"
import type { ThemedToken } from "@shikijs/core"
import { cn } from "../lib/utils.js"
import type { SearchChunkLine, SearchResultChunk } from "./search-chunks.js"
import { tokenizeSearchLines } from "./search-highlighter.js"

function markLine(
  text: string,
  tokens: ThemedToken[] | undefined,
  ranges: SearchMatchRange[],
  lineNumber: number,
): ReactNode {
  const marks = ranges
    .filter(range => range.startLine === lineNumber && range.endLine === lineNumber)
    .map(range => ({
      start: Math.max(0, range.startColumn - 1),
      end: Math.max(0, range.endColumn - 1),
    }))
    .sort((a, b) => a.start - b.start)

  if (!tokens || tokens.length === 0) {
    return wrapPlain(text, marks)
  }

  const parts: ReactNode[] = []
  let offset = 0
  let key = 0
  for (const token of tokens) {
    const start = offset
    const end = offset + token.content.length
    parts.push(
      <span key={`t-${key++}`} style={token.color ? { color: token.color } : undefined}>
        {wrapSegment(token.content, start, marks)}
      </span>,
    )
    offset = end
  }
  return parts
}

function wrapPlain(text: string, marks: Array<{ start: number; end: number }>): ReactNode {
  return wrapSegment(text, 0, marks)
}

function wrapSegment(
  text: string,
  absoluteStart: number,
  marks: Array<{ start: number; end: number }>,
): ReactNode {
  if (marks.length === 0 || text.length === 0) return text
  const absoluteEnd = absoluteStart + text.length
  const overlapping = marks.filter(
    mark => mark.end > absoluteStart && mark.start < absoluteEnd,
  )
  if (overlapping.length === 0) return text

  const parts: ReactNode[] = []
  let cursor = 0
  for (const [index, mark] of overlapping.entries()) {
    const localStart = Math.max(0, mark.start - absoluteStart)
    const localEnd = Math.min(text.length, mark.end - absoluteStart)
    if (localEnd <= cursor) continue
    if (localStart > cursor) parts.push(text.slice(cursor, localStart))
    if (localEnd > localStart) {
      parts.push(
        <mark
          key={`m-${index}-${localStart}`}
          className="rounded-[2px] bg-warning/30 text-inherit"
        >
          {text.slice(Math.max(localStart, cursor), localEnd)}
        </mark>,
      )
    }
    cursor = localEnd
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts
}

export function SearchCodeChunk({
  path,
  chunk,
  highlight = true,
  onSelectLine,
  selectedLine = null,
}: {
  path: string
  chunk: SearchResultChunk
  /** When false, skip Shiki until the card is near the viewport / file text is ready. */
  highlight?: boolean
  onSelectLine: (line: SearchChunkLine, disposition?: "preview" | "pinned") => void
  selectedLine?: number | null
}) {
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null)

  useEffect(() => {
    if (!highlight) {
      setTokens(null)
      return
    }
    let cancelled = false
    void tokenizeSearchLines(
      path,
      chunk.lines.map(line => line.text),
    ).then(next => {
      if (!cancelled) setTokens(next)
    })
    return () => {
      cancelled = true
    }
  }, [chunk.lines, highlight, path])

  return (
    <div
      className="overflow-hidden rounded-md border border-border/70 bg-card/40"
      data-yaade-project-search-chunk=""
    >
      <div className="font-mono text-2xs leading-5">
        {chunk.lines.map((line, index) => (
          <button
            key={`${chunk.startLine}-${line.line}`}
            type="button"
            role="option"
            data-yaade-list-item=""
            data-yaade-project-search-hit={line.match ? `${path}:${line.line}` : undefined}
            data-selected={selectedLine === line.line ? "" : undefined}
            className={cn(
              "grid w-full shrink-0 grid-cols-[2.75rem_minmax(0,1fr)] text-left hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none",
              line.match && "bg-warning/5",
              selectedLine === line.line && "bg-accent ring-1 ring-inset ring-ring/50",
            )}
            onClick={event =>
              onSelectLine(line, event.detail > 1 ? "pinned" : "preview")
            }
          >
            <span className="select-none border-r border-border/50 px-2 py-0.5 text-right text-muted-foreground tabular-nums">
              {line.line}
            </span>
            <span
              data-slot="row-label"
              className="min-w-0 overflow-x-auto whitespace-pre px-2 py-0.5 text-foreground"
            >
              {markLine(line.text, tokens?.[index], line.ranges, line.line) || " "}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
