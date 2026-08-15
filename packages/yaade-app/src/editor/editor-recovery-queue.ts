/** Serializes recovery mutations per URI so stale writes cannot win races. */
export class EditorRecoveryQueue {
  private readonly tails = new Map<string, Promise<void>>()

  enqueue(uri: string, operation: () => Promise<unknown>): Promise<void> {
    const previous = this.tails.get(uri) ?? Promise.resolve()
    const result = previous
      .catch(() => undefined)
      .then(operation)
      .then(() => undefined)
    const tail = result.catch(() => undefined)
    this.tails.set(uri, tail)
    void tail.finally(() => {
      if (this.tails.get(uri) === tail) this.tails.delete(uri)
    })
    return result
  }

  async waitForIdle(): Promise<void> {
    await Promise.all(this.tails.values())
  }
}
