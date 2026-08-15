#!/usr/bin/env node

if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
  process.stdout.write("DA1-PROBE-ERROR:not-a-tty\n");
  process.exit(2);
}

process.stdin.setRawMode(true);
process.stdin.resume();
let response = "";
const timeout = setTimeout(() => {
  process.stdout.write("\r\nDA1-PROBE-TIMEOUT\r\n");
  process.exit(1);
}, 2_000);

timeout.unref();
process.stdin.on("data", (chunk) => {
  response += chunk.toString("utf8");
  if (!/\x1b\[\?[\d;]*c/.test(response)) return;
  clearTimeout(timeout);
  process.stdout.write("\r\nDA1-PROBE-OK\r\n");
  process.stdin.removeAllListeners("data");
});

// Put the query on the flood path: browsers suspend requestAnimationFrame in
// background tabs, but terminal protocol handling must keep making progress.
process.stdout.write(`${"x".repeat(1_024)}\x1b[0c`);
