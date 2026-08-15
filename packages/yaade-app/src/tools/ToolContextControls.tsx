import { useEffect, useMemo, useState } from "react";
import { FolderKanban, GitBranch, LoaderCircle, Sparkles } from "lucide-react";
import type { CheckoutTarget, ProjectTarget, ToolUse } from "@yaade/rpc";
import {
  BranchWorktreeCheckout,
  ExistingWorktreeCheckout,
  MainCheckout,
} from "@yaade/rpc";
import type { ToolCheckoutTarget } from "@yaade/workspace";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  Button,
  Input,
} from "@yaade/ui/primitives";

export type AgentProvider =
  | "claude"
  | "codex"
  | "cursor"
  | "opencode"
  | "grok"
  | "pi";

export type ProviderOption = {
  readonly provider: AgentProvider;
  readonly available: boolean;
  readonly error: string | null;
};

export type ToolContextSelection = {
  readonly project: ProjectTarget;
  readonly checkout: CheckoutTarget;
};

type ToolContextControlsBaseProps = {
  readonly projects: readonly ProjectTarget[];
  readonly active?: boolean;
  readonly presentation?: "pane" | "popover";
  readonly onChange: (
    project: ProjectTarget,
    checkout: CheckoutTarget,
  ) => Promise<void>;
  readonly onProviderChange?: (provider: AgentProvider) => Promise<void>;
};

export type ToolContextControlsProps =
  | (ToolContextControlsBaseProps & {
      readonly use: ToolUse;
      readonly initialContext?: never;
    })
  | (ToolContextControlsBaseProps & {
      readonly use?: undefined;
      readonly initialContext: ToolContextSelection;
    });

function contextSelectionForUse(use: ToolUse): ToolContextSelection {
  return {
    project: use.context.project,
    checkout:
      use.context.checkoutKey === "main"
        ? MainCheckout.make({ kind: "main" })
        : ExistingWorktreeCheckout.make({
            kind: "existing-worktree",
            path: use.context.checkoutPath,
            ...(use.context.branch ? { branch: use.context.branch } : {}),
          }),
  };
}

function isAgentProvider(value: string): value is AgentProvider {
  return (
    value === "claude" ||
    value === "codex" ||
    value === "cursor" ||
    value === "opencode" ||
    value === "grok" ||
    value === "pi"
  );
}

