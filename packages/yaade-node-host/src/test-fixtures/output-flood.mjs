const args = new Map()
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index]
  if (!value?.startsWith("--")) continue
  const key = value.slice(2)
  const next = process.argv[index + 1]
  args.set(key, next?.startsWith("--") || next === undefined ? "true" : next)
  if (next && !next.startsWith("--")) index += 1
}

const bytes = Math.max(0, Number(args.get("bytes") ?? 3 * 1024 * 1024) || 0)
const marker = String(args.get("marker") ?? "YAADE_OUTPUT_FLOOD_COMPLETE")
const stayAlive = args.get("stay") === "true"
const chunk = Buffer.alloc(64 * 1024, "x")
let remaining = bytes
while (remaining > 0) {
  const size = Math.min(remaining, chunk.length)
  process.stdout.write(chunk.subarray(0, size))
  remaining -= size
}
process.stdout.write(`\n${marker}\n`)
if (stayAlive) {
  process.stdin.resume()
  setInterval(() => {}, 1e9).unref?.()
} else {
  process.exit(0)
}
