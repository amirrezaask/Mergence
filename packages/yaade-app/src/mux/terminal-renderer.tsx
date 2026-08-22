import type { ComponentType } from "react";
import { Terminal } from "lucide-react";
import type {
  TerminalKind,
  MuxTerminal,
  TerminalInput,
} from "@yaade/rpc";
import type { YaadeTheme } from "@yaade/shared";

export type TerminalRendererProps = {
  readonly terminal: MuxTerminal;
  readonly theme: YaadeTheme;
  readonly fontSize: number;
  readonly onTitleChange?: (title: string) => void;
  readonly onAction?: (action: "cancel" | "restart" | "archive") => void;
  readonly visible?: boolean;
  readonly focused?: boolean;
};

type RegistryEntry = {
  readonly kind: TerminalKind;
  readonly label: string;
  readonly icon: typeof Terminal;
  readonly mountPolicy: "keep-alive-lru" | "remountable";
  readonly describeInput: (input: TerminalInput) => string;
  readonly loadRenderer: () => Promise<{
    default: ComponentType<TerminalRendererProps>;
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
      const module = await import("./renderers/TerminalView.js");
      return { default: module.ProcessTerminalView as ComponentType<TerminalRendererProps> };
    },
  },
];

export const terminalRegistry: ReadonlyMap<TerminalKind, RegistryEntry> = new Map(
  entries.map((entry) => [entry.kind, entry]),
);
