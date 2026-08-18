/**
 * Keys node-pty would strip when `opt.env === process.env`. A spread copy
 * bypasses that identity check, so we delete them ourselves.
 * @see node-pty UnixTerminal._sanitizeEnv
 */
export const PTY_SANITIZED_ENV_KEYS = [
  "TMUX",
  "TMUX_PANE",
  "STY",
  "WINDOW",
  "WINDOWID",
  "TERMCAP",
  "COLUMNS",
  "LINES",
] as const

export function sanitizePtyEnv(
  env: Record<string, string>,
  preserve?: Record<string, string>,
): Record<string, string> {
  for (const key of PTY_SANITIZED_ENV_KEYS) {
    if (preserve && Object.prototype.hasOwnProperty.call(preserve, key)) continue
    delete env[key]
  }
  return env
}
