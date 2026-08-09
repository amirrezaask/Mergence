import {
  AgentCapabilities,
  AgentConfigurationOption,
  UnsequencedAgentEvent,
} from "@yaade/agent-protocol"
import { Schema } from "effect"
import { defineScenario, emitEvent, expectCommand, rejectCommand } from "./scenario.js"

export function mockCapabilities(): AgentCapabilities {
  return AgentCapabilities.make({
    input: {
      text: "native",
      images: "native",
      workspaceFiles: "native",
      uploadedFiles: "native",
    },
    threads: {
      load: "native",
      resume: "native",
      fork: "emulated",
      list: "native",
      delete: "native",
    },
    turns: {
      interrupt: "native",
      queue: "unsupported",
      retry: "emulated",
      steer: "unsupported",
    },
    output: {
      reasoning: "native",
      plans: "native",
      usage: "native",
      contextWindow: "native",
      cost: "native",
      subagents: "native",
    },
    tools: {
      streaming: "native",
      parallel: "native",
      terminal: "native",
      fileDiffs: "native",
    },
    interaction: {
      permissions: "native",
      structuredInput: "native",
      externalUrlInput: "native",
    },
    configuration: {
      dynamicOptions: "native",
      slashCommands: "native",
    },
  })
}

function nativeEvent(payload: unknown): UnsequencedAgentEvent {
  return Schema.decodeUnknownSync(UnsequencedAgentEvent)({ event: payload })
}

function identifiedEvent(
  nativeEventId: string,
  providerCursor: string,
  payload: unknown,
): UnsequencedAgentEvent {
  return Schema.decodeUnknownSync(UnsequencedAgentEvent)({
    nativeEventId,
    providerCursor,
    event: payload,
  })
}

export const simpleStreamScenario = defineScenario({
  id: "simple-stream",
  capabilities: mockCapabilities(),
  steps: [
    expectCommand("turn.submit"),
    emitEvent(nativeEvent({ type: "turn.started", turnId: "mock-turn-1" })),
    emitEvent(
      nativeEvent({
        type: "item.started",
        item: {
          type: "assistant-message",
          id: "mock-item-1",
          turnId: "mock-turn-1",
          revision: 1,
          text: "",
          status: "streaming",
        },
      }),
    ),
    emitEvent(
      nativeEvent({
        type: "item.delta",
        itemId: "mock-item-1",
        revision: 2,
        text: "Hello ",
      }),
    ),
    emitEvent(
      nativeEvent({
        type: "item.delta",
        itemId: "mock-item-1",
        revision: 3,
        text: "from mock.",
      }),
    ),
    emitEvent(
      nativeEvent({
        type: "item.completed",
        item: {
          type: "assistant-message",
          id: "mock-item-1",
          turnId: "mock-turn-1",
          revision: 4,
          text: "Hello from mock.",
          status: "completed",
        },
      }),
    ),
    emitEvent(nativeEvent({ type: "turn.completed", turnId: "mock-turn-1" })),
  ],
})

export const permissionRaceScenario = defineScenario({
  id: "permission-race",
  capabilities: mockCapabilities(),
  steps: [
    expectCommand("turn.submit"),
    emitEvent(nativeEvent({ type: "turn.started", turnId: "mock-turn-1" })),
    emitEvent(
      nativeEvent({
        type: "action.requested",
        action: {
          type: "permission",
          id: "mock-permission-1",
          turnId: "mock-turn-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          title: "Update src/auth.ts",
          options: [
            {
              id: "native-allow-once",
              decision: "allow-once",
              label: "Allow once",
            },
            {
              id: "native-reject",
              decision: "reject-once",
              label: "Reject",
            },
          ],
        },
      }),
    ),
    expectCommand("action.respond", (command) => {
      if (command.type !== "action.respond") return "expected action.respond"
      if (command.actionId !== "mock-permission-1") {
        return `unexpected action id ${command.actionId}`
      }
      if (command.response.type !== "permission") {
        return `unexpected response type ${command.response.type}`
      }
      return command.response.optionId === "native-allow-once"
        ? undefined
        : `unexpected permission option ${command.response.optionId}`
    }),
    emitEvent(
      nativeEvent({
        type: "action.resolved",
        actionId: "mock-permission-1",
        response: { type: "permission", optionId: "native-allow-once" },
      }),
    ),
    emitEvent(nativeEvent({ type: "turn.completed", turnId: "mock-turn-1" })),
  ],
})

