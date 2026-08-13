import { projectSearch } from "@yaade/node-host"
import { Effect, Stream } from "effect"
import { SearchResultsAppended, SearchResultsReset, SearchToolOutput, ToolUseUpdated, type ProjectSearchResult, type SearchToolInput, type ToolUse, type ToolUseId } from "@yaade/rpc"
import { pathToFileUri } from "@yaade/shared"
import type { ToolSessionStore } from "../tool-session-store.js"
import type { ToolDriver, ToolRuntimeEvent } from "./model.js"
import type { ToolEvent } from "@yaade/rpc"
import { ToolDriverFailure } from "./errors.js"

export type SearchDriverDeps = {
  readonly store: ToolSessionStore
  readonly publish: (event: ToolEvent) => void
}

type SearchOptions = SearchToolInput["options"]

function eventId(prefix: string, id: ToolUseId): string {
  return `${prefix}:${id}:${Date.now()}`
}

function searchOptions(options: SearchOptions): {
  include?: string[]
  exclude?: string[]
  caseSensitive?: boolean
  regex?: boolean
  fuzzy?: boolean
  wholeWord?: boolean
  limit?: number
  cursor?: string
} {
  return {
    ...(options.include ? { include: [...options.include] } : {}),
    ...(options.exclude ? { exclude: [...options.exclude] } : {}),
    ...(options.caseSensitive !== undefined ? { caseSensitive: options.caseSensitive } : {}),
    ...(options.regex !== undefined ? { regex: options.regex } : {}),
    ...(options.fuzzy !== undefined ? { fuzzy: options.fuzzy } : {}),
    ...(options.wholeWord !== undefined ? { wholeWord: options.wholeWord } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.cursor ? { cursor: options.cursor } : {}),
  }
}

