import { execFileSync } from "node:child_process"
import {
  captureProcessIdentity,
  isProcessAlive,
  matchesProcessIdentity,
  type ProcessIdentity,
} from "../../../packages/yaade-node-host/src/process-identity.js"

export async function waitForProcessIdentity(
  pid: number,
  timeoutMs = 10_000,
): Promise<ProcessIdentity> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const identity = captureProcessIdentity(pid)
    if (identity) return identity
    await new Promise<void>(resolve => setTimeout(resolve, 40))
  }
  throw new Error(`timed out capturing process identity for pid ${pid}`)
}

export async function assertProcessAlive(identity: ProcessIdentity): Promise<void> {
  if (!matchesProcessIdentity(identity)) {
    throw new Error(
      `expected process ${identity.pid} startToken=${identity.startToken} to remain alive`,
    )
  }
}

export async function assertProcessDead(identity: ProcessIdentity): Promise<void> {
  if (matchesProcessIdentity(identity) || isProcessAlive(identity.pid)) {
    throw new Error(`expected process ${identity.pid} to be dead`)
  }
}

export function processRssBytes(pid: number): number {
  try {
    if (process.platform === "win32") {
      const output = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid}).WorkingSet64`,
        ],
        { encoding: "utf8", windowsHide: true },
      )
      return Number(String(output).trim()) || 0
    }
    const output = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    return (Number(String(output).trim()) || 0) * 1024
  } catch {
    return 0
  }
}

export function countMatchingProcesses(needle: string): number {
  try {
    if (process.platform === "win32") {
      const output = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${needle.replace(/'/g, "''")}*' } | Measure-Object | Select-Object -ExpandProperty Count`,
        ],
        { encoding: "utf8", windowsHide: true },
      )
      return Number(String(output).trim()) || 0
    }
    const output = execFileSync("ps", ["-ax", "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    return output.split("\n").filter(line => line.includes(needle)).length
  } catch {
    return 0
  }
}

export function readProcessTree(): string {
  try {
    if (process.platform === "win32") {
      return execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | Format-Table -AutoSize | Out-String -Width 200",
        ],
        { encoding: "utf8", windowsHide: true },
      )
    }
    return execFileSync("ps", ["-ax", "-o", "pid,ppid,stat,command"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