/** Scenario identifiers reserved for deterministic acceptance fixtures. */
export const requiredMockScenarioIds = [
  "elicitation", "authentication", "attachments", "configuration-change",
  "configuration-rejection", "interrupt", "provider-error", "disconnect",
  "replay-duplicate", "replay-gap", "backpressure", "oversized-output",
  "multi-thread-isolation", "notification-deduplication", "ui-showcase",
] as const

function modelOption(current: "mock-fast" | "mock-deep") {
  return AgentConfigurationOption.make({
    id: "model",
    category: "model",
    label: "Model",
    value: {
    type: "enum",
    current,
    choices: [
      { value: "mock-fast", label: "Mock Fast" },
      { value: "mock-deep", label: "Mock Deep" },
    ],
    },
  })
}

const modelConfiguration = modelOption("mock-fast")

const elicitationScenario = defineScenario({
  id: "elicitation",
  capabilities: mockCapabilities(),
  steps: [
    expectCommand("turn.submit"),
    emitEvent(nativeEvent({ type: "turn.started", turnId: "mock-turn-1" })),
    emitEvent(nativeEvent({
      type: "action.requested",
      action: {
        type: "elicitation",
        id: "mock-elicitation-1",
        turnId: "mock-turn-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        title: "Deployment details",
        description: "Choose the target and confirm.",
        mode: "form",
        fields: [
          { id: "name", label: "Release name", required: true, input: "text" },
          { id: "confirmed", label: "Confirm deployment", required: true, input: "confirm" },
          { id: "region", label: "Region", required: true, input: "single-select", choices: [
            { id: "eu", label: "Europe" }, { id: "us", label: "United States" },
          ] },
        ],
      },
    })),
    expectCommand("action.respond", command =>
      command.type === "action.respond" &&
      command.actionId === "mock-elicitation-1" &&
      command.response.type === "elicitation"
        ? undefined
        : "expected elicitation response for mock-elicitation-1"),
    emitEvent(nativeEvent({
      type: "action.resolved",
      actionId: "mock-elicitation-1",
      response: { type: "elicitation", values: { name: "release", confirmed: true, region: "eu" } },
    })),
    emitEvent(nativeEvent({ type: "turn.completed", turnId: "mock-turn-1" })),
  ],
})

const authenticationScenario = defineScenario({
  id: "authentication",
  capabilities: mockCapabilities(),
  steps: [
    expectCommand("turn.submit"),
    emitEvent(nativeEvent({ type: "turn.started", turnId: "mock-turn-1" })),
    emitEvent(nativeEvent({
      type: "action.requested",
      action: {
        type: "authentication",
        id: "mock-auth-1",
        turnId: "mock-turn-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        title: "Sign in to Mock Cloud",
        description: "Complete authentication in the browser.",
        url: "https://example.invalid/mock-auth",
      },
    })),
    expectCommand("action.respond", command =>
      command.type === "action.respond" &&
      command.actionId === "mock-auth-1" &&
      command.response.type === "authentication"
        ? undefined
        : "expected authentication response for mock-auth-1"),
    emitEvent(nativeEvent({
      type: "action.resolved",
      actionId: "mock-auth-1",
      response: { type: "authentication", status: "completed" },
    })),
    emitEvent(nativeEvent({ type: "turn.completed", turnId: "mock-turn-1" })),
  ],
})

const attachmentsScenario = defineScenario({
  id: "attachments",
  capabilities: mockCapabilities(),
  steps: [
    expectCommand("turn.submit", command => command.type === "turn.submit" &&
      command.input.some(part => part.type === "attachment" || part.type === "workspace-resource")
      ? undefined
      : "expected an attachment or workspace resource"),
    emitEvent(nativeEvent({ type: "turn.started", turnId: "mock-turn-1" })),
    emitEvent(nativeEvent({ type: "turn.completed", turnId: "mock-turn-1" })),
  ],
})

