import fs from "node:fs"

const ESC = "\u001b"
const queries = [
  `${ESC}[0c`,
  `${ESC}[5n`,
  `${ESC}[6n`,
]
let queryIndex = 0
const responses = []
const responseFile = process.argv[2] ?? null

function flush() {
  if (!responseFile) return
  fs.writeFileSync(responseFile, `${responses.join("\n")}\n`)
}

if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.resume()
process.stdin.on("data", chunk => {
  const hex = Buffer.from(chunk).toString("hex")
  responses.push(`${queryIndex}:${hex}`)
  process.stdout.write(`QUERY_RESPONSE_${queryIndex}=${hex}\n`)
  queryIndex += 1
  if (queryIndex >= queries.length) {
    flush()
    process.exit(0)
  }
})
process.stdout.write(queries.join(""))
process.on("exit", flush)
process.on("SIGTERM", () => process.exit(143))
setTimeout(() => process.exit(2), 5_000).unref?.()