/** Host-owned search lifecycle. One AbortController exists per ToolUse. */
export class SearchDriver implements ToolDriver {
  readonly kind = "search" as const
  private readonly controllers = new Map<string, AbortController>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly deps: SearchDriverDeps) {}

  abort(toolUseId: ToolUseId): void {
    this.controllers.get(toolUseId)?.abort()
    this.controllers.delete(toolUseId)
    const timer = this.timers.get(toolUseId)
    if (timer) clearTimeout(timer)
    this.timers.delete(toolUseId)
  }

  start(toolUse: ToolUse, debounce = false): void {
    this.abort(toolUse.id)
    const run = () => {
      void this.run(toolUse, true).catch(() => undefined)
    }
    if (debounce) {
      const timer = setTimeout(() => {
        this.timers.delete(toolUse.id)
        run()
      }, 120)
      timer.unref?.()
      this.timers.set(toolUse.id, timer)
    } else run()
  }

  loadMore(toolUse: ToolUse, cursor: number): Promise<void> {
    this.abort(toolUse.id)
    return this.run(toolUse, false, cursor).catch(() => undefined)
  }

  /** Execute one search generation. The service owns the Effect fiber around this call. */
  async run(toolUse: ToolUse, reset: boolean, cursor?: number): Promise<void> {
    if (toolUse.input.kind !== "search" || toolUse.output.kind !== "search") return
    const controller = new AbortController()
    this.controllers.set(toolUse.id, controller)
    const revision = toolUse.output.resultRevision
    if (reset) {
      this.deps.store.replaceSearchResults(toolUse.id, revision, [])
      this.deps.publish(SearchResultsReset.make({
        eventId: eventId("search-reset", toolUse.id),
        toolUseId: toolUse.id,
        revision: toolUse.revision,
        occurredAt: new Date().toISOString(),
        resultRevision: revision,
      }))
    }

    try {
      if (!toolUse.input.query.trim()) {
        this.updateOutput(toolUse, { resultRevision: revision, resultCount: 0, truncated: false, running: false })
        return
      }
      const page = await projectSearch(
        pathToFileUri(toolUse.context.checkoutPath),
        toolUse.input.query,
        searchOptions({
          ...toolUse.input.options,
          ...(cursor === undefined ? {} : { cursor: String(cursor) }),
        }),
        controller.signal,
      )
      if (controller.signal.aborted) return
      const results = page.items.map(toRpcResult)
      for (let offset = 0; offset < results.length; offset += 100) {
        const current = this.deps.store.getToolUse(toolUse.id)
        if (
          controller.signal.aborted ||
          !current ||
          current.inputRevision !== toolUse.inputRevision ||
          current.output.kind !== "search" ||
          current.output.resultRevision !== revision
        ) return
        const batch = results.slice(offset, offset + 100)
        this.deps.store.appendSearchResults(toolUse.id, revision, batch)
        this.deps.publish(SearchResultsAppended.make({
          eventId: eventId("search-append", toolUse.id),
          toolUseId: toolUse.id,
          revision: toolUse.revision,
          occurredAt: new Date().toISOString(),
          resultRevision: revision,
          results: batch,
        }))
      }
      const current = this.deps.store.getToolUse(toolUse.id)
      if (
        controller.signal.aborted ||
        !current ||
        current.inputRevision !== toolUse.inputRevision ||
        current.output.kind !== "search" ||
        current.output.resultRevision !== revision
      ) return
      this.updateOutput(toolUse, {
        resultRevision: revision,
        resultCount: reset
          ? results.length
          : (toolUse.output.kind === "search" ? toolUse.output.resultCount : 0) + results.length,
        truncated: page.truncated,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        running: false,
      })
    } catch (error) {
      if (controller.signal.aborted) return
      const current = this.deps.store.getToolUse(toolUse.id)
      if (!current) return
      try {
        const updated = this.deps.store.compareAndSetToolUse(current.id, current.revision, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          output: current.output.kind === "search"
            ? SearchToolOutput.make({
                kind: "search",
                resultRevision: current.output.resultRevision,
                resultCount: current.output.resultCount,
                truncated: current.output.truncated,
                ...(current.output.nextCursor ? { nextCursor: current.output.nextCursor } : {}),
                running: false,
              })
            : current.output,
        })
        this.deps.publish(ToolUseUpdated.make({
          eventId: eventId("search-failed", current.id),
          toolUseId: current.id,
          revision: updated.revision,
          occurredAt: updated.updatedAt,
          toolUse: updated,
        }))
      } catch {
        /* A newer input revision owns the row. */
      }
    } finally {
      if (this.controllers.get(toolUse.id) === controller) this.controllers.delete(toolUse.id)
    }
  }

  create(toolUse: ToolUse): Effect.Effect<SearchToolOutput, ToolDriverFailure> {
    return Effect.succeed(toolUse.output.kind === "search"
      ? toolUse.output
      : SearchToolOutput.make({
          kind: "search", resultRevision: 1, resultCount: 0, truncated: false, running: true,
        }))
  }

  updateInput(toolUse: ToolUse): Effect.Effect<SearchToolOutput, ToolDriverFailure> {
    return this.create(toolUse)
  }

  restart(toolUse: ToolUse): Effect.Effect<SearchToolOutput, ToolDriverFailure> {
    return Effect.sync(() => {
      this.abort(toolUse.id)
      return toolUse.output.kind === "search"
        ? toolUse.output
        : SearchToolOutput.make({
            kind: "search", resultRevision: 1, resultCount: 0, truncated: false, running: true,
          })
    })
  }

  cancel(toolUse: ToolUse): Effect.Effect<SearchToolOutput, ToolDriverFailure> {
    return Effect.sync(() => {
      this.abort(toolUse.id)
      if (toolUse.output.kind !== "search") {
        throw new ToolDriverFailure({
          toolUseId: toolUse.id,
          operation: "cancel",
          message: "search output is unavailable",
        })
      }
      return SearchToolOutput.make({
        kind: "search",
        resultRevision: toolUse.output.resultRevision,
        resultCount: toolUse.output.resultCount,
        truncated: toolUse.output.truncated,
        ...(toolUse.output.nextCursor ? { nextCursor: toolUse.output.nextCursor } : {}),
        running: false,
      })
    })
  }

  attach(toolUse: ToolUse): Stream.Stream<ToolRuntimeEvent> {
    return Stream.succeed({ _tag: "OutputChanged", toolUse })
  }

  close(toolUse: ToolUse): Effect.Effect<void, ToolDriverFailure> {
    return Effect.sync(() => this.abort(toolUse.id))
  }

  private updateOutput(toolUse: ToolUse, values: {
    resultRevision: number
    resultCount: number
    truncated: boolean
    nextCursor?: string
    running: boolean
  }): void {
    const current = this.deps.store.getToolUse(toolUse.id)
    if (!current || current.output.kind !== "search") return
    try {
      const updated = this.deps.store.compareAndSetToolUse(current.id, current.revision, {
        status: "succeeded",
        output: SearchToolOutput.make({
          kind: "search",
          resultRevision: values.resultRevision,
          resultCount: values.resultCount,
          truncated: values.truncated,
          ...(values.nextCursor ? { nextCursor: values.nextCursor } : {}),
          running: values.running,
        }),
      })
      this.deps.publish(ToolUseUpdated.make({
        eventId: eventId("search-updated", updated.id),
        toolUseId: updated.id,
        revision: updated.revision,
        occurredAt: updated.updatedAt,
        toolUse: updated,
      }))
    } catch {
      /* Stale search output is rejected by the revisioned store. */
    }
  }
}

function toRpcResult(result: ProjectSearchResult): ProjectSearchResult {
  return {
    path: result.path,
    line: result.line,
    column: result.column,
    preview: result.preview,
    ranges: result.ranges.map(range => ({
      startLine: range.startLine,
      startColumn: range.startColumn,
      endLine: range.endLine,
      endColumn: range.endColumn,
    })),
  }
}