const configurationChangeScenario = defineScenario({
  id: "configuration-change",
  capabilities: mockCapabilities(),
  configuration: [modelConfiguration],
  steps: [
    expectCommand("configuration.set", command => command.type === "configuration.set" &&
      command.optionId === "model" && command.value === "mock-deep"
      ? undefined
      : "expected model=mock-deep"),
    emitEvent(nativeEvent({
      type: "configuration.updated",
      configuration: [modelOption("mock-deep")],
    })),
    expectCommand("turn.submit"),
    emitEvent(nativeEvent({ type: "turn.started", turnId: "mock-turn-1" })),
    emitEvent(nativeEvent({ type: "turn.completed", turnId: "mock-turn-1" })),
  ],
})

const configurationRejectionScenario = defineScenario({
  id: "configuration-rejection",
  capabilities: mockCapabilities(),
  configuration: [modelConfiguration],
  steps: [
    rejectCommand("configuration.set", {
      code: "mock.configuration-locked",
      message: "Configuration is locked for this thread",
      retryable: false,
    }),
    expectCommand("turn.submit"),
    emitEvent(nativeEvent({ type: "turn.started", turnId: "mock-turn-1" })),
    emitEvent(nativeEvent({ type: "turn.completed", turnId: "mock-turn-1" })),
  ],
})

const interruptScenario = defineScenario({
  id: "interrupt",
  capabilities: mockCapabilities(),
  steps: [
    expectCommand("turn.submit"),
    emitEvent(nativeEvent({ type: "turn.started", turnId: "mock-turn-1" })),
    emitEvent(nativeEvent({ type: "item.started", item: {
      type: "assistant-message", id: "mock-interrupt-item", turnId: "mock-turn-1",
      revision: 1, text: "", status: "streaming",
    } })),
    emitEvent(nativeEvent({ type: "item.delta", itemId: "mock-interrupt-item", revision: 2, text: "Working…" })),
    expectCommand("turn.interrupt", command => command.type === "turn.interrupt" && command.turnId === "mock-turn-1"
      ? undefined : "expected interrupt for mock-turn-1"),
    emitEvent(nativeEvent({ type: "item.completed", item: {
      type: "assistant-message", id: "mock-interrupt-item", turnId: "mock-turn-1",
      revision: 3, text: "Working…", status: "cancelled",
    } })),
    emitEvent(nativeEvent({ type: "turn.interrupted", turnId: "mock-turn-1" })),
  ],
})

function terminalScenario(
  id: string,
  terminal: unknown,
  preceding: ReadonlyArray<UnsequencedAgentEvent> = [],
) {
  return defineScenario({
    id,
    capabilities: mockCapabilities(),
    steps: [
      expectCommand("turn.submit"),
      emitEvent(nativeEvent({ type: "turn.started", turnId: "mock-turn-1" })),
      ...preceding.map(emitEvent),
      emitEvent(nativeEvent(terminal)),
    ],
  })
}

const providerErrorScenario = terminalScenario("provider-error", {
  type: "turn.failed", turnId: "mock-turn-1", message: "Mock provider failed", code: "mock.provider",
}, [nativeEvent({ type: "agent.error", message: "Mock provider failed", code: "mock.provider", retryable: true })])

const disconnectScenario = terminalScenario("disconnect", {
  type: "turn.failed", turnId: "mock-turn-1", message: "Mock provider disconnected", code: "mock.disconnect",
}, [nativeEvent({ type: "agent.error", message: "Mock provider disconnected", code: "mock.disconnect", retryable: true })])

const replayDuplicateScenario = defineScenario({
  id: "replay-duplicate",
  capabilities: mockCapabilities(),
  steps: [
    expectCommand("turn.submit"),
    emitEvent(identifiedEvent("mock:duplicate", "1", { type: "turn.started", turnId: "mock-turn-1" })),
    emitEvent(identifiedEvent("mock:duplicate", "1", { type: "turn.started", turnId: "mock-turn-1" })),
    emitEvent(identifiedEvent("mock:complete", "2", { type: "turn.completed", turnId: "mock-turn-1" })),
  ],
})

const replayGapScenario = terminalScenario("replay-gap", {
  type: "turn.completed", turnId: "mock-turn-1",
}, [identifiedEvent("mock:cursor-3", "3", {
  type: "extension", namespace: "mock-recovery", name: "provider-cursor-gap", payload: { expected: "2", received: "3" },
})])

