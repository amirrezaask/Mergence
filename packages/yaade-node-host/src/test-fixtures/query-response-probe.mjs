import fs from "node:fs"

const ESC = "\u001b"
const queries = [
  `${ESC}[0c`,
  `${ESC}[5n`,
  `${ESC}[6n`,
]
const responseFile = process.argv[2] ?? null
let received = Buffer.alloc(0)
let completed = false

function decodedResponses() {
  const text = received.toString("latin1")
  return [
    text.match(/\u001b\[\?[0-9;]+c/)?.[0],
    text.match(/\u001b\[0n/)?.[0],
    text.match(/\u001b\[[0-9]+;[0-9]+R/)?.[0],
  ]
}

function outputLines() {
  return decodedResponses().flatMap((response, index) =>
    response
      ? [`QUERY_RESPONSE_${index}=${Buffer.from(response, "latin1").toString("hex")}`]
      : [],
  )
}

function flush() {
  if (!responseFile) return
  fs.writeFileSync(responseFile, `${outputLines().join("\n")}\n`)
}

if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.resume()
process.stdin.on("data", chunk => {
  received = Buffer.concat([received, Buffer.from(chunk)])
  const responses = decodedResponses()
  if (completed || responses.some(response => response === undefined)) return
  completed = true
  for (const line of outputLines()) process.stdout.write(`${line}\n`)
  flush()
  process.exit(0)
})
process.stdout.write(queries.join(""))
process.on("exit", flush)
process.on("SIGTERM", () => process.exit(143))
setTimeout(() => process.exit(2), 5_000).unref?.()