export function ToolContextControls(props: ToolContextControlsProps) {
  const active = props.active !== false;
  const initialContext = useMemo(
    () => (props.use ? contextSelectionForUse(props.use) : props.initialContext),
    [
      props.initialContext,
      props.use?.context.branch,
      props.use?.context.checkoutKey,
      props.use?.context.checkoutPath,
      props.use?.context.project.projectId,
      props.use?.context.project.projectName,
      props.use?.context.project.projectPath,
      props.use?.id,
    ],
  );
  const [project, setProject] = useState(initialContext.project);
  const [checkout, setCheckout] = useState<CheckoutTarget>(
    initialContext.checkout,
  );
  const [targets, setTargets] = useState<readonly ToolCheckoutTarget[]>([]);
  const [providers, setProviders] = useState<readonly ProviderOption[]>([]);
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [branch, setBranch] = useState("");
  const [pending, setPending] = useState(false);
  const worktrees = useMemo(
    () => targets.filter((item) => item.kind === "worktree"),
    [targets],
  );
  const projectIds = useMemo(
    () => props.projects.map((item) => item.projectId),
    [props.projects],
  );
  const selectedWorktreePath =
    checkout._tag === ExistingWorktreeCheckout._tag ? checkout.path : null;
  const currentWorktreeId = selectedWorktreePath
    ? `worktree:${selectedWorktreePath}`
    : null;
  const checkoutIds = useMemo(() => {
    const ids = [
      "main",
      ...worktrees.map((item) => `worktree:${item.path}`),
      "new-branch",
    ];
    if (currentWorktreeId && !ids.includes(currentWorktreeId)) {
      ids.splice(ids.length - 1, 0, currentWorktreeId);
    }
    return ids;
  }, [currentWorktreeId, worktrees]);
  const checkoutValue = creatingBranch
    ? "new-branch"
    : checkout._tag === MainCheckout._tag
      ? "main"
      : checkout._tag === ExistingWorktreeCheckout._tag
        ? `worktree:${checkout.path}`
        : "new-branch";
  const agentProvider =
    props.use?.input.kind === "agent" &&
    isAgentProvider(props.use.input.provider)
      ? props.use.input.provider
      : null;
  const providerIds = useMemo(() => {
    const ids = providers.map((item) => item.provider);
    if (agentProvider && !ids.includes(agentProvider))
      return [agentProvider, ...ids];
    return ids;
  }, [agentProvider, providers]);

  useEffect(() => {
    setProject(initialContext.project);
    setCheckout(initialContext.checkout);
    setCreatingBranch(false);
    setBranch("");
  }, [initialContext]);

  useEffect(() => {
    let cancelled = false;
    setTargets([]);
    void window.yaade?.tools
      ?.listCheckoutTargets(project.projectId)
      .then((next) => {
        if (!cancelled) setTargets(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [project.projectId, selectedWorktreePath]);

  useEffect(() => {
    if (props.use?.kind !== "agent") return;
    let cancelled = false;
    void window.yaade?.agents
      ?.listProviders?.()
      .then((next) => {
        if (cancelled) return;
        setProviders(
          next.flatMap((item) =>
            isAgentProvider(item.provider)
              ? [
                  {
                    provider: item.provider,
                    available: item.available,
                    error: item.error,
                  },
                ]
              : [],
          ),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [props.use?.kind]);

  const change = async (
    nextProject: ProjectTarget,
    nextCheckout: CheckoutTarget,
  ) => {
    setPending(true);
    try {
      await props.onChange(nextProject, nextCheckout);
    } catch (error) {
      setProject(initialContext.project);
      setCheckout(initialContext.checkout);
      throw error;
    } finally {
      setPending(false);
    }
  };

  const submitBranch = () => {
    const next = branch.trim();
    if (!next) return;
    const nextCheckout = BranchWorktreeCheckout.make({
      kind: "branch-worktree",
      branch: next,
      createBranch: true,
    });
    setCreatingBranch(false);
    setCheckout(nextCheckout);
    void change(project, nextCheckout);
  };

  return (
    <div
      className={
        props.presentation === "popover"
          ? "flex flex-col gap-3 p-3"
          : "flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2"
      }
      data-yaade-tool-context
    >
      <Combobox
        items={projectIds}
        value={project.projectId}
        disabled={pending}
        onValueChange={(value) => {
          const next = props.projects.find((item) => item.projectId === value);
          if (!next) return;
          const nextCheckout = MainCheckout.make({ kind: "main" });
          setProject(next);
          setCheckout(nextCheckout);
          setCreatingBranch(false);
          setBranch("");
          void change(next, nextCheckout);
        }}
        itemToStringLabel={(value) => {
          const item = props.projects.find(
            (candidate) => candidate.projectId === value,
          );
          return item ? item.projectName : String(value);
        }}
      >
        <ComboboxInput
          id={active ? "tool-project" : undefined}
          aria-label="Tool project"
          className={
            props.presentation === "popover" ? "w-full" : "w-44 lg:w-56"
          }
          startAddon={<FolderKanban />}
          size="sm"
        />
        <ComboboxPopup className="w-(--anchor-width)">
          <ComboboxEmpty>No known projects.</ComboboxEmpty>
          <ComboboxList>
            {(id: string) => {
              const item = props.projects.find(
                (candidate) => candidate.projectId === id,
              );
              return item ? (
                <ComboboxItem key={id} value={id}>
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {item.projectName}
                    </span>
                    <span className="block truncate font-mono text-2xs text-muted-foreground">
                      {item.projectPath}
                    </span>
                  </span>
                </ComboboxItem>
              ) : null;
            }}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>

      <Combobox
        items={checkoutIds}
        value={checkoutValue}
        disabled={pending}
        onValueChange={(value) => {
          if (value === "new-branch") {
            setCreatingBranch(true);
            return;
          }
          setCreatingBranch(false);
          setBranch("");
          if (value === "main") {
            const nextCheckout = MainCheckout.make({ kind: "main" });
            setCheckout(nextCheckout);
            void change(project, nextCheckout);
            return;
          }
          const path = String(value).slice("worktree:".length);
          const target = worktrees.find((item) => item.path === path);
          if (target) {
            const nextCheckout = ExistingWorktreeCheckout.make({
              kind: "existing-worktree",
              path: target.path,
              ...(target.branch ? { branch: target.branch } : {}),
            });
            setCheckout(nextCheckout);
            void change(project, nextCheckout);
            return;
          }
          if (path === selectedWorktreePath) {
            const nextCheckout = ExistingWorktreeCheckout.make({
              kind: "existing-worktree",
              path,
              ...(checkout._tag === ExistingWorktreeCheckout._tag &&
              checkout.branch
                ? { branch: checkout.branch }
                : {}),
            });
            setCheckout(nextCheckout);
            void change(project, nextCheckout);
          }
        }}
        itemToStringLabel={(value) => {
          if (value === "main") return "Main";
          if (value === "new-branch") return "New isolated branch";
          const path = String(value).slice("worktree:".length);
          const target = worktrees.find((item) => item.path === path);
          if (target) return `${target.branch ?? "Worktree"} ${target.path}`;
          if (path === selectedWorktreePath) {
            if (checkout._tag === ExistingWorktreeCheckout._tag) {
              return checkout.branch ?? "Worktree";
            }
            return props.use?.context.checkoutLabel ?? "Worktree";
          }
          return path;
        }}
      >
        <ComboboxInput
          id={active ? "tool-checkout" : undefined}
          aria-label="Tool worktree"
          className={
            props.presentation === "popover" ? "w-full" : "w-44 lg:w-56"
          }
          startAddon={<GitBranch />}
          size="sm"
        />
        <ComboboxPopup className="w-(--anchor-width)">
          <ComboboxEmpty>No worktrees found.</ComboboxEmpty>
          <ComboboxList>
            {(id: string) => {
              if (id === "main")
                return (
                  <ComboboxItem key={id} value={id}>
                    Main
                  </ComboboxItem>
                );
              if (id === "new-branch")
                return (
                  <ComboboxItem key={id} value={id}>
                    New isolated branch…
                  </ComboboxItem>
                );
              const target = worktrees.find(
                (item) => `worktree:${item.path}` === id,
              );
              if (target) {
                return (
                  <ComboboxItem key={id} value={id}>
                    <span className="min-w-0">
                      <span className="block truncate">
                        {target.branch ?? "Worktree"}
                      </span>
                      <span className="block truncate font-mono text-2xs text-muted-foreground">
                        {target.path}
                      </span>
                    </span>
                  </ComboboxItem>
                );
              }
              if (id === currentWorktreeId) {
                return (
                  <ComboboxItem key={id} value={id}>
                    <span className="min-w-0">
                      <span className="block truncate">
                        {checkout._tag === ExistingWorktreeCheckout._tag
                          ? checkout.branch ?? "Worktree"
                          : props.use?.context.checkoutLabel ?? "Worktree"}
                      </span>
                      <span className="block truncate font-mono text-2xs text-muted-foreground">
                        {selectedWorktreePath}
                      </span>
                    </span>
                  </ComboboxItem>
                );
              }
              return null;
            }}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>

      {creatingBranch ? (
        <div className="flex items-center gap-1.5">
          <Input
            id={active ? "tool-branch" : undefined}
            aria-label="Isolated branch worktree"
            className="w-40"
            autoFocus
            autoComplete="off"
            placeholder="feature/my-branch"
            value={branch}
            disabled={pending}
            onChange={(event) => setBranch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submitBranch();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setCreatingBranch(false);
                setBranch("");
              }
            }}
          />
          <Button
            size="sm"
            disabled={pending || !branch.trim()}
            onClick={submitBranch}
          >
            Create
          </Button>
        </div>
      ) : null}

      {props.use?.kind === "agent" && agentProvider && props.onProviderChange ? (
        <Combobox
          items={providerIds}
          value={agentProvider}
          disabled={pending}
          onValueChange={(value) => {
            const next = String(value);
            if (!isAgentProvider(next)) return;
            const option = providers.find((item) => item.provider === next);
            if (option && !option.available) return;
            setPending(true);
            void props
              .onProviderChange?.(next)
              .finally(() => setPending(false));
          }}
          itemToStringValue={(value) => String(value)}
        >
          <ComboboxInput
            id={active ? "tool-provider" : undefined}
            aria-label="Agent provider"
            className={props.presentation === "popover" ? "w-full" : "w-36"}
            startAddon={<Sparkles />}
            size="sm"
          />
          <ComboboxPopup className="w-(--anchor-width)">
            <ComboboxEmpty>No providers.</ComboboxEmpty>
            <ComboboxList>
              {(id: string) => {
                const option = providers.find((item) => item.provider === id);
                return (
                  <ComboboxItem
                    key={id}
                    value={id}
                    disabled={option ? !option.available : false}
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{id}</span>
                      {option && !option.available ? (
                        <span className="block truncate font-mono text-2xs text-muted-foreground">
                          unavailable
                        </span>
                      ) : null}
                    </span>
                  </ComboboxItem>
                );
              }}
            </ComboboxList>
          </ComboboxPopup>
        </Combobox>
      ) : null}
      {pending ? (
        <LoaderCircle
          className="ml-auto size-3.5 animate-spin text-primary"
          aria-label="Restarting tool"
        />
      ) : null}
    </div>
  );
}
