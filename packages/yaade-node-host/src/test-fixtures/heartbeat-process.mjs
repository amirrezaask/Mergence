import fs from "node:fs"
import path from "node:path"

const target = process.argv[2]
if (!target) {
  process.stderr.write("heartbeat-process requires a file path\n")
  process.exit(2)
}
let counter = 0
function beat() {
  counter += 1
  const temporary = `${target}.${process.pid}.tmp`
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(temporary, `${counter}\n`, "utf8")
  fs.renameSync(temporary, target)
  process.stdout.write(`HEARTBEAT=${counter}\n`)
}
beat()
const timer = setInterval(beat, 50)
process.stdin.resume()
process.stdin.on("data", data => {
  if (data.toString().includes("stop")) process.exit(0)
})
const shutdown = () => {
  clearInterval(timer)
  process.exit(0)
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
