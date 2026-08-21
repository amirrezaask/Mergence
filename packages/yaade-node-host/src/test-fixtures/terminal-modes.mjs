const ESC = "\u001b"
const modes = [
  ["bracketed-paste", `${ESC}[?2004h`],
  ["application-cursor", `${ESC}[?1h`],
  ["focus-reporting", `${ESC}[?1004h`],
  ["sgr-mouse", `${ESC}[?1006h${ESC}[?1000h`],
  ["pixel-mouse", `${ESC}[?1016h`],
  ["synchronized-output", `${ESC}[?2026h`],
  ["kitty-keyboard", `${ESC}[>1u`],
]
for (const [name, sequence] of modes) {
  process.stdout.write(`${sequence}${name.toUpperCase()}_ENABLED\n`)
}
process.stdin.resume()
process.stdin.setEncoding("utf8")
process.stdin.on("data", data => {
  if (data.includes("reset") || data.includes("\u0003")) {
    process.stdout.write(`${ESC}[?2004l${ESC}[?1l${ESC}[?1004l${ESC}[?1006l${ESC}[?1016l${ESC}[?2026l${ESC}[>0uMODES_RESET\n`)
  }
})
process.on("SIGTERM", () => process.exit(0))
setInterval(() => {}, 1e9).unref?.()
