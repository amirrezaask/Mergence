import type { ComponentType } from "react";
import { GitBranch, Terminal } from "lucide-react";
import type {
  CheckoutTarget,
  ProjectTarget,
  ToolKind,
  ToolUse,
  ToolUseInput,
} from "@yaade/rpc";
import type { YaadeTheme } from "@yaade/shared";

export type ToolRendererProps = {
  readonly use: ToolUse;
  readonly theme: YaadeTheme;
  readonly fontSize: number;
  readonly projects: readonly ProjectTarget[];
  readonly onContextChange: (
    project: ProjectTarget,
    checkout: CheckoutTarget,
  ) => Promise<void>;
  readonly onTitleChange?: (title: string) => void;
  readonly onCwdChange?: (cwdPath: string) => void;
  readonly onAction?: (action: "cancel" | "restart" | "archive") => void;
  readonly visible?: boolean;
  readonly focused?: boolean;
};

type RegistryEntry = {
  readonly kind: ToolKind;
  readonly label: string;
  readonly icon: typeof Terminal;
  readonly mountPolicy: "keep-alive-lru" | "remountable";
  readonly describeInput: (input: ToolUseInput) => string;
  readonly loadRenderer: () => Promise<{
    default: ComponentType<ToolRendererProps>;
  }>;
};

const entries: readonly RegistryEntry[] = [
  {
    kind: "terminal",
    label: "Terminal",
    icon: Terminal,
    mountPolicy: "keep-alive-lru",
    describeInput: () => "shell",
    loadRenderer: async () => {
      const module = await import("./renderers/ProcessToolView.js");
      return { default: module.ProcessToolView as ComponentType<ToolRendererProps> };
    },
  },
  {
    kind: "git",
    label: "Git History",
    icon: GitBranch,
    mountPolicy: "remountable",
    describeInput: () => "history",
    loadRenderer: async () => {
      const module = await import("./renderers/GitToolView.js");
      return { default: module.GitToolView as ComponentType<ToolRendererProps> };
    },
  },
];

export const toolRegistry: ReadonlyMap<ToolKind, RegistryEntry> = new Map(
  entries.map((entry) => [entry.kind, entry]),
);
