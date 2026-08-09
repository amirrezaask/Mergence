/** Branded open slug naming a driver implementation (e.g. `codex`, `claudeAgent`). */
export type ProviderDriverKind = string & { readonly __brand?: "ProviderDriverKind" };
export const ProviderDriverKind = {
  make: (s: string): ProviderDriverKind => s as ProviderDriverKind,
};

/** Branded slug identifying a configured provider instance. */
export type ProviderInstanceId = string & { readonly __brand?: "ProviderInstanceId" };
export const ProviderInstanceId = {
  make: (s: string): ProviderInstanceId => s as ProviderInstanceId,
};

export type ProviderOptionChoice = {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
};

export type SelectProviderOptionDescriptor = {
  id: string;
  label: string;
  description?: string;
  type: "select";
  options: ReadonlyArray<ProviderOptionChoice>;
  currentValue?: string;
  promptInjectedValues?: ReadonlyArray<string>;
};

export type BooleanProviderOptionDescriptor = {
  id: string;
  label: string;
  description?: string;
  type: "boolean";
  currentValue?: boolean;
};

export type ProviderOptionDescriptor =
  | SelectProviderOptionDescriptor
  | BooleanProviderOptionDescriptor;

export type ProviderOptionSelection = {
  id: string;
  value: string | boolean;
};

export type ModelCapabilities = {
  optionDescriptors?: ReadonlyArray<ProviderOptionDescriptor>;
};

export type ModelSelection = {
  provider: ProviderDriverKind;
  instanceId: ProviderInstanceId;
  model: string;
  options?: ReadonlyArray<ProviderOptionSelection>;
};

export type ServerProviderModel = {
  slug: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  isCustom: boolean;
  isDefault?: boolean;
  isLegacy?: boolean;
  capabilities: ModelCapabilities | null;
};

export const DEFAULT_MODEL = "gpt-5.6-sol";

const CODEX = ProviderDriverKind.make("codex");
const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CURSOR = ProviderDriverKind.make("cursor");
const GROK = ProviderDriverKind.make("grok");
const OPENCODE = ProviderDriverKind.make("opencode");

export const DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
  [CODEX]: DEFAULT_MODEL,
  [CLAUDE]: "claude-sonnet-5",
  [CURSOR]: "auto",
  [GROK]: "grok-build",
  [OPENCODE]: "openai/gpt-5",
};

export const MODEL_SLUG_ALIASES_BY_PROVIDER: Record<string, Record<string, string>> = {
  [CODEX]: {
    "gpt-5-codex": "gpt-5.4",
    "5.4": "gpt-5.4",
    "5.3": "gpt-5.3-codex",
    "gpt-5.3": "gpt-5.3-codex",
    "5.3-spark": "gpt-5.3-codex-spark",
    "gpt-5.3-spark": "gpt-5.3-codex-spark",
  },
  [CLAUDE]: {
    opus: "claude-opus-5",
    "opus-5": "claude-opus-5",
    "claude-opus-5.0": "claude-opus-5",
    "claude-opus-5-0": "claude-opus-5",
    "opus-4.8": "claude-opus-4-8",
    "claude-opus-4.8": "claude-opus-4-8",
    "opus-4.7": "claude-opus-4-7",
    "claude-opus-4.7": "claude-opus-4-7",
    "opus-4.6": "claude-opus-4-6",
    "claude-opus-4.6": "claude-opus-4-6",
    "claude-opus-4-6-20251117": "claude-opus-4-6",
    sonnet: "claude-sonnet-5",
    "sonnet-5": "claude-sonnet-5",
    "claude-sonnet-5.0": "claude-sonnet-5",
    "claude-sonnet-5-0": "claude-sonnet-5",
    "sonnet-4.6": "claude-sonnet-4-6",
    "claude-sonnet-4.6": "claude-sonnet-4-6",
    "claude-sonnet-4-6-20251117": "claude-sonnet-4-6",
    haiku: "claude-haiku-4-5",
    "haiku-4.5": "claude-haiku-4-5",
    "claude-haiku-4.5": "claude-haiku-4-5",
    "claude-haiku-4-5-20251001": "claude-haiku-4-5",
  },
  [CURSOR]: {
    composer: "composer-2",
    "composer-1.5": "composer-1.5",
    "composer-1": "composer-1.5",
    "opus-4.6-thinking": "claude-opus-4-6",
    "opus-4.6": "claude-opus-4-6",
    "sonnet-4.6-thinking": "claude-sonnet-4-6",
    "sonnet-4.6": "claude-sonnet-4-6",
    "opus-4.5-thinking": "claude-opus-4-5",
    "opus-4.5": "claude-opus-4-5",
  },
  [OPENCODE]: {},
};

/** Loose keybindings shape for composer UI; full resolution lives on the host. */
export type ResolvedKeybindingsConfig = Record<string, unknown> | undefined;

export const PROVIDER_SEND_TURN_MAX_ATTACHMENTS = 20;
export const PROVIDER_SEND_TURN_MAX_IMAGE_BYTES = 10_000_000;
