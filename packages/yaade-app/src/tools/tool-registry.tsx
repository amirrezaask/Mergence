import type { ComponentType, ReactNode } from "react";
import { Bot, Code2, GitBranch, Search, Terminal } from "lucide-react";
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
  readonly fontSize: number;
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
  readonly onTitleChange?: (title: string) => void;
  readonly onAction?: (action: "cancel" | "restart" | "archive") => void;
  readonly onOpenLocation?: (location: {
    readonly path: string;
    readonly line: number;
    readonly column: number;
  }) => Promise<void>;
  readonly visible?: boolean;
  readonly focused?: boolean;
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

async function loadGitRenderer(): Promise<{
  default: ComponentType<ToolRendererProps>;
}> {
  const module = await import("./renderers/GitToolView.js");
  return { default: module.GitToolView as ComponentType<ToolRendererProps> };
}

async function loadEditorRenderer(): Promise<{
  default: ComponentType<ToolRendererProps>;
}> {
  const module = await import("./renderers/EditorToolView.js");
  return { default: module.EditorToolView as ComponentType<ToolRendererProps> };
}

async function loadNeovimRenderer(): Promise<{
  default: ComponentType<ToolRendererProps>;
}> {
  const module = await import("./renderers/NeovimToolView.js");
  return { default: module.NeovimToolView as ComponentType<ToolRendererProps> };
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
  {
    kind: "git",
    label: "Git History",
    icon: GitBranch,
    mountPolicy: "remountable",
    describeInput: () => "history",
    loadRenderer: loadGitRenderer,
  },
  {
    kind: "editor",
    label: "Editor",
    icon: Code2,
    mountPolicy: "remountable",
    describeInput: () => "workspace",
    loadRenderer: loadEditorRenderer,
  },
  {
    kind: "neovim",
    label: "Neovim",
    icon: Code2,
    mountPolicy: "remountable",
    describeInput: () => "native editor",
    loadRenderer: loadNeovimRenderer,
  },
];

export const toolRegistry: ReadonlyMap<ToolKind, RegistryEntry> = new Map(
  entries.map((entry) => [entry.kind, entry]),
);
