import fs from "node:fs"
import { waitUntil } from "./wait.js"
import type { MockAgentHandle } from "./types.js"

type ControlIdentity = {
  pid: number
  controlPort: number
}

async function postControl(
  port: number,
  pathname: string,
  body: Record<string, unknown> = {},
): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`mock agent ${pathname} failed (${response.status})`)
  }
  return response.json()
}

export async function waitForMockAgent(controlFile: string, timeoutMs = 15_000): Promise<MockAgentHandle> {
  await waitUntil(() => fs.existsSync(controlFile), timeoutMs, `mock agent control file ${controlFile}`)
  const raw: unknown = JSON.parse(fs.readFileSync(controlFile, "utf8"))
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("invalid mock agent control file")
  }
  const record = raw as Partial<ControlIdentity>
  if (typeof record.pid !== "number" || typeof record.controlPort !== "number") {
    throw new Error("mock agent control file is missing pid or port")
  }
  await waitUntil(async () => {
    const response = await fetch(`http://127.0.0.1:${record.controlPort}/health`)
    return response.ok
  }, timeoutMs, "mock agent control health")
  return {
    controlPort: record.controlPort,
    pid: record.pid,
    controlFile,
    emitRange: async (from, to) => {
      await postControl(record.controlPort, "/emit", { from, to })
    },
    emitText: async text => {
      await postControl(record.controlPort, "/emit", { kind: "text", text })
    },
    startNumbered: async (from, to, intervalMs) => {
      await postControl(record.controlPort, "/numbered", {
        from,
        ...(to == null ? {} : { to }),
        ...(intervalMs == null ? {} : { intervalMs }),
      })
    },
    stopNumbered: async () => {
      await postControl(record.controlPort, "/stop-numbered")
    },
    setMode: async mode => {
      await postControl(record.controlPort, "/mode", { mode })
    },
    exit: async (code = 0) => {
      await postControl(record.controlPort, "/exit", { code })
    },
  }
}

export function numberedLine(n: number): string {
  return `YAADE_MOCK_N=${String(n).padStart(4, "0")}`
}

export function numberedLinesPresentOnce(output: string, from: number, to: number): {
  missing: number[]
  duplicated: number[]
} {
  const missing: number[] = []
  const duplicated: number[] = []
  for (let n = from; n <= to; n++) {
    const token = numberedLine(n)
    let count = 0
    let fromIndex = 0
    while (fromIndex < output.length) {
      const at = output.indexOf(token, fromIndex)
      if (at < 0) break
      count += 1
      fromIndex = at + token.length
    }
    if (count === 0) missing.push(n)
    else if (count > 1) duplicated.push(n)
  }
  return { missing, duplicated }
}
