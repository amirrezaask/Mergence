import type { ComponentType, ReactNode } from "react";
import { Bot, Search, Terminal } from "lucide-react";
import type {
  CheckoutTarget,
  ProjectSearchResult,
  ProjectTarget,
  ToolKind,
  ToolUse,
  ToolUseInput,
} from "@yaade/rpc";
import type { ProjectSearchOptions, YaadeTheme } from "@yaade/shared";

export type ToolRendererProps = {
  readonly use: ToolUse;
  readonly theme: YaadeTheme;
  readonly toolbar: ReactNode;
  readonly projects: readonly ProjectTarget[];
  readonly onContextChange: (
    project: ProjectTarget,
    checkout: CheckoutTarget,
  ) => Promise<void>;
  readonly onProviderChange?: (provider: string) => Promise<void>;
  readonly results: readonly ProjectSearchResult[];
  readonly onSearchChange: (
    query: string,
    options: ProjectSearchOptions,
  ) => Promise<void>;
  readonly onLoadMore: () => Promise<void>;
  readonly visible?: boolean;
};

type RegistryEntry = {
  readonly kind: ToolKind;
  readonly label: string;
  readonly icon: typeof Bot;
  readonly mountPolicy: "keep-alive-lru" | "remountable";
  readonly describeInput: (input: ToolUseInput) => string;
  readonly loadRenderer: () => Promise<{
    default: ComponentType<ToolRendererProps>;
  }>;
};

async function loadAgentRenderer(): Promise<{
  default: ComponentType<ToolRendererProps>;
}> {
  const module = await import("./renderers/ProcessToolView.js");
  return { default: module.AgentToolView as ComponentType<ToolRendererProps> };
}

async function loadTerminalRenderer(): Promise<{
  default: ComponentType<ToolRendererProps>;
}> {
  const module = await import("./renderers/ProcessToolView.js");
  return {
    default: module.TerminalToolView as ComponentType<ToolRendererProps>,
  };
}

async function loadSearchRenderer(): Promise<{
  default: ComponentType<ToolRendererProps>;
}> {
  const module = await import("./renderers/SearchToolView.js");
  return { default: module.SearchToolView as ComponentType<ToolRendererProps> };
}

const entries: readonly RegistryEntry[] = [
  {
    kind: "agent",
    label: "Agent",
    icon: Bot,
    mountPolicy: "keep-alive-lru",
    describeInput: (input) =>
      input.kind === "agent" ? input.provider : "agent",
    loadRenderer: loadAgentRenderer,
  },
  {
    kind: "terminal",
    label: "Terminal",
    icon: Terminal,
    mountPolicy: "keep-alive-lru",
    describeInput: () => "shell",
    loadRenderer: loadTerminalRenderer,
  },
  {
    kind: "search",
    label: "Search",
    icon: Search,
    mountPolicy: "remountable",
    describeInput: (input) =>
      input.kind === "search" ? input.query || "(empty query)" : "search",
    loadRenderer: loadSearchRenderer,
  },
];

export const toolRegistry: ReadonlyMap<ToolKind, RegistryEntry> = new Map(
  entries.map((entry) => [entry.kind, entry]),
);
