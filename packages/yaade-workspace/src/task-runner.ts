import { Emitter, pathToFileUri } from "@yaade/shared"
import type { ListItem } from "./list-document.js"

export type JetTask = {
  label: string
  command: string
  args?: string[]
  cwd?: string
  group?: "build" | "test" | string
}

export type TaskRunState = {
  id: string
  task: JetTask
  status: "running" | "done" | "failed"
  output: string
  exitCode: number | null
  errors: ListItem[]
  folderId?: string
  folderName?: string
}

export type TaskSpawnRequest = {
  id: string
  command: string
  args: string[]
  cwd: string
}

export type TaskSpawnHandlers = {
  spawn: (req: TaskSpawnRequest) => Promise<{ exitCode: number; output: string }>
}

const TS_ERROR = /^(.+)\((\d+),(\d+)\):\s+error\s+/m
const CARGO_ERROR = /^\s*-->\s+(.+):(\d+):(\d+)/m
const GENERIC_ERROR = /^(.+?):(\d+)(?::(\d+))?\s/m

export function parseTaskOutput(output: string, workspacePath: string): ListItem[] {
  const items: ListItem[] = []
  const lines = output.split("\n")
  let n = 0
  for (const line of lines) {
    let m = line.match(TS_ERROR) ?? line.match(CARGO_ERROR) ?? line.match(GENERIC_ERROR)
    if (!m) continue
    const rawPath = m[1]!.trim()
    const lineNum = parseInt(m[2]!, 10)
    const col = m[3] ? parseInt(m[3], 10) : 1
    if (!Number.isFinite(lineNum)) continue
    const absPath =
      rawPath.startsWith("/") || /^[A-Za-z]:/.test(rawPath)
        ? rawPath
        : `${workspacePath}/${rawPath}`.replace(/\/+/g, "/")
    items.push({
      id: `task-err-${n++}`,
      fileUri: pathToFileUri(absPath),
      path: rawPath,
      line: lineNum,
      column: col,
      label: line.trim().slice(0, 120),
    })
  }
  return items
}

export class TaskRunner {
  tasks: JetTask[] = []
  runs: TaskRunState[] = []
  activeRunId: string | null = null

  readonly onDidChange = new Emitter<void>()

  constructor(private handlers?: TaskSpawnHandlers) {}

  setHandlers(handlers: TaskSpawnHandlers | undefined): void {
    this.handlers = handlers
  }

  register(task: JetTask): void {
    this.tasks.push(task)
    this.onDidChange.fire()
  }

  setTasks(tasks: JetTask[]): void {
    this.tasks = tasks
    this.onDidChange.fire()
  }

  activeRun(): TaskRunState | null {
    if (!this.activeRunId) return null
    return this.runs.find(r => r.id === this.activeRunId) ?? null
  }

  appendOutput(id: string, chunk: string): void {
    const run = this.runs.find(r => r.id === id)
    if (!run) return
    run.output += chunk
    this.onDidChange.fire()
  }

  async runTask(
    task: JetTask,
    cwd: string,
    workspacePath: string,
    folderMeta?: { folderId: string; folderName: string },
  ): Promise<TaskRunState> {
    const id = `run-${Date.now()}`
    const run: TaskRunState = {
      id,
      task,
      status: "running",
      output: `$ ${task.command} ${(task.args ?? []).join(" ")}\n`,
      exitCode: null,
      errors: [],
      folderId: folderMeta?.folderId,
      folderName: folderMeta?.folderName,
    }
    this.runs.push(run)
    this.activeRunId = id
    this.onDidChange.fire()

    if (!this.handlers) {
      run.status = "failed"
      run.output += "\nTasks are unavailable.\n"
      run.exitCode = 1
      this.onDidChange.fire()
      return run
    }

    try {
      const result = await this.handlers.spawn({
        id,
        command: task.command,
        args: task.args ?? [],
        cwd: task.cwd ?? cwd,
      })
      run.output += result.output
      run.exitCode = result.exitCode
      run.status = result.exitCode === 0 ? "done" : "failed"
    } catch (err) {
      run.output += `\n${err instanceof Error ? err.message : String(err)}\n`
      run.status = "failed"
      run.exitCode = 1
    }

    run.errors = parseTaskOutput(run.output, workspacePath)
    this.onDidChange.fire()
    return run
  }
}
