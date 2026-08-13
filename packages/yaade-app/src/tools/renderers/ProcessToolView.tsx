import { lazy, Suspense, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import type { CheckoutTarget, ProjectTarget, ToolUse } from "@yaade/rpc";
import type { ProjectSearchOptions, YaadeTheme } from "@yaade/shared";
import { pathToFileUri } from "@yaade/shared";
import {
  ToolContextControls,
  type AgentProvider,
} from "../ToolContextControls.js";

const TerminalPanel = lazy(() =>
  import("@yaade/ui/terminal").then((module) => ({
    default: module.TerminalPanel,
  })),
);

export type ProcessToolViewProps = {
  readonly use: ToolUse;
  readonly theme: YaadeTheme;
  readonly toolbar: ReactNode;
  readonly projects: readonly ProjectTarget[];
  readonly onContextChange: (
    project: ProjectTarget,
    checkout: CheckoutTarget,
  ) => Promise<void>;
  readonly onProviderChange?: (provider: string) => Promise<void>;
  readonly visible?: boolean;
  readonly results?: unknown;
  readonly onSearchChange?: (
    query: string,
    options: ProjectSearchOptions,
  ) => Promise<void>;
  readonly onLoadMore?: () => Promise<void>;
};

export function ProcessToolView({
  use,
  theme,
  toolbar,
  projects,
  onContextChange,
  onProviderChange,
  visible = true,
}: ProcessToolViewProps) {
  if (use.output.kind !== "process") return null;
  const status =
    use.output.processState === "disconnected"
      ? "failed"
      : use.output.processState;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {toolbar}
      <ToolContextControls
        use={use}
        projects={projects}
        active={visible}
        onChange={onContextChange}
        onProviderChange={
          onProviderChange
            ? (provider: AgentProvider) => onProviderChange(provider)
            : undefined
        }
      />
      <Suspense
        fallback={
          <div className="grid flex-1 place-items-center text-sm text-muted-foreground">
            <LoaderCircle className="mr-2 size-4 animate-spin" />
            Opening terminal…
          </div>
        }
      >
        <TerminalPanel
          cwdRootUri={pathToFileUri(use.context.checkoutPath)}
          theme={theme}
          tabId={use.id}
          focused={visible}
          isActive={visible}
          existingPtyId={use.output.ptyId}
          sessionGeneration={use.output.generation}
          status={status}
          attachOnly
          visible={visible}
        />
      </Suspense>
    </div>
  );
}

export function AgentToolView(props: ProcessToolViewProps) {
  return <ProcessToolView {...props} />;
}

export function TerminalToolView(props: ProcessToolViewProps) {
  return <ProcessToolView {...props} />;
}
