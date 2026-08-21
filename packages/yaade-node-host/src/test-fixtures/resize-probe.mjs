let last = ""
function dimensions() {
  const columns = Number(process.stdout.columns ?? process.env.COLUMNS ?? 0)
  const rows = Number(process.stdout.rows ?? process.env.LINES ?? 0)
  return `${columns}x${rows}`
}
function report() {
  const next = dimensions()
  if (next === last) return
  last = next
  process.stdout.write(`SIZE=${next}\n`)
}
report()
process.stdin.resume()
process.on("SIGWINCH", report)
const timer = setInterval(report, 50)
process.on("SIGTERM", () => {
  clearInterval(timer)
  process.exit(0)
})
