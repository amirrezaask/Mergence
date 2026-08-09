import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { expect } from "@playwright/test"

export type BenchResult = {
  name: string
  median: number
  p95: number
  p99: number
  samples: number[]
}

export type BenchBudget = {
  medianMs: number
  p95Ms: number
  p99Ms: number
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

export function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)
  return sorted[idx]!
}

export type RunBenchOptions = {
  name: string
  warmup?: number
  rounds?: number
  measure: () => Promise<number>
}

export async function runBench(opts: RunBenchOptions): Promise<BenchResult> {
  const warmup = opts.warmup ?? 2
  const rounds = opts.rounds ?? 5
  for (let i = 0; i < warmup; i++) await opts.measure()
  const samples: number[] = []
  for (let i = 0; i < rounds; i++) samples.push(await opts.measure())
  return {
    name: opts.name,
    median: median(samples),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
    samples,
  }
}

const budgetsPath = resolve(process.cwd(), "tests/bench/budgets.json")
const budgets = JSON.parse(readFileSync(budgetsPath, "utf8")) as Record<string, BenchBudget>

export function assertBudget(result: BenchResult): void {
  const budget = budgets[result.name]
  if (budget == null) return
  expect(result.median, `${result.name} median ${result.median}ms > ${budget.medianMs}ms`).toBeLessThanOrEqual(budget.medianMs)
  expect(result.p95, `${result.name} p95 ${result.p95}ms > ${budget.p95Ms}ms`).toBeLessThanOrEqual(budget.p95Ms)
  expect(result.p99, `${result.name} p99 ${result.p99}ms > ${budget.p99Ms}ms`).toBeLessThanOrEqual(budget.p99Ms)
}

export function logBenchResult(result: BenchResult): void {
  console.log(
    `[bench] ${result.name} median=${result.median.toFixed(1)}ms ` +
      `p95=${result.p95.toFixed(1)}ms p99=${result.p99.toFixed(1)}ms ` +
      `samples=${JSON.stringify(result.samples.map(sample => Number(sample.toFixed(1))))}`,
  )
}
