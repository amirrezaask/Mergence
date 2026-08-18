/** Process liveness and teardown helpers for PTY children. */

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function signalProcess(pid: number, signal: NodeJS.Signals): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}

/** Signal a POSIX process group. Returns false on Windows or if the pgid is unsafe. */
export function signalProcessGroup(
  pgid: number,
  signal: NodeJS.Signals,
): boolean {
  if (process.platform === "win32") return false
  if (!Number.isInteger(pgid) || pgid <= 0 || pgid === process.pid) return false
  try {
    process.kill(-pgid, signal)
    return true
  } catch {
    return false
  }
}
