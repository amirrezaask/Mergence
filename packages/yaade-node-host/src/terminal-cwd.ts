import { execFile, execFileSync } from "node:child_process"
import fs from "node:fs"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const DARWIN_LSOF_CANDIDATES = ["/usr/sbin/lsof", "/usr/bin/lsof", "lsof"] as const
/** Short TTL so repeated splits reuse one lsof/ps walk. */
const CWD_CACHE_TTL_MS = 250
/** Share one `ps` snapshot across ordinary foreground lookups (≤1/s). */
const PROCESS_TABLE_TTL_MS = 1_000
const MAX_PID_CACHE_ENTRIES = 512

type CacheEntry = { value: string | null; expiresAt: number }

const cwdCache = new Map<number, CacheEntry>()
const fgCache = new Map<number, CacheEntry>()

type ProcRow = { pid: number; ppid: number; comm: string }

let processTableCache: { rows: ProcRow[]; expiresAt: number } | null = null
let processTableInflight: Promise<ProcRow[]> | null = null

function cached(
  map: Map<number, CacheEntry>,
  pid: number,
): string | null | undefined {
  const hit = map.get(pid)
  if (!hit) return undefined
  if (Date.now() > hit.expiresAt) {
    map.delete(pid)
    return undefined
  }
  return hit.value
}

function putCache(
  map: Map<number, CacheEntry>,
  pid: number,
  value: string | null,
): void {
  map.set(pid, { value, expiresAt: Date.now() + CWD_CACHE_TTL_MS })
  if (map.size <= MAX_PID_CACHE_ENTRIES) return
  const first = map.keys().next().value
  if (typeof first === "number") map.delete(first)
}

/** Test helper — clears cwd / foreground caches between cases. */
export function clearTerminalCwdCaches(): void {
  cwdCache.clear()
  fgCache.clear()
  processTableCache = null
  processTableInflight = null
}

function parseLsofCwd(out: string): string | null {
  for (const line of out.split("\n")) {
    if (!line.startsWith("n") || line.length < 2) continue
    const cwd = line.slice(1)
    if (cwd && cwd !== "/" && !cwd.startsWith("(")) return cwd
    if (cwd === "/") return cwd
  }
  return null
}

async function cwdOfPidLinux(pid: number): Promise<string | null> {
  try {
    const target = await fs.promises.readlink(`/proc/${pid}/cwd`)
    return target || null
  } catch {
    return null
  }
}

async function cwdOfPidDarwin(pid: number): Promise<string | null> {
  for (const lsof of DARWIN_LSOF_CANDIDATES) {
    try {
      const { stdout } = await execFileAsync(
        lsof,
        ["-a", "-d", "cwd", "-p", String(pid), "-Fn"],
        {
          encoding: "utf8",
          timeout: 2_000,
          maxBuffer: 64 * 1024,
          // Ignore inherited PATH so restricted GUI environments cannot hide /usr/sbin.
          env: {
            ...process.env,
            PATH: "/usr/sbin:/usr/bin:/bin:/sbin",
          },
        },
      )
      const cwd = parseLsofCwd(stdout)
      if (cwd) return cwd
    } catch {
      /* try next candidate */
    }
  }
  return null
}

/**
 * Resolve the current working directory of a process (async).
 * Used so mux splits inherit a shell's live cwd after `cd`.
 *
 * On macOS prefer absolute `lsof` paths — GUI hosts often inherit a
 * PATH without `/usr/sbin`, so a bare `lsof` lookup returns ENOENT.
 */
export async function cwdOfPid(pid: number): Promise<string | null> {
  if (!Number.isFinite(pid) || pid <= 0) return null

  const hit = cached(cwdCache, pid)
  if (hit !== undefined) return hit

  let cwd: string | null = null
  if (process.platform === "linux") {
    cwd = await cwdOfPidLinux(pid)
  } else if (process.platform === "darwin") {
    cwd = await cwdOfPidDarwin(pid)
  }

  putCache(cwdCache, pid, cwd)
  return cwd
}

/**
 * Synchronous cwd lookup retained for tests / tight loops that already know
 * they are off the host event loop. Prefer {@link cwdOfPid}.
 */
export function cwdOfPidSync(pid: number): string | null {
  if (!Number.isFinite(pid) || pid <= 0) return null
  if (process.platform === "linux") {
    try {
      const target = fs.readlinkSync(`/proc/${pid}/cwd`)
      return target || null
    } catch {
      return null
    }
  }
  if (process.platform === "darwin") {
    for (const lsof of DARWIN_LSOF_CANDIDATES) {
      try {
        const out = execFileSync(
          lsof,
          ["-a", "-d", "cwd", "-p", String(pid), "-Fn"],
          {
            encoding: "utf8",
            timeout: 2_000,
            maxBuffer: 64 * 1024,
            env: {
              ...process.env,
              PATH: "/usr/sbin:/usr/bin:/bin:/sbin",
            },
          },
        )
        const cwd = parseLsofCwd(out)
        if (cwd) return cwd
      } catch {
        /* try next */
      }
    }
  }
  return null
}

