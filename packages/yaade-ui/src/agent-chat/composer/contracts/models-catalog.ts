import { createModelCapabilities } from "./model.js";
import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  type ProviderOptionChoice,
  type ProviderOptionDescriptor,
  type ServerProviderModel,
} from "./types.js";

export type ComposerProviderId =
  | "cursor"
  | "codex"
  | "claudeAgent"
  | "grok"
  | "opencode"
  | "mock";

function selectOption(
  id: string,
  label: string,
  options: ReadonlyArray<ProviderOptionChoice>,
  extras?: {
    currentValue?: string;
    promptInjectedValues?: ReadonlyArray<string>;
    description?: string;
  },
): ProviderOptionDescriptor {
  return {
    id,
    label,
    type: "select",
    options,
    ...extras,
  };
}

function booleanOption(
  id: string,
  label: string,
  currentValue?: boolean,
): ProviderOptionDescriptor {
  return {
    id,
    label,
    type: "boolean",
    ...(typeof currentValue === "boolean" ? { currentValue } : {}),
  };
}

const REASONING_EFFORT_OPTIONS: ReadonlyArray<ProviderOptionChoice> = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium", isDefault: true },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High" },
];

const CLAUDE_EFFORT_OPTIONS: ReadonlyArray<ProviderOptionChoice> = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High", isDefault: true },
  { id: "xhigh", label: "Extra High" },
  { id: "max", label: "Max" },
  { id: "ultrathink", label: "Ultrathink" },
];

const CATALOG: Record<ComposerProviderId, ReadonlyArray<ServerProviderModel>> = {
  cursor: [
    {
      slug: "auto",
      name: "Auto",
      isCustom: false,
      isDefault: true,
      capabilities: createModelCapabilities({
        optionDescriptors: [
          selectOption("reasoningEffort", "Reasoning", REASONING_EFFORT_OPTIONS, {
            currentValue: "medium",
          }),
          booleanOption("fastMode", "Fast Mode", false),
        ],
      }),
    },
    {
      slug: "composer-2",
      name: "Composer 2",
      isCustom: false,
      capabilities: createModelCapabilities({
        optionDescriptors: [
          selectOption("reasoningEffort", "Reasoning", REASONING_EFFORT_OPTIONS, {
            currentValue: "medium",
          }),
          booleanOption("thinking", "Thinking", true),
          booleanOption("fastMode", "Fast Mode", false),
        ],
      }),
    },
  ],
  mock: [
    {
      slug: "mock-fast",
      name: "Mock Fast",
      isCustom: false,
      isDefault: true,
      capabilities: createModelCapabilities({
        optionDescriptors: [booleanOption("fastMode", "Fast Mode", true)],
      }),
    },
    {
      slug: "mock-deep",
      name: "Mock Deep",
      isCustom: false,
      capabilities: createModelCapabilities({
        optionDescriptors: [
          selectOption("reasoningEffort", "Reasoning", [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High", isDefault: true },
            { id: "max", label: "Max" },
          ]),
        ],
      }),
    },
  ],
  codex: [
    {
      slug: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      isCustom: false,
      isDefault: true,
      capabilities: createModelCapabilities({
        optionDescriptors: [
          selectOption("reasoningEffort", "Reasoning", REASONING_EFFORT_OPTIONS, {
            currentValue: "medium",
          }),
          booleanOption("fastMode", "Fast Mode", false),
        ],
      }),
    },
    {
      slug: "gpt-5.6-terra",
      name: "GPT-5.6 Terra",
      isCustom: false,
      capabilities: createModelCapabilities({
        optionDescriptors: [
          selectOption("reasoningEffort", "Reasoning", REASONING_EFFORT_OPTIONS, {
            currentValue: "high",
          }),
        ],
      }),
    },
  ],
  claudeAgent: [
    {
      slug: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      isCustom: false,
      isDefault: true,
      capabilities: createModelCapabilities({
        optionDescriptors: [
          selectOption("effort", "Reasoning", CLAUDE_EFFORT_OPTIONS, {
            currentValue: "high",
            promptInjectedValues: ["ultrathink"],
          }),
          booleanOption("thinking", "Thinking", true),
        ],
      }),
    },
    {
      slug: "claude-opus-5",
      name: "Claude Opus 5",
      isCustom: false,
      capabilities: createModelCapabilities({
        optionDescriptors: [
          selectOption("effort", "Reasoning", CLAUDE_EFFORT_OPTIONS, {
            currentValue: "high",
            promptInjectedValues: ["ultrathink"],
          }),
          booleanOption("fastMode", "Fast Mode", false),
        ],
      }),
    },
  ],
  grok: [
    {
      slug: "grok-build",
      name: "Grok Build",
      isCustom: false,
      isDefault: true,
      capabilities: createModelCapabilities({
        optionDescriptors: [
          selectOption("reasoningEffort", "Reasoning", [
            { id: "low", label: "Low" },
            { id: "high", label: "High", isDefault: true },
          ]),
        ],
      }),
    },
    {
      slug: "grok-code",
      name: "Grok Code",
      isCustom: false,
      capabilities: null,
    },
  ],
  opencode: [
    {
      slug: "openai/gpt-5",
      name: "GPT-5",
      shortName: "gpt-5",
      subProvider: "openai",
      isCustom: false,
      isDefault: true,
      capabilities: createModelCapabilities({
        optionDescriptors: [
          selectOption("reasoningEffort", "Reasoning", REASONING_EFFORT_OPTIONS, {
            currentValue: "medium",
          }),
        ],
      }),
    },
    {
      slug: "anthropic/claude-sonnet-4",
      name: "Claude Sonnet 4",
      shortName: "sonnet-4",
      subProvider: "anthropic",
      isCustom: false,
      capabilities: createModelCapabilities({
        optionDescriptors: [booleanOption("thinking", "Thinking", false)],
      }),
    },
  ],
};

const ALIASES: Record<string, ComposerProviderId> = {
  cursor: "cursor",
  codex: "codex",
  claudeAgent: "claudeAgent",
  claude: "claudeAgent",
  grok: "grok",
  opencode: "opencode",
  mock: "mock",
  "mock-acp": "mock",
  mockAcp: "mock",
};

export function getCatalogModels(provider: string): ServerProviderModel[] {
  const key = ALIASES[provider];
  if (!key) return [];
  return CATALOG[key].map((model) => ({
    ...model,
    ...(model.capabilities
      ? {
          capabilities: createModelCapabilities({
            optionDescriptors: model.capabilities.optionDescriptors ?? [],
          }),
        }
      : { capabilities: null }),
  }));
}

export function getDefaultModelSlug(provider: string): string {
  const key = ALIASES[provider];
  if (!key) {
    return DEFAULT_MODEL_BY_PROVIDER[provider] ?? DEFAULT_MODEL;
  }
  const models = CATALOG[key];
  const markedDefault = models.find((model) => model.isDefault);
  if (markedDefault) return markedDefault.slug;
  return DEFAULT_MODEL_BY_PROVIDER[key] ?? models[0]?.slug ?? DEFAULT_MODEL;
}
