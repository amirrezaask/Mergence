import {
  AgentThreadSnapshot,
  AgentThreadState,
  AgentCapabilities,
  AgentConfigurationOption,
  type AgentEventEnvelope,
  type AgentPendingAction,
  type AgentTimelineItem,
  type AgentTurn,
} from "@yaade/agent-protocol"

export type AgentInvariantCode =
  | "thread.must-open-first"
  | "thread.already-open"
  | "thread.id-mismatch"
  | "thread.closed"
  | "sequence.non-monotonic"
  | "sequence.gap"
  | "turn.already-active"
  | "turn.missing"
  | "turn.not-running"
  | "item.already-exists"
  | "item.missing"
  | "item.type-changed"
  | "item.revision-not-increasing"
  | "item.delta-unsupported"
  | "item.completed"
  | "action.already-exists"
  | "action.limit-exceeded"
  | "action.missing"
  | "action.type-mismatch"
  | "permission.option-missing"
  | "item.delta-too-large"

export interface AgentInvariantViolation {
  readonly code: AgentInvariantCode
  readonly message: string
}

export type AgentReduceResult =
  | {
      readonly status: "applied"
      readonly snapshot: AgentThreadSnapshot
    }

  | {
      readonly status: "ignored"
      readonly reason: "duplicate-event" | "stale-connection-generation"
      readonly snapshot: AgentThreadSnapshot
    }
  | {
      readonly status: "rejected"
      readonly violations: ReadonlyArray<AgentInvariantViolation>
      readonly snapshot?: AgentThreadSnapshot
    }

const MAX_SEEN_EVENT_IDS = 4_096
const MAX_PENDING_ACTIONS = 64
const MAX_TEXT_DELTA_LENGTH = 256 * 1024

function violation(
  code: AgentInvariantCode,
  message: string,
): AgentInvariantViolation {
  return { code, message }
}

function appendSeenEventId(
  seenEventIds: ReadonlyArray<string>,
  eventId: string,
): ReadonlyArray<string> {
  if (seenEventIds.length < MAX_SEEN_EVENT_IDS) {
    return [...seenEventIds, eventId]
  }
  return [...seenEventIds.slice(1), eventId]
}

function activeTurn(state: AgentThreadState): AgentTurn | undefined {
  return state.turns.find((turn) => turn.status === "running")
}

function findTurn(
  state: AgentThreadState,
  turnId: AgentTurn["id"],
): AgentTurn | undefined {
  return state.turns.find((turn) => turn.id === turnId)
}

function findAction(
  state: AgentThreadState,
  actionId: string,
): AgentPendingAction | undefined {
  return state.pendingActions.find((action) => action.id === actionId)
}

function validateItemReplacement(
  current: AgentTimelineItem | undefined,
  next: AgentTimelineItem,
): ReadonlyArray<AgentInvariantViolation> {
  if (!current) {
    return [violation("item.missing", `timeline item ${next.id} does not exist`)]
  }
  if (current.type !== next.type) {
    return [
      violation(
        "item.type-changed",
        `timeline item ${next.id} cannot change from ${current.type} to ${next.type}`,
      ),
    ]
  }
  if (next.revision <= current.revision) {
    return [
      violation(
        "item.revision-not-increasing",
        `timeline item ${next.id} revision must exceed ${current.revision}`,
      ),
    ]
  }
  return []
}

function validateTurnIsRunning(
  state: AgentThreadState,
  turnId: AgentTurn["id"],
): ReadonlyArray<AgentInvariantViolation> {
  const turn = findTurn(state, turnId)
  if (!turn) {
    return [violation("turn.missing", `turn ${turnId} does not exist`)]
  }
  if (turn.status !== "running") {
    return [
      violation(
        "turn.not-running",
        `turn ${turnId} is ${turn.status} and cannot receive more output`,
      ),
    ]
  }
  return []
}

