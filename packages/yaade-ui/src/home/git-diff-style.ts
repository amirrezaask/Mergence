export type GitDiffStyle = "unified" | "split"

const VERSIONED_STORAGE_KEY = "yaade:v1:git-diff-style"
const LEGACY_STORAGE_KEY = "yaade:git-diff-style"

export function readGitDiffStyle(): GitDiffStyle {
  try {
    const stored =
      localStorage.getItem(VERSIONED_STORAGE_KEY) ??
      localStorage.getItem(LEGACY_STORAGE_KEY)
    return stored === "split" ? "split" : "unified"
  } catch {
    return "unified"
  }
}

export function writeGitDiffStyle(style: GitDiffStyle): void {
  try {
    localStorage.setItem(VERSIONED_STORAGE_KEY, style)
    localStorage.removeItem(LEGACY_STORAGE_KEY)
  } catch {
    // Preferences are best effort when storage is unavailable or full.
  }
}
