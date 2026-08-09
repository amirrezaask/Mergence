import type { AgentClock } from "@yaade/agent-driver"

export class RealtimeAgentClock implements AgentClock {
  now(): Date {
    return new Date()
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

export class InstantAgentClock implements AgentClock {
  private currentMs: number

  constructor(start = new Date("2026-01-01T00:00:00.000Z")) {
    this.currentMs = start.getTime()
  }

  now(): Date {
    return new Date(this.currentMs)
  }

  sleep(ms: number): Promise<void> {
    this.currentMs += Math.max(0, ms)
    return Promise.resolve()
  }
}

interface PendingSleep {
  readonly atMs: number
  readonly resolve: () => void
}

export class ManualAgentClock implements AgentClock {
  private currentMs: number
  private pending: PendingSleep[] = []

  constructor(start = new Date("2026-01-01T00:00:00.000Z")) {
    this.currentMs = start.getTime()
  }

  now(): Date {
    return new Date(this.currentMs)
  }

  sleep(ms: number): Promise<void> {
    const atMs = this.currentMs + Math.max(0, ms)
    return new Promise((resolve) => {
      this.pending.push({ atMs, resolve })
      this.pending.sort((left, right) => left.atMs - right.atMs)
    })
  }

  async advanceBy(ms: number): Promise<void> {
    this.currentMs += Math.max(0, ms)
    const ready = this.pending.filter((sleep) => sleep.atMs <= this.currentMs)
    this.pending = this.pending.filter((sleep) => sleep.atMs > this.currentMs)
    for (const sleep of ready) sleep.resolve()
    await Promise.resolve()
  }
}