export function validateAgentThreadEvent(
  snapshot: AgentThreadSnapshot | undefined,
  envelope: AgentEventEnvelope,
): ReadonlyArray<AgentInvariantViolation> {
  if (!snapshot) {
    if (envelope.sequence !== 1 || envelope.event.type !== "thread.opened") {
      return [
        violation(
          "thread.must-open-first",
          "the first event must be thread.opened at sequence 1",
        ),
      ]
    }
    return []
  }

  const state = snapshot.state
  if (envelope.threadId !== state.id) {
    return [
      violation(
        "thread.id-mismatch",
        `event targets ${envelope.threadId}, expected ${state.id}`,
      ),
    ]
  }
  if (envelope.event.type === "thread.opened") {
    return [violation("thread.already-open", `thread ${state.id} is already open`)]
  }
  if (state.status === "closed") {
    return [violation("thread.closed", `thread ${state.id} is closed`)]
  }
  if (envelope.sequence <= state.lastSequence) {
    return [
      violation(
        "sequence.non-monotonic",
        `sequence ${envelope.sequence} must exceed ${state.lastSequence}`,
      ),
    ]
  }
  if (envelope.sequence !== state.lastSequence + 1) {
    return [
      violation(
        "sequence.gap",
        `sequence ${envelope.sequence} leaves a gap after ${state.lastSequence}`,
      ),
    ]
  }

  const event = envelope.event
  switch (event.type) {
    case "turn.started":
      if (activeTurn(state)) {
        return [
          violation(
            "turn.already-active",
            "only one turn may run unless negotiated otherwise",
          ),
        ]
      }
      if (findTurn(state, event.turnId)) {
        return [violation("turn.already-active", `turn ${event.turnId} exists`)]
      }
      return []

    case "item.started":
      if (state.itemsById[event.item.id]) {
        return [
          violation(
            "item.already-exists",
            `timeline item ${event.item.id} already exists`,
          ),
        ]
      }
      return validateTurnIsRunning(state, event.item.turnId)

    case "item.delta": {
      if (event.text.length > MAX_TEXT_DELTA_LENGTH) {
        return [
          violation(
            "item.delta-too-large",
            `timeline delta exceeds ${MAX_TEXT_DELTA_LENGTH} characters`,
          ),
        ]
      }
      const item = state.itemsById[event.itemId]
      if (!item) {
        return [
          violation("item.missing", `timeline item ${event.itemId} does not exist`),
        ]
      }
      if (item.type !== "assistant-message" && item.type !== "reasoning") {
        return [
          violation(
            "item.delta-unsupported",
            `timeline item ${event.itemId} of type ${item.type} cannot receive text deltas`,
          ),
        ]
      }
      if (item.status !== "streaming") {
        return [
          violation(
            "item.completed",
            `timeline item ${event.itemId} is already ${item.status}`,
          ),
        ]
      }
      if (event.revision <= item.revision) {
        return [
          violation(
            "item.revision-not-increasing",
            `timeline item ${event.itemId} revision must exceed ${item.revision}`,
          ),
        ]
      }
      return validateTurnIsRunning(state, item.turnId)
    }

    case "item.updated":
    case "item.completed": {
      const replacementViolations = validateItemReplacement(
        state.itemsById[event.item.id],
        event.item,
      )
      if (replacementViolations.length > 0) return replacementViolations
      return validateTurnIsRunning(state, event.item.turnId)
    }

    case "action.requested":
      if (state.pendingActions.length >= MAX_PENDING_ACTIONS) {
        return [
          violation(
            "action.limit-exceeded",
            `thread already has ${MAX_PENDING_ACTIONS} pending actions`,
          ),
        ]
      }
      if (findAction(state, event.action.id)) {
        return [
          violation(
            "action.already-exists",
            `pending action ${event.action.id} already exists`,
          ),
        ]
      }
      return event.action.turnId
        ? validateTurnIsRunning(state, event.action.turnId)
        : []

    case "action.resolved": {
      const action = findAction(state, event.actionId)
      if (!action) {
        return [
          violation("action.missing", `pending action ${event.actionId} is missing`),
        ]
      }
      if (action.type !== event.response.type) {
        return [
          violation(
            "action.type-mismatch",
            `action ${event.actionId} expects ${action.type}, got ${event.response.type}`,
          ),
        ]
      }
      if (
        action.type === "permission" &&
        event.response.type === "permission"
      ) {
        const optionId = event.response.optionId
        if (!action.options.some((option) => option.id === optionId)) {
          return [
            violation(
              "permission.option-missing",
              `permission option ${optionId} was not advertised`,
            ),
          ]
        }
      }
      return []
    }

    case "turn.completed":
    case "turn.failed":
    case "turn.interrupted":
      return validateTurnIsRunning(state, event.turnId)

    default:
      return []
  }
}

