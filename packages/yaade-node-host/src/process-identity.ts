import fs from "node:fs"
import { execFileSync } from "node:child_process"

export type ProcessIdentity = {
  pid: number
  platform: "linux" | "darwin" | "windows"
  /** Linux boot identifier. It prevents matching a PID from a previous boot. */
  bootId?: string
  /** OS-owned process creation/start token. */
  startToken: string
  executablePath?: string
}

function validPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid
}

function validCapturePid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0
}

function commandText(command: string, args: readonly string[]): string | null {
  try {
    const output = execFileSync(command, [...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    })
    const text = String(output).trim()
    return text || null
  } catch {
    return null
  }
}

function linuxProcessIdentity(pid: number): ProcessIdentity | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
    // The comm field may contain spaces and parentheses. Split after its final
    // closing delimiter before reading fixed-width fields.
    const delimiter = stat.lastIndexOf(") ")
    if (delimiter < 0) return null
    const fields = stat.slice(delimiter + 2).trim().split(/\s+/)
    // Tail starts at field 3 (state), so field 22 (starttime) is index 19.
    const startToken = fields[19]
    if (!startToken) return null
    const bootId = fs
      .readFileSync("/proc/sys/kernel/random/boot_id", "utf8")
      .trim()
    let executablePath: string | undefined
    try {
      executablePath = fs.readlinkSync(`/proc/${pid}/exe`)
    } catch {
      /* The process can exit between the two proc reads. */
    }
    return {
      pid,
      platform: "linux",
      startToken,
      ...(bootId ? { bootId } : {}),
      ...(executablePath ? { executablePath } : {}),
    }
  } catch {
    return null
  }
}

function darwinProcessIdentity(pid: number): ProcessIdentity | null {
  const startToken = commandText("ps", ["-p", String(pid), "-o", "lstart="])
  if (!startToken) return null
  const executablePath = commandText("ps", ["-p", String(pid), "-o", "comm="])
  return {
    pid,
    platform: "darwin",
    startToken: startToken.replace(/\s+/g, " "),
    ...(executablePath ? { executablePath } : {}),
  }
}

function windowsProcessIdentity(pid: number): ProcessIdentity | null {
  // PowerShell is present on supported Windows installations. The PID is
  // numeric, so this command does not interpolate external user data.
  const script = `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`
  const startToken = commandText("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ])
  if (!startToken) return null
  const executablePath = commandText("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `(Get-Process -Id ${pid}).Path`,
  ])
  return {
    pid,
    platform: "windows",
    startToken,
    ...(executablePath ? { executablePath } : {}),
  }
}

/** Capture an OS-derived identity. A missing identity is intentionally unsafe. */
export function captureProcessIdentity(pid: number): ProcessIdentity | null {
  if (!validCapturePid(pid)) return null
  if (process.platform === "linux") return linuxProcessIdentity(pid)
  if (process.platform === "darwin") return darwinProcessIdentity(pid)
  if (process.platform === "win32") return windowsProcessIdentity(pid)
  return null
}

export function matchesProcessIdentity(identity: ProcessIdentity): boolean {
  if (!validPid(identity.pid)) return false
  const current = captureProcessIdentity(identity.pid)
  if (!current || current.platform !== identity.platform) return false
  if (current.startToken !== identity.startToken) return false
  if (identity.bootId !== undefined && current.bootId !== identity.bootId) {
    return false
  }
  if (
    identity.executablePath !== undefined &&
    current.executablePath !== identity.executablePath
  ) {
    return false
  }
  return true
}

/** Signal only after the persisted identity has been revalidated. */
export function signalVerifiedProcess(
  identity: ProcessIdentity,
  signal: NodeJS.Signals,
): boolean {
  if (!matchesProcessIdentity(identity)) return false
  try {
    process.kill(identity.pid, signal)
    return true
  } catch {
    return false
  }
}

/** Signal a POSIX process group only after validating its group leader. */
export function signalVerifiedProcessGroup(
  identity: ProcessIdentity,
  signal: NodeJS.Signals,
): boolean {
  if (process.platform === "win32" || !matchesProcessIdentity(identity)) {
    return false
  }
  try {
    process.kill(-identity.pid, signal)
    return true
  } catch {
    return false
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!validPid(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
