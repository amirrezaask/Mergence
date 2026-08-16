export type SearchNvimTarget = {
  readonly path: string
  readonly line: number
  readonly column: number
}

function positivePosition(value: number, fallback = 1): number {
  return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : fallback
}

/** Arguments for the first Neovim process launched for a search tool. */
export function nvimLaunchArgs(target: SearchNvimTarget): readonly string[] {
  const line = positivePosition(target.line)
  const column = positivePosition(target.column)
  return [`+call cursor(${line}, ${column})`, "--", target.path]
}

/** Escape a path for a literal `:edit` command inside Neovim. */
function escapeNvimPath(path: string): string {
  return path.replace(/[\\\s|"'%#]/g, "\\$&")
}

/** Command sent to an existing Neovim PTY when another result is selected. */
export function nvimEditCommand(target: SearchNvimTarget): string {
  const line = positivePosition(target.line)
  const column = positivePosition(target.column)
  return `:edit ${escapeNvimPath(target.path)}\r:call cursor(${line}, ${column})\r`
}
