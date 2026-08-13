import { useEffect, useMemo, useState } from "react";
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

export type ToolContextControlsProps = {
  readonly use: ToolUse;
  readonly projects: readonly ProjectTarget[];
  readonly active?: boolean;
  readonly onChange: (
    project: ProjectTarget,
    checkout: CheckoutTarget,
  ) => Promise<void>;
  readonly onProviderChange?: (provider: AgentProvider) => Promise<void>;
};

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
  const [project, setProject] = useState(props.use.context.project);
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
  const currentWorktreeId =
    project.projectId === props.use.context.project.projectId &&
    props.use.context.checkoutKey !== "main"
      ? `worktree:${props.use.context.checkoutPath}`
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
    : project.projectId === props.use.context.project.projectId
      ? props.use.context.checkoutKey === "main"
        ? "main"
        : `worktree:${props.use.context.checkoutPath}`
      : "main";
  const agentProvider =
    props.use.input.kind === "agent" && isAgentProvider(props.use.input.provider)
      ? props.use.input.provider
      : null;
  const providerIds = useMemo(() => {
    const ids = providers.map((item) => item.provider);
    if (agentProvider && !ids.includes(agentProvider))
      return [agentProvider, ...ids];
    return ids;
  }, [agentProvider, providers]);

  useEffect(() => {
    setProject(props.use.context.project);
    setCreatingBranch(false);
    setBranch("");
  }, [props.use.context.project, props.use.id]);

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
  }, [project.projectId, props.use.context.checkoutPath]);

  useEffect(() => {
    if (props.use.kind !== "agent") return;
    let cancelled = false;
    void window.yaade?.agents
      ?.listProviders?.()
      .then((next) => {
        if (cancelled) return;
        setProviders(
          next.map((item) => ({
            provider: item.provider as AgentProvider,
            available: item.available,
            error: item.error,
          })),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [props.use.kind]);

  const change = async (
    nextProject: ProjectTarget,
    checkout: CheckoutTarget,
  ) => {
    setPending(true);
    try {
      await props.onChange(nextProject, checkout);
    } catch (error) {
      setProject(props.use.context.project);
      throw error;
    } finally {
      setPending(false);
    }
  };

  const submitBranch = () => {
    const next = branch.trim();
    if (!next) return;
    setCreatingBranch(false);
    void change(
      project,
      BranchWorktreeCheckout.make({
        kind: "branch-worktree",
        branch: next,
        createBranch: true,
      }),
    );
  };

  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2"
      data-yaade-tool-context
    >
      <Combobox
        items={projectIds}
        value={project.projectId}
        disabled={pending}
        onValueChange={(value) => {
          const next = props.projects.find((item) => item.projectId === value);
          if (!next) return;
          setProject(next);
          setCreatingBranch(false);
          setBranch("");
          void change(next, MainCheckout.make({ kind: "main" }));
        }}
        itemToStringValue={(value) => {
          const item = props.projects.find(
            (candidate) => candidate.projectId === value,
          );
          return item
            ? `${item.projectName} ${item.projectPath}`
            : String(value);
        }}
      >
        <ComboboxInput
          id={active ? "tool-project" : undefined}
          aria-label="Tool project"
          className="w-56"
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
            void change(project, MainCheckout.make({ kind: "main" }));
            return;
          }
          const path = String(value).slice("worktree:".length);
          const target = worktrees.find((item) => item.path === path);
          if (target) {
            void change(
              project,
              ExistingWorktreeCheckout.make({
                kind: "existing-worktree",
                path: target.path,
                ...(target.branch ? { branch: target.branch } : {}),
              }),
            );
            return;
          }
          if (path === props.use.context.checkoutPath) {
            void change(
              project,
              ExistingWorktreeCheckout.make({
                kind: "existing-worktree",
                path,
                ...(props.use.context.branch
                  ? { branch: props.use.context.branch }
                  : {}),
              }),
            );
          }
        }}
        itemToStringValue={(value) => {
          if (value === "main") return "Main";
          if (value === "new-branch") return "New isolated branch";
          const path = String(value).slice("worktree:".length);
          const target = worktrees.find((item) => item.path === path);
          if (target) return `${target.branch ?? "Worktree"} ${target.path}`;
          if (path === props.use.context.checkoutPath)
            return props.use.context.checkoutLabel;
          return path;
        }}
      >
        <ComboboxInput
          id={active ? "tool-checkout" : undefined}
          aria-label="Tool worktree"
          className="w-56"
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
                        {props.use.context.checkoutLabel}
                      </span>
                      <span className="block truncate font-mono text-2xs text-muted-foreground">
                        {props.use.context.checkoutPath}
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
        <Input
          id={active ? "tool-branch" : undefined}
          aria-label="Isolated branch worktree"
          className="w-48"
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
      ) : null}

      {props.use.kind === "agent" && agentProvider && props.onProviderChange ? (
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
            className="w-36"
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
    </div>
  );
}
