const shutdown = () => {
  process.stdin.pause()
  process.exit(0)
}

process.stdout.write("ECHO_READY\n")
process.stdin.resume()
process.stdin.setEncoding("utf8")
process.stdin.on("data", data => {
  if (data.includes("\u0003") || data.includes("\u0004") || data.includes("\u001dEXIT\u001d")) {
    shutdown()
    return
  }
  process.stdout.write(data)
})
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
setInterval(() => {}, 1e9).unref?.()