function withCommittedEnvelope(
  state: AgentThreadState,
  envelope: AgentEventEnvelope,
  changes: Partial<AgentThreadState>,
): AgentThreadState {
  return AgentThreadState.make({
    ...state,
    ...changes,
    // Effect Schema classes are nominal at runtime. Re-materialize nested
    // values so browser bundles that decode RPC and reduce events in separate
    // chunks do not retain foreign constructors.
    capabilities: AgentCapabilities.make({
      ...(changes.capabilities ?? state.capabilities),
    }),
    configuration: (changes.configuration ?? state.configuration).map(option =>
      AgentConfigurationOption.make({ ...option }),
    ),
    lastSequence: envelope.sequence,
    revision: state.revision + 1,
    connectionGeneration: Math.max(
      state.connectionGeneration,
      envelope.connectionGeneration,
    ),
    updatedAt: envelope.receivedAt,
  })
}

function replaceTurn(
  turns: ReadonlyArray<AgentTurn>,
  turnId: AgentTurn["id"],
  replace: (turn: AgentTurn) => AgentTurn,
): ReadonlyArray<AgentTurn> {
  return turns.map((turn) => (turn.id === turnId ? replace(turn) : turn))
}

function updateItem(
  state: AgentThreadState,
  item: AgentTimelineItem,
): Record<string, AgentTimelineItem> {
  return { ...state.itemsById, [item.id]: item }
}