async function listProcessesUncached(): Promise<ProcRow[]> {
  if (process.platform !== "darwin" && process.platform !== "linux") return []
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-Ao", "pid=,ppid=,command="],
      {
        encoding: "utf8",
        timeout: 2_000,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          ...process.env,
          PATH: "/usr/sbin:/usr/bin:/bin:/sbin",
        },
      },
    )
    const rows: ProcRow[] = []
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const match = /^(\d+)\s+(\d+)\s+(.+)$/.exec(trimmed)
      if (!match) continue
      rows.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        comm: (match[3] ?? "").trim(),
      })
    }
    return rows
  } catch {
    return []
  }
}

async function listProcesses(fresh = false): Promise<ProcRow[]> {
  const now = Date.now()
  if (!fresh && processTableCache && now <= processTableCache.expiresAt) {
    return processTableCache.rows
  }
  if (processTableInflight) return processTableInflight
  processTableInflight = listProcessesUncached()
    .then(rows => {
      processTableCache = { rows, expiresAt: Date.now() + PROCESS_TABLE_TTL_MS }
      return rows
    })
    .finally(() => {
      processTableInflight = null
    })
  return processTableInflight
}

/**
 * Deepest descendant of `rootPid` in the process tree (BFS), preferring
 * children over the leader so a shell running nvim reports nvim's cwd.
 * Returns the root itself when it has no children.
 */
const AGENT_PROCESS_NAMES = new Set([
  "claude",
  "codex",
  "cursor-agent",
  "cursor",
  "opencode",
  "grok",
  "pi",
])

function processName(comm: string): string {
  return basenameOfComm(comm).replace(/\.exe$/i, "").toLowerCase()
}

function agentNameFromCommand(command: string): string | null {
  const direct = processName(command)
  if (AGENT_PROCESS_NAMES.has(direct)) return direct
  for (const token of command.split(/\s+/)) {
    const name = processName(token)
    if (AGENT_PROCESS_NAMES.has(name)) return name
  }
  return null
}

function descendantPids(rootPid: number, rows: ProcRow[]): number[] {
  const children = new Map<number, number[]>()
  for (const row of rows) {
    const list = children.get(row.ppid)
    if (list) list.push(row.pid)
    else children.set(row.ppid, [row.pid])
  }
  const found: number[] = []
  const queue = [rootPid]
  const seen = new Set<number>([rootPid])
  while (queue.length > 0) {
    const cur = queue.shift()!
    found.push(cur)
    for (const child of children.get(cur) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      queue.push(child)
    }
  }
  return found
}

export function deepestDescendantPid(
  rootPid: number,
  rows: ProcRow[],
): number {
  const found = descendantPids(rootPid, rows)
  return found[found.length - 1] ?? rootPid
}

export function preferredForegroundPid(rootPid: number, rows: ProcRow[]): number {
  const found = descendantPids(rootPid, rows)
  let agentPid: number | null = null
  for (const pid of found) {
    if (pid === rootPid) continue
    const row = rows.find(item => item.pid === pid)
    if (!row) continue
    if (agentNameFromCommand(row.comm)) agentPid = pid
  }
  return agentPid ?? (found[found.length - 1] ?? rootPid)
}

function basenameOfComm(comm: string): string {
  const base = comm.split(/[/\\]/).pop() ?? comm
  return base.replace(/\s+\(.*\)$/, "").trim()
}

/**
 * Resolve the foreground (deepest descendant) process under a PTY leader.
 * Returns `{ pid, name }` where name is the basename of the command.
 */
export async function foregroundProcessOf(
  leaderPid: number,
  options?: { fresh?: boolean },
): Promise<{ pid: number; name: string } | null> {
  if (!Number.isFinite(leaderPid) || leaderPid <= 0) return null
  const fresh = options?.fresh === true

  const hit = fresh ? undefined : cached(fgCache, leaderPid)
  if (hit !== undefined) {
    if (!hit) return null
    const sep = hit.indexOf("\0")
    if (sep < 0) return { pid: leaderPid, name: hit }
    return {
      pid: Number(hit.slice(0, sep)) || leaderPid,
      name: hit.slice(sep + 1),
    }
  }

  const rows = await listProcesses(fresh)
  if (rows.length === 0) {
    putCache(fgCache, leaderPid, null)
    return null
  }
  const fgPid = preferredForegroundPid(leaderPid, rows)
  const row = rows.find(r => r.pid === fgPid)
  const name = row
    ? (agentNameFromCommand(row.comm) ?? basenameOfComm(row.comm.split(/\s+/)[0] ?? row.comm))
    : ""
  if (!name) {
    putCache(fgCache, leaderPid, null)
    return null
  }
  putCache(fgCache, leaderPid, `${fgPid}\0${name}`)
  return { pid: fgPid, name }
}

/**
 * Cwd of the foreground process under a PTY leader, falling back to the leader.
 */
export async function cwdOfForeground(leaderPid: number): Promise<string | null> {
  const fg = await foregroundProcessOf(leaderPid)
  if (fg) {
    const cwd = await cwdOfPid(fg.pid)
    if (cwd) return cwd
  }
  return cwdOfPid(leaderPid)
}
