import { lazy, Suspense, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import type { CheckoutTarget, ProjectTarget, ToolUse } from "@yaade/rpc";
import type { ProjectSearchOptions, YaadeTheme } from "@yaade/shared";
import { pathToFileUri } from "@yaade/shared";
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
  readonly focused?: boolean;
  readonly results?: unknown;
  readonly onSearchChange?: (
    query: string,
    options: ProjectSearchOptions,
  ) => Promise<void>;
  readonly onLoadMore?: () => Promise<void>;
  readonly onTitleChange?: (title: string) => void;
};

export function ProcessToolView({
  use,
  theme,
  toolbar,
  onTitleChange,
  visible = true,
  focused = visible,
}: ProcessToolViewProps) {
  if (use.output.kind !== "process") return null;
  const status =
    use.output.processState === "disconnected"
      ? "failed"
      : use.output.processState;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {toolbar}
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
          focused={focused}
          isActive={visible}
          existingPtyId={use.output.ptyId}
          sessionGeneration={use.output.generation}
          status={status}
          attachOnly
          visible={visible}
          onTitleChange={(_id, title) => onTitleChange?.(title)}
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
