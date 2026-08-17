export type RedrawEvent = {
  readonly name: string
  readonly args: readonly unknown[]
}

export class NeovimProtocolError extends Error {
  readonly name = "NeovimProtocolError"
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

const EMPTY_ARGS: readonly unknown[] = []

/**
 * Visits the outer `redraw` notification without creating an intermediate
 * event object for the normal, grouped Neovim wire shape.  Neovim sends
 * repeated calls as `[name, [args...], [args...]]`; those argument arrays are
 * already owned by the decoder and can be passed straight to the reducer.
 *
 * A small compatibility path accepts the flattened tuples used by older test
 * fixtures.  That path necessarily copies the tuple tail because the reducer
 * contract is an argument array rather than an offset view.
 */
export function forEachRedrawEvent(
  args: readonly unknown[],
  visit: (name: string, eventArgs: readonly unknown[]) => void,
): void {
  if (!isArray(args)) {
    throw new NeovimProtocolError("redraw notification has malformed event list")
  }
  for (const rawEvent of args) {
    if (!isArray(rawEvent) || typeof rawEvent[0] !== "string") {
      throw new NeovimProtocolError("redraw notification contains a malformed event")
    }
    const name = rawEvent[0]
    // A grouped call is identified by any array argument after the event
    // name. Once that wire form is selected, every argument must be a group;
    // otherwise malformed grouped data could fall through as a flattened
    // fixture and bypass the boundary validator.
    const grouped = rawEvent.length > 1 && rawEvent.slice(1).some(isArray)
    if (rawEvent.length === 1) {
      visit(name, EMPTY_ARGS)
      continue
    }
    if (grouped) {
      for (let index = 1; index < rawEvent.length; index += 1) {
        const eventArgs = rawEvent[index]
        if (!isArray(eventArgs)) {
          throw new NeovimProtocolError("redraw notification contains a malformed argument group")
        }
        visit(name, eventArgs)
      }
      continue
    }
    const eventArgs = Array.from<unknown>({ length: Math.max(0, rawEvent.length - 1) })
    for (let index = 1; index < rawEvent.length; index += 1) {
      eventArgs[index - 1] = rawEvent[index]
    }
    visit(name, eventArgs)
  }
}

/** Decode the outer `redraw` notification for tests and low-frequency tools. */
export function decodeRedrawEvents(args: readonly unknown[]): readonly RedrawEvent[] {
  const events: RedrawEvent[] = []
  forEachRedrawEvent(args, (name, eventArgs) => {
    events.push({ name, args: eventArgs })
  })
  return events
}

export function tupleNumber(
  eventName: string,
  args: readonly unknown[],
  index: number,
): number {
  const value = args[index]
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new NeovimProtocolError(`${eventName} argument ${index} must be an integer`)
  }
  return value
}

export function tupleString(
  eventName: string,
  args: readonly unknown[],
  index: number,
): string {
  const value = args[index]
  if (typeof value !== "string") {
    throw new NeovimProtocolError(`${eventName} argument ${index} must be a string`)
  }
  return value
}

export function tupleArray(
  eventName: string,
  args: readonly unknown[],
  index: number,
): readonly unknown[] {
  const value = args[index]
  if (!isArray(value)) {
    throw new NeovimProtocolError(`${eventName} argument ${index} must be an array`)
  }
  return value
}

export function tupleBoolean(
  eventName: string,
  args: readonly unknown[],
  index: number,
): boolean {
  const value = args[index]
  if (typeof value !== "boolean") {
    throw new NeovimProtocolError(`${eventName} argument ${index} must be a boolean`)
  }
  return value
}

export function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined
}
