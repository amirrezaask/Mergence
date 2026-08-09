type QueueResult<T> =
  | { readonly done: false; readonly value: T }
  | { readonly done: true }

export class AsyncQueue<T> {
  static readonly maxItems = 256
  static readonly maxBytes = 1_048_576
  private readonly values: T[] = []
  private readonly waiters: Array<(result: QueueResult<T>) => void> = []
  private closed = false
  private bytes = 0
  private overflowed = false

  get didOverflow(): boolean { return this.overflowed }

  push(value: T): boolean {
    if (this.closed) return false
    const waiter = this.waiters.shift()
    if (waiter) { waiter({ done: false, value }); return true }
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength
    if (this.values.length >= AsyncQueue.maxItems || this.bytes + bytes > AsyncQueue.maxBytes) { this.overflowed = true; this.close(); return false }
    this.values.push(value); this.bytes += bytes; return true
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter({ done: true })
  }

  async *iterate(signal?: AbortSignal): AsyncIterable<T> {
    while (!signal?.aborted) {
      const result = await this.take(signal)
      if (result.done) return
      this.bytes = Math.max(0, this.bytes - new TextEncoder().encode(JSON.stringify(result.value)).byteLength)
      yield result.value
    }
  }

  private take(signal?: AbortSignal): Promise<QueueResult<T>> {
    const value = this.values.shift()
    if (value !== undefined) return Promise.resolve({ done: false, value })
    if (this.closed || signal?.aborted) return Promise.resolve({ done: true })
    return new Promise(resolve => {
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        resolve({ done: true })
      }
      const waiter = (result: QueueResult<T>): void => {
        signal?.removeEventListener("abort", onAbort)
        resolve(result)
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }
}
