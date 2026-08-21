const ESC = "\u001b"
const enter = `${ESC}[?1049h${ESC}[?25l${ESC}[2J${ESC}[H`
const leave = `${ESC}[?1049l${ESC}[?25h`
const rows = [
  "YAADE ALTERNATE SCREEN",
  "┌──────────────────────┐",
  "│ deterministic grid   │",
  "│ wide: 世界            │",
  "│ combining: e\u0301       │",
  "└──────────────────────┘",
]

process.stdout.write(enter)
process.stdout.write(rows.map((row, index) => `${ESC}[${index + 1};1H${row}`).join(""))
process.stdout.write(`${ESC}[6;4H${ESC}[2 q`)
process.stdin.resume()
process.stdin.setEncoding("utf8")
process.stdin.on("data", data => {
  if (!data.includes("x") && !data.includes("q") && !data.includes("\u0003")) return
  process.stdout.write(`${leave}ALTERNATE_SCREEN_EXITED\n`)
  process.exit(0)
})
process.on("SIGTERM", () => {
  process.stdout.write(leave)
  process.exit(0)
})
setInterval(() => {}, 1e9).unref?.()
