/**
 * Fish (and other shells) send Primary Device Attributes (`CSI 0 c` / `CSI c`)
 * at startup and wait up to 10s for a reply on stdin. In YAADE the PTY lives
 * on the host and the VT parser lives in the browser, so that reply used to
 * depend on Ghostty being mounted — a race the client cannot close.
 *
 * The host answers DA1 itself as soon as the query appears on the slave's
 * stdout. Ghostty may later emit the same reply; the renderer must drop those
 * duplicates so fish does not see a second response as typed input.
 */

/** xterm-256color-style DA1. Any `\x1b[?…c` satisfies fish; this one keeps optional features. */
export const TERMINAL_DA1_RESPONSE = "\x1b[?64;1;2;6;9;15;18;21;22c"

const ESC = "\x1b"

export type Da1Scanner = {
  leftover: string
}

export function createDa1Scanner(): Da1Scanner {
  return { leftover: "" }
}

/**
 * Feed PTY stdout. Returns how many complete DA1 queries were observed.
 * Keeps a short leftover so `\x1b` / `\x1b[` / `\x1b[0` can span chunks.
 */
export function feedDa1Queries(scanner: Da1Scanner, chunk: string): number {
  const data = scanner.leftover + chunk
  scanner.leftover = ""
  let queries = 0
  let i = 0
  while (i < data.length) {
    const esc = data.indexOf(ESC, i)
    if (esc === -1) return queries
    const rest = data.slice(esc)
    if (rest === ESC || rest === `${ESC}[` || rest === `${ESC}[0`) {
      scanner.leftover = rest
      return queries
    }
    if (rest.startsWith(`${ESC}[c`)) {
      queries += 1
      i = esc + 3
      continue
    }
    if (rest.startsWith(`${ESC}[0c`)) {
      queries += 1
      i = esc + 4
      continue
    }
    i = esc + 1
  }
  return queries
}

/** Drop DA1 *responses* (`CSI ? … c`) so a host-answered query is not answered twice. */
export function stripDa1Responses(data: string): string {
  if (!data.includes("\x1b[?")) return data
  return data.replace(/\x1b\[\?[\d;]*c/g, "")
}
