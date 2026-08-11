import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"
import {
  createProjectSearch,
  getProjectSearch,
  listProjectSearches,
  loadMoreProjectSearch,
  removeProjectSearch,
  resetProjectSearchesForTests,
  updateProjectSearch,
} from "./project-search-store.js"

afterEach(() => {
  resetProjectSearchesForTests()
  delete (globalThis as { window?: unknown }).window
})

describe("project-search-store", () => {
  it("creates, lists, updates query, and removes entries", async () => {
    const project = "/tmp/proj"
    const created = createProjectSearch(project)
    assert.match(created.id, /^srch-/)
    assert.equal(listProjectSearches(project).length, 1)
    assert.equal(getProjectSearch(project, created.id)?.query, "")

    const calls: Array<{ query: string }> = []
    ;(globalThis as { window: unknown }).window = {
      yaade: {
        search: {
          project: async (_root: string, query: string) => {
            calls.push({ query })
            return {
              items: [
                {
                  path: "a.ts",
                  line: 1,
                  column: 1,
                  preview: query,
                  ranges: [],
                },
              ],
              truncated: false,
            }
          },
        },
      },
    }

    updateProjectSearch(project, created.id, { query: "hello" })
    assert.equal(getProjectSearch(project, created.id)?.loading, true)
    await new Promise(resolve => setTimeout(resolve, 150))
    const after = getProjectSearch(project, created.id)
    assert.equal(after?.loading, false)
    assert.equal(after?.results.length, 1)
    assert.equal(after?.results[0]?.preview, "hello")
    assert.equal(calls.length, 1)

    removeProjectSearch(project, created.id)
    assert.equal(listProjectSearches(project).length, 0)
  })

  it("aborts superseded searches when the query changes", async () => {
    const project = "/tmp/abort"
    const entry = createProjectSearch(project)
    let resolveFirst: (() => void) | undefined
    const firstGate = new Promise<void>(resolve => {
      resolveFirst = resolve
    })
    const queries: string[] = []
    let firstSignal: AbortSignal | undefined
    ;(globalThis as { window: unknown }).window = {
      yaade: {
        search: {
          project: async (
            _root: string,
            query: string,
            _opts: unknown,
            signal?: AbortSignal,
          ) => {
            queries.push(query)
            if (query === "one") {
              firstSignal = signal
              await firstGate
              if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
              return { items: [], truncated: false }
            }
            return {
              items: [
                {
                  path: "b.ts",
                  line: 2,
                  column: 1,
                  preview: query,
                  ranges: [],
                },
              ],
              truncated: false,
            }
          },
        },
      },
    }

    updateProjectSearch(project, entry.id, { query: "one" })
    await new Promise(resolve => setTimeout(resolve, 130))
    updateProjectSearch(project, entry.id, { query: "two" })
    assert.equal(firstSignal?.aborted, true)
    resolveFirst?.()
    await new Promise(resolve => setTimeout(resolve, 150))

    const final = getProjectSearch(project, entry.id)
    assert.equal(final?.query, "two")
    assert.equal(final?.loading, false)
    assert.equal(final?.results[0]?.preview, "two")
    assert.ok(queries.includes("two"))
  })

  it("appends the next page when loadMore is called", async () => {
    const project = "/tmp/more"
    const entry = createProjectSearch(project)
    let calls = 0
    ;(globalThis as { window: unknown }).window = {
      yaade: {
        search: {
          project: async (
            _root: string,
            query: string,
            opts?: { cursor?: string; limit?: number },
          ) => {
            calls += 1
            if (!opts?.cursor) {
              return {
                items: [
                  {
                    path: "a.ts",
                    line: 1,
                    column: 1,
                    preview: query,
                    ranges: [],
                  },
                ],
                truncated: true,
                nextCursor: "1",
              }
            }
            return {
              items: [
                {
                  path: "b.ts",
                  line: 2,
                  column: 1,
                  preview: `${query}-2`,
                  ranges: [],
                },
              ],
              truncated: false,
            }
          },
        },
      },
    }

    updateProjectSearch(project, entry.id, { query: "hello" })
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(getProjectSearch(project, entry.id)?.results.length, 1)
    assert.equal(getProjectSearch(project, entry.id)?.truncated, true)

    loadMoreProjectSearch(project, entry.id)
    await new Promise(resolve => setTimeout(resolve, 50))
    const after = getProjectSearch(project, entry.id)
    assert.equal(after?.results.length, 2)
    assert.equal(after?.truncated, false)
    assert.equal(after?.results[1]?.path, "b.ts")
    assert.equal(calls, 2)
  })
})
