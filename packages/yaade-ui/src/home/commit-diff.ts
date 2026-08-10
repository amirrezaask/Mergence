import type {
  GitCommitDetail,
  GitCommitFile,
  GitStatusEntry,
} from "@yaade/shared"
import { fileUriToPath, pathToFileUri } from "@yaade/shared"

export type CommitDiffContents = { original: string; modified: string }

type GitApi = NonNullable<NonNullable<typeof window.yaade>["git"]>
type FsApi = NonNullable<NonNullable<typeof window.yaade>["fs"]>

/** Cap file sides so React + Pierre never hold unbounded blobs. */
const DIFF_UI_MAX_CHARS = 1 * 1024 * 1024

function truncateForDiffUi(text: string): string {
  if (text.length <= DIFF_UI_MAX_CHARS) return text
  return `${text.slice(0, DIFF_UI_MAX_CHARS)}\n\n… truncated for UI (${text.length} chars total)`
}

function capDiffContents(contents: CommitDiffContents): CommitDiffContents {
  return {
    original: truncateForDiffUi(contents.original),
    modified: truncateForDiffUi(contents.modified),
  }
}

export async function loadWorkingTreeSnapshot(
  api: GitApi,
  rootUri: string,
): Promise<{ detail: GitCommitDetail; entries: GitStatusEntry[] }> {
  const entries = await api.status(rootUri)
  return {
    entries,
    detail: {
      hash: "working-tree",
      subject: "Uncommitted changes",
      body: "",
      files: entries.map(entry => ({
        path: entry.path,
        status: entry.worktreeStatus ?? entry.indexStatus ?? entry.status,
        originalPath: entry.originalPath,
      })),
    },
  }
}

export async function loadWorkingTreeDiffContents(
  api: GitApi,
  fsApi: FsApi,
  rootUri: string,
  file: GitCommitFile,
): Promise<CommitDiffContents> {
  const rootPath = fileUriToPath(rootUri).replace(/[/\\]+$/, "")
  const fileUri = pathToFileUri(`${rootPath}/${file.path.replace(/^[/\\]+/, "")}`)
  const oldPath = file.originalPath ?? file.path

  if (file.status === "deleted") {
    return capDiffContents({
      original: await api.show(rootUri, oldPath, "HEAD").catch(() => ""),
      modified: "",
    })
  }

  const [original, modified] = await Promise.all([
    api.show(rootUri, oldPath, "HEAD").catch(() => ""),
    fsApi.readFile(fileUri).catch(() => ""),
  ])
  return capDiffContents({ original, modified })
}

/** Prefer the dedicated RPC; fall back to `git:show` at parent vs commit. */
export async function loadCommitDiffContents(
  api: GitApi,
  rootUri: string,
  hash: string,
  file: GitCommitFile,
): Promise<CommitDiffContents> {
  if (typeof api.commitFileContents === "function") {
    try {
      return capDiffContents(await api.commitFileContents(rootUri, hash, file))
    } catch {
      // Older hosts may not expose the channel yet — fall through to show.
    }
  }
  if (typeof api.show !== "function") {
    throw new Error("Git show is unavailable; restart the YAADE host.")
  }
  const parent = `${hash}^`
  const oldPath = file.originalPath ?? file.path
  if (file.status === "added") {
    return capDiffContents({
      original: "",
      modified: await api.show(rootUri, file.path, hash),
    })
  }
  if (file.status === "deleted") {
    return capDiffContents({
      original: await api.show(rootUri, oldPath, parent),
      modified: "",
    })
  }
  const [original, modified] = await Promise.all([
    api.show(rootUri, oldPath, parent),
    api.show(rootUri, file.path, hash),
  ])
  if (!original && !modified) {
    throw new Error(
      "Could not read this commit’s file contents. Restart the YAADE host and try again.",
    )
  }
  return capDiffContents({ original, modified })
}