const backpressureDeltas = Array.from({ length: 128 }, (_, index) => nativeEvent({
  type: "item.delta", itemId: "mock-fast-item", revision: index + 2, text: `${index.toString(16).padStart(2, "0")} `,
}))
const backpressureScenario = terminalScenario("backpressure", {
  type: "turn.completed", turnId: "mock-turn-1",
}, [nativeEvent({ type: "item.started", item: {
  type: "assistant-message", id: "mock-fast-item", turnId: "mock-turn-1", revision: 1, text: "", status: "streaming",
} }), ...backpressureDeltas, nativeEvent({ type: "item.completed", item: {
  type: "assistant-message", id: "mock-fast-item", turnId: "mock-turn-1", revision: 130,
  text: backpressureDeltas.map(event => event.event.type === "item.delta" ? event.event.text : "").join(""), status: "completed",
} })])

const oversizedOutputScenario = terminalScenario("oversized-output", {
  type: "turn.failed", turnId: "mock-turn-1", message: "Oversized output rejected", code: "mock.output-too-large",
}, [nativeEvent({ type: "item.started", item: {
  type: "assistant-message", id: "mock-oversized-item", turnId: "mock-turn-1", revision: 1, text: "", status: "streaming",
} }), nativeEvent({ type: "item.delta", itemId: "mock-oversized-item", revision: 2, text: "x".repeat(70 * 1024) })])

const multiThreadIsolationScenario = terminalScenario("multi-thread-isolation", {
  type: "turn.completed", turnId: "mock-turn-1",
}, [nativeEvent({ type: "extension", namespace: "mock-isolation", name: "connection", payload: { isolated: true } })])

const notificationDeduplicationScenario = defineScenario({
  id: "notification-deduplication",
  capabilities: mockCapabilities(),
  steps: [
    expectCommand("turn.submit"),
    emitEvent(identifiedEvent("mock:turn-start", "1", { type: "turn.started", turnId: "mock-turn-1" })),
    emitEvent(identifiedEvent("mock:turn-complete", "2", { type: "turn.completed", turnId: "mock-turn-1" })),
    emitEvent(identifiedEvent("mock:turn-complete", "2", { type: "turn.completed", turnId: "mock-turn-1" })),
  ],
})

