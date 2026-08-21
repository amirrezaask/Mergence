process.stdin.resume()
process.stdin.on("data", chunk => {
  process.stdout.write(`INPUT_HEX=${Buffer.from(chunk).toString("hex")}\n`)
})
process.on("SIGTERM", () => process.exit(0))
setInterval(() => {}, 1e9).unref?.()
