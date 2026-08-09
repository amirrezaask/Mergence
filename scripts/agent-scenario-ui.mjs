import { spawn } from "node:child_process"

const scenario = process.argv[2] ?? "simple-stream"
const child = spawn(
  "pnpm",
  ["exec", "playwright", "test", "tests/electron/agent-runtime.electron.spec.ts", "--project=web-e2e"],
  {
    stdio: "inherit",
    env: { ...process.env, YAADE_AGENT_MOCK_SCENARIO: scenario },
  },
)
child.once("exit", code => process.exit(code ?? 1))