function applyValidatedEvent(
  snapshot: AgentThreadSnapshot | undefined,
  envelope: AgentEventEnvelope,
): AgentThreadSnapshot {
  if (!snapshot && envelope.event.type === "thread.opened") {
    const event = envelope.event
    return AgentThreadSnapshot.make({
      protocolVersion: 1,
      reducerVersion: 1,
      seenEventIds: [envelope.eventId],
      state: AgentThreadState.make({
        id: envelope.threadId,
        projectSessionId: event.projectSessionId,
        providerId: event.providerId,
        driverId: event.driverId,
        ...(event.providerSessionId
          ? { providerSessionId: event.providerSessionId }
          : {}),
        cwdUri: event.cwdUri,
        status: "idle",
        capabilities: AgentCapabilities.make({ ...event.capabilities }),
        configuration: event.configuration.map(option =>
          AgentConfigurationOption.make({ ...option }),
        ),
        turns: [],
        itemsById: {},
        itemOrder: [],
        pendingActions: [],
        lastSequence: envelope.sequence,
        revision: 1,
        connectionGeneration: envelope.connectionGeneration,
        createdAt: envelope.occurredAt,
        updatedAt: envelope.receivedAt,
      }),
    })
  }
  if (!snapshot) {
    throw new Error("validated reducer state is missing")
  }

  const state = snapshot.state
  const event = envelope.event
  let next = state

  switch (event.type) {
    case "thread.binding-updated":
      next = withCommittedEnvelope(state, envelope, {
        providerSessionId: event.providerSessionId,
      })
      break
    case "capabilities.updated":
      next = withCommittedEnvelope(state, envelope, {
        capabilities: event.capabilities,
      })
      break
    case "configuration.updated":
      next = withCommittedEnvelope(state, envelope, {
        configuration: event.configuration,
      })
      break
    case "turn.started":
      next = withCommittedEnvelope(state, envelope, {
        status: "running",
        turns: [
          ...state.turns,
          {
            id: event.turnId,
            status: "running",
            itemIds: [],
            startedAt: envelope.occurredAt,
          },
        ],
      })
      break
    case "item.started":
      next = withCommittedEnvelope(state, envelope, {
        itemsById: updateItem(state, event.item),
        itemOrder: [...state.itemOrder, event.item.id],
        turns: replaceTurn(state.turns, event.item.turnId, (turn) => ({
          ...turn,
          itemIds: [...turn.itemIds, event.item.id],
        })),
      })
      break
    case "item.delta": {
      const item = state.itemsById[event.itemId]
      if (!item || (item.type !== "assistant-message" && item.type !== "reasoning")) {
        throw new Error("validated delta target is missing")
      }
      const updated = { ...item, text: item.text + event.text, revision: event.revision }
      next = withCommittedEnvelope(state, envelope, {
        itemsById: updateItem(state, updated),
      })
      break
    }
    case "item.updated":
    case "item.completed":
      next = withCommittedEnvelope(state, envelope, {
        itemsById: updateItem(state, event.item),
      })
      break
    case "action.requested":
      next = withCommittedEnvelope(state, envelope, {
        status: "waiting-for-action",
        pendingActions: [...state.pendingActions, event.action],
      })
      break
    case "action.resolved":
      next = withCommittedEnvelope(state, envelope, {
        status: activeTurn(state) ? "running" : "idle",
        pendingActions: state.pendingActions.filter(
          (action) => action.id !== event.actionId,
        ),
      })
      break
    case "usage.updated":
      next = withCommittedEnvelope(state, envelope, { usage: event.usage })
      break
    case "thread.status-changed":
      next = withCommittedEnvelope(state, envelope, { status: event.status })
      break
    case "turn.completed":
      next = withCommittedEnvelope(state, envelope, {
        status: "idle",
        pendingActions: state.pendingActions.filter(
          action => action.turnId !== event.turnId,
        ),
        turns: replaceTurn(state.turns, event.turnId, (turn) => ({
          ...turn,
          status: "completed",
          completedAt: envelope.occurredAt,
        })),
      })
      break
    case "turn.failed":
      next = withCommittedEnvelope(state, envelope, {
        status: "failed",
        pendingActions: state.pendingActions.filter(
          action => action.turnId !== event.turnId,
        ),
        turns: replaceTurn(state.turns, event.turnId, (turn) => ({
          ...turn,
          status: "failed",
          completedAt: envelope.occurredAt,
          error: {
            message: event.message,
            ...(event.code ? { code: event.code } : {}),
          },
        })),
      })
      break
    case "turn.interrupted":
      next = withCommittedEnvelope(state, envelope, {
        status: "interrupted",
        pendingActions: state.pendingActions.filter(
          action => action.turnId !== event.turnId,
        ),
        turns: replaceTurn(state.turns, event.turnId, (turn) => ({
          ...turn,
          status: "interrupted",
          completedAt: envelope.occurredAt,
        })),
      })
      break
    case "agent.error":
      next = withCommittedEnvelope(state, envelope, { status: "failed" })
      break
    case "thread.closed":
      next = withCommittedEnvelope(state, envelope, {
        status: "closed",
        pendingActions: [],
      })
      break
    case "extension":
      next = withCommittedEnvelope(state, envelope, {})
      break
    case "thread.opened":
      throw new Error("validated reducer cannot reopen a thread")
  }

  return AgentThreadSnapshot.make({
    ...snapshot,
    state: next,
    seenEventIds: appendSeenEventId(snapshot.seenEventIds, envelope.eventId),
  })
}

export function reduceAgentThreadEvent(
  snapshot: AgentThreadSnapshot | undefined,
  envelope: AgentEventEnvelope,
): AgentReduceResult {
  if (snapshot?.seenEventIds.includes(envelope.eventId)) {
    return { status: "ignored", reason: "duplicate-event", snapshot }
  }
  if (
    snapshot &&
    envelope.connectionGeneration < snapshot.state.connectionGeneration
  ) {
    return {
      status: "ignored",
      reason: "stale-connection-generation",
      snapshot,
    }
  }

  const violations = validateAgentThreadEvent(snapshot, envelope)
  if (violations.length > 0) {
    return {
      status: "rejected",
      violations,
      ...(snapshot ? { snapshot } : {}),
    }
  }

  return {
    status: "applied",
    snapshot: applyValidatedEvent(snapshot, envelope),
  }
}

export function replayAgentThreadEvents(
  snapshot: AgentThreadSnapshot | undefined,
  events: ReadonlyArray<AgentEventEnvelope>,
): AgentReduceResult {
  let current = snapshot
  let last: AgentReduceResult | undefined
  for (const event of events) {
    last = reduceAgentThreadEvent(current, event)
    if (last.status === "rejected") return last
    current = last.snapshot
  }
  if (last) return last
  if (!current) {
    return {
      status: "rejected",
      violations: [
        violation("thread.must-open-first", "cannot replay an empty event list"),
      ],
    }
  }
  return { status: "applied", snapshot: current }
}