/** Rich, deterministic product-demo flow rendered by `pnpm agent:demo`. */
export const uiShowcaseScenario = defineScenario({
  id: "ui-showcase",
  capabilities: mockCapabilities(),
  steps: [
    expectCommand("turn.submit"),
    emitEvent(nativeEvent({ type: "turn.started", turnId: "showcase-turn" })),
    emitEvent(nativeEvent({
      type: "item.started",
      item: {
        type: "user-message",
        id: "showcase-user",
        turnId: "showcase-turn",
        revision: 1,
        content: [{
          type: "text",
          text: "Review the authentication flow, fix the failing test, and verify the result.",
        }],
      },
    })),
    emitEvent(nativeEvent({
      type: "item.started",
      item: {
        type: "reasoning",
        id: "showcase-reasoning",
        turnId: "showcase-turn",
        revision: 1,
        text: "",
        status: "streaming",
      },
    })),
    emitEvent(nativeEvent({
      type: "item.delta",
      itemId: "showcase-reasoning",
      revision: 2,
      text: "I’ll inspect the auth middleware and its tests, then make the smallest safe change.",
    })),
    emitEvent(nativeEvent({
      type: "item.completed",
      item: {
        type: "reasoning",
        id: "showcase-reasoning",
        turnId: "showcase-turn",
        revision: 3,
        text: "I’ll inspect the auth middleware and its tests, then make the smallest safe change.",
        status: "completed",
      },
    })),
    emitEvent(nativeEvent({
      type: "item.started",
      item: {
        type: "plan",
        id: "showcase-plan",
        turnId: "showcase-turn",
        revision: 1,
        title: "Fix authentication regression",
        entries: [
          { id: "inspect", text: "Inspect the middleware and failing test", status: "in-progress" },
          { id: "patch", text: "Apply the focused fix", status: "pending" },
          { id: "verify", text: "Run the targeted tests", status: "pending" },
        ],
        status: "active",
      },
    })),
    emitEvent(nativeEvent({
      type: "item.started",
      item: {
        type: "tool-call",
        id: "showcase-read",
        turnId: "showcase-turn",
        revision: 1,
        nativeName: "read_file",
        category: "file.read",
        title: "Read src/auth.ts",
        description: "Inspecting the token validation branch.",
        status: "running",
      },
    })),
    emitEvent(nativeEvent({
      type: "item.completed",
      item: {
        type: "tool-call",
        id: "showcase-read",
        turnId: "showcase-turn",
        revision: 2,
        nativeName: "read_file",
        category: "file.read",
        title: "Read src/auth.ts",
        description: "Found the expired-token branch returning the wrong status.",
        status: "completed",
        output: [{ type: "text", text: "return unauthorized(403)" }],
      },
    })),
    emitEvent(nativeEvent({
      type: "item.started",
      item: {
        type: "tool-call",
        id: "showcase-test",
        turnId: "showcase-turn",
        revision: 1,
        nativeName: "exec_command",
        category: "shell",
        title: "Run authentication tests",
        description: "pnpm test -- auth",
        status: "running",
        progress: { current: 1, total: 3, message: "1 failing · 12 passing" },
      },
    })),
    emitEvent(nativeEvent({
      type: "item.completed",
      item: {
        type: "tool-call",
        id: "showcase-test",
        turnId: "showcase-turn",
        revision: 2,
        nativeName: "exec_command",
        category: "shell",
        title: "Run authentication tests",
        description: "Confirmed the regression before editing.",
        status: "completed",
        output: [{ type: "text", text: "1 failing · 12 passing" }],
      },
    })),
    emitEvent(nativeEvent({
      type: "item.updated",
      item: {
        type: "plan",
        id: "showcase-plan",
        turnId: "showcase-turn",
        revision: 2,
        title: "Fix authentication regression",
        entries: [
          { id: "inspect", text: "Inspect the middleware and failing test", status: "completed" },
          { id: "patch", text: "Apply the focused fix", status: "in-progress" },
          { id: "verify", text: "Run the targeted tests", status: "pending" },
        ],
        status: "active",
      },
    })),
    emitEvent(nativeEvent({
      type: "action.requested",
      action: {
        type: "permission",
        id: "showcase-permission",
        turnId: "showcase-turn",
        createdAt: "2026-01-01T00:00:00.000Z",
        title: "Apply the authentication fix?",
        description: "Change the expired-token response in src/auth.ts from 403 to 401.",
        options: [
          { id: "showcase-allow", decision: "allow-once", label: "Apply fix" },
          { id: "showcase-reject", decision: "reject-once", label: "Reject" },
        ],
      },
    })),
    expectCommand("action.respond", command =>
      command.type === "action.respond" &&
      command.actionId === "showcase-permission" &&
      command.response.type === "permission" &&
      command.response.optionId === "showcase-allow"
        ? undefined
        : "expected the advertised showcase permission option"),
    emitEvent(nativeEvent({
      type: "action.resolved",
      actionId: "showcase-permission",
      response: { type: "permission", optionId: "showcase-allow" },
    })),
    emitEvent(nativeEvent({
      type: "item.started",
      item: {
        type: "tool-call",
        id: "showcase-edit",
        turnId: "showcase-turn",
        revision: 1,
        nativeName: "apply_patch",
        category: "file.write",
        title: "Update src/auth.ts",
        description: "Applying the one-line status-code correction.",
        status: "running",
      },
    })),
    emitEvent(nativeEvent({
      type: "item.started",
      item: {
        type: "diff",
        id: "showcase-diff",
        turnId: "showcase-turn",
        revision: 1,
        uri: "file:///workspace/src/auth.ts",
        patch: "- return unauthorized(403)\n+ return unauthorized(401)",
        status: "proposed",
      },
    })),
    emitEvent(nativeEvent({
      type: "item.completed",
      item: {
        type: "diff",
        id: "showcase-diff",
        turnId: "showcase-turn",
        revision: 2,
        uri: "file:///workspace/src/auth.ts",
        patch: "- return unauthorized(403)\n+ return unauthorized(401)",
        status: "applied",
      },
    })),
    emitEvent(nativeEvent({
      type: "item.completed",
      item: {
        type: "tool-call",
        id: "showcase-edit",
        turnId: "showcase-turn",
        revision: 2,
        nativeName: "apply_patch",
        category: "file.write",
        title: "Update src/auth.ts",
        description: "Changed the expired-token response to 401.",
        status: "completed",
      },
    })),
    emitEvent(nativeEvent({
      type: "item.started",
      item: {
        type: "tool-call",
        id: "showcase-verify",
        turnId: "showcase-turn",
        revision: 1,
        nativeName: "exec_command",
        category: "shell",
        title: "Verify authentication tests",
        description: "pnpm test -- auth",
        status: "running",
        progress: { current: 2, total: 3, message: "Running targeted suite…" },
      },
    })),
    emitEvent(nativeEvent({
      type: "item.completed",
      item: {
        type: "tool-call",
        id: "showcase-verify",
        turnId: "showcase-turn",
        revision: 2,
        nativeName: "exec_command",
        category: "shell",
        title: "Verify authentication tests",
        description: "All targeted checks passed.",
        status: "completed",
        output: [{ type: "text", text: "13 passing · 0 failing" }],
      },
    })),
    emitEvent(nativeEvent({
      type: "item.completed",
      item: {
        type: "plan",
        id: "showcase-plan",
        turnId: "showcase-turn",
        revision: 3,
        title: "Fix authentication regression",
        entries: [
          { id: "inspect", text: "Inspect the middleware and failing test", status: "completed" },
          { id: "patch", text: "Apply the focused fix", status: "completed" },
          { id: "verify", text: "Run the targeted tests", status: "completed" },
        ],
        status: "completed",
      },
    })),
    emitEvent(nativeEvent({
      type: "item.started",
      item: {
        type: "assistant-message",
        id: "showcase-answer",
        turnId: "showcase-turn",
        revision: 1,
        text: "",
        status: "streaming",
      },
    })),
    emitEvent(nativeEvent({
      type: "item.delta",
      itemId: "showcase-answer",
      revision: 2,
      text: "Fixed the expired-token response in src/auth.ts. ",
    })),
    emitEvent(nativeEvent({
      type: "item.delta",
      itemId: "showcase-answer",
      revision: 3,
      text: "The authentication suite now passes all 13 tests.",
    })),
    emitEvent(nativeEvent({
      type: "item.completed",
      item: {
        type: "assistant-message",
        id: "showcase-answer",
        turnId: "showcase-turn",
        revision: 4,
        text: "Fixed the expired-token response in src/auth.ts. The authentication suite now passes all 13 tests.",
        status: "completed",
      },
    })),
    emitEvent(nativeEvent({
      type: "usage.updated",
      usage: {
        inputTokens: 1_248,
        outputTokens: 384,
        cachedInputTokens: 768,
        contextWindowTokens: 32_000,
        costUsd: 0,
      },
    })),
    emitEvent(nativeEvent({ type: "turn.completed", turnId: "showcase-turn" })),
  ],
})

export const mockScenarios = {
  [simpleStreamScenario.id]: simpleStreamScenario,
  [permissionRaceScenario.id]: permissionRaceScenario,
  [elicitationScenario.id]: elicitationScenario,
  [authenticationScenario.id]: authenticationScenario,
  [attachmentsScenario.id]: attachmentsScenario,
  [configurationChangeScenario.id]: configurationChangeScenario,
  [configurationRejectionScenario.id]: configurationRejectionScenario,
  [interruptScenario.id]: interruptScenario,
  [providerErrorScenario.id]: providerErrorScenario,
  [disconnectScenario.id]: disconnectScenario,
  [replayDuplicateScenario.id]: replayDuplicateScenario,
  [replayGapScenario.id]: replayGapScenario,
  [backpressureScenario.id]: backpressureScenario,
  [oversizedOutputScenario.id]: oversizedOutputScenario,
  [multiThreadIsolationScenario.id]: multiThreadIsolationScenario,
  [notificationDeduplicationScenario.id]: notificationDeduplicationScenario,
  [uiShowcaseScenario.id]: uiShowcaseScenario,
}
