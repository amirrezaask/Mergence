import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type {
  CheckoutTarget,
  ProjectSearchResult,
  ProjectTarget,
  SearchToolOptions,
  ToolUse,
} from "@yaade/rpc";
import { pathToFileUri, type ProjectSearchOptions, type YaadeTheme } from "@yaade/shared";
import { ProjectSearchPanel } from "@yaade/ui";
import { Button } from "@yaade/ui/primitives";
import { nvimEditCommand, nvimLaunchArgs, type SearchNvimTarget } from "./search-neovim.js";

const TerminalPanel = lazy(() =>
  import("@yaade/ui/terminal").then(module => ({ default: module.TerminalPanel })),
);

export type SearchToolViewProps = {
  readonly use: ToolUse;
  readonly theme: YaadeTheme;
  readonly fontSize: number;
  readonly results: readonly ProjectSearchResult[];
  readonly toolbar: ReactNode;
  readonly projects: readonly ProjectTarget[];
  readonly onContextChange: (
    project: ProjectTarget,
    checkout: CheckoutTarget,
  ) => Promise<void>;
  readonly onSearchChange: (
    query: string,
    options: ProjectSearchOptions,
  ) => Promise<void>;
  readonly onLoadMore: () => Promise<void>;
  readonly visible?: boolean;
  readonly focused?: boolean;
};

type OpenResult = SearchNvimTarget;

type SearchNvimSession = {
  readonly ptyId: string;
};

/** One long-lived Neovim PTY per search tool, even while the tool is hidden. */
const searchNvimSessions = new Map<string, SearchNvimSession>();

function searchNvimSessionKey(useId: string, checkoutPath: string): string {
  return `${useId}:${checkoutPath}`;
}

function absoluteResultPath(root: string, resultPath: string): string {
  if (resultPath.startsWith("/")) return resultPath;
  return `${root.replace(/\/+$/, "")}/${resultPath.replace(/^\/+/, "")}`;
}

function editableOptions(options: SearchToolOptions): ProjectSearchOptions {
  const next: ProjectSearchOptions = {};
  if (options.include) next.include = [...options.include];
  if (options.exclude) next.exclude = [...options.exclude];
  if (options.caseSensitive != null) next.caseSensitive = options.caseSensitive;
  if (options.regex != null) next.regex = options.regex;
  if (options.fuzzy != null) next.fuzzy = options.fuzzy;
  if (options.wholeWord != null) next.wholeWord = options.wholeWord;
  if (options.limit != null) next.limit = options.limit;
  if (options.cursor != null) next.cursor = options.cursor;
  return next;
}

export function SearchToolView(props: SearchToolViewProps) {
  const input = props.use.input.kind === "search" ? props.use.input : null;
  const [query, setQuery] = useState(input?.query ?? "");
  const [options, setOptions] = useState<ProjectSearchOptions>(() =>
    input ? editableOptions(input.options) : {},
  );
  const [openResult, setOpenResult] = useState<OpenResult | null>(null);
  const checkoutPath = props.use.context.checkoutPath;
  const nvimSessionKey = searchNvimSessionKey(props.use.id, checkoutPath);
  const [nvimPtyId, setNvimPtyId] = useState<string | null>(
    () => searchNvimSessions.get(nvimSessionKey)?.ptyId ?? null,
  );
  const searchTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (props.use.input.kind !== "search") return;
    setQuery(props.use.input.query);
    setOptions(editableOptions(props.use.input.options));
  }, [props.use.id, props.use.inputRevision]);

  useEffect(() => {
    setOpenResult(null);
    setNvimPtyId(searchNvimSessions.get(nvimSessionKey)?.ptyId ?? null);
  }, [nvimSessionKey]);

  const sendNvimTarget = useCallback(async (ptyId: string, target: OpenResult) => {
    const write = window.yaade?.terminal?.write;
    if (!write) return;
    await write(ptyId, nvimEditCommand(target));
  }, []);

  const openFile = useCallback(
    (relativePath: string, line = 1, column = 1) => {
      const path = absoluteResultPath(checkoutPath, relativePath);
      const target: OpenResult = {
        path,
        line: Math.max(1, line),
        column: Math.max(1, column),
      };
      setOpenResult(target);
      if (nvimPtyId) void sendNvimTarget(nvimPtyId, target);
    },
    [checkoutPath, nvimPtyId, sendNvimTarget],
  );

  const handleNvimPtyId = useCallback(
    (_tabId: string, ptyId: string | null) => {
      if (!ptyId) return;
      searchNvimSessions.set(nvimSessionKey, { ptyId });
      setNvimPtyId(ptyId);
    },
    [nvimSessionKey],
  );

  const handleNvimFailed = useCallback(() => {
    searchNvimSessions.delete(nvimSessionKey);
    setNvimPtyId(null);
  }, [nvimSessionKey]);

  useEffect(
    () => () => {
      if (searchTimer.current != null) window.clearTimeout(searchTimer.current)
    },
    [],
  )

  const scheduleSearch = (
    nextQuery: string,
    nextOptions: ProjectSearchOptions,
  ) => {
    if (searchTimer.current != null) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      void props.onSearchChange(nextQuery, nextOptions);
    }, 150);
  };

  const readFile = useMemo(
    () => async (relativePath: string) => {
      const path = absoluteResultPath(checkoutPath, relativePath);
      const read = window.yaade?.fs?.readFile;
      if (!read) throw new Error("File read is unavailable");
      return read(pathToFileUri(path));
    },
    [checkoutPath],
  );
  const panelResults = useMemo(
    () =>
      props.results.map((result) => ({
        ...result,
        ranges: result.ranges.map((range) => ({ ...range })),
      })),
    [props.results],
  );

  if (props.use.output.kind !== "search") return null;

  if (openResult) {
    return (
      <div
        className="flex min-h-0 flex-1 flex-col"
        data-yaade-search-neovim=""
        data-yaade-search-neovim-path={openResult.path}
      >
        {props.toolbar}
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
          <Button type="button" size="sm" variant="ghost" onClick={() => setOpenResult(null)}>
            <ChevronRight className="mr-1 size-3.5 rotate-180" aria-hidden />
            Search results
          </Button>
          <span className="min-w-0 truncate font-mono text-2xs text-muted-foreground" title={openResult.path}>
            {openResult.path}
          </span>
        </div>
        <div className="min-h-0 flex-1">
          <Suspense
            fallback={
              <div className="grid h-full place-items-center text-sm text-muted-foreground">
                Opening Neovim…
              </div>
            }
          >
            <TerminalPanel
              cwdRootUri={pathToFileUri(checkoutPath)}
              launchCommand="nvim"
              launchArgs={[...nvimLaunchArgs(openResult)]}
              theme={props.theme}
              tabId={`search-neovim:${props.use.id}`}
              focused={props.focused ?? true}
              isActive={props.visible !== false}
              existingPtyId={nvimPtyId ?? undefined}
              status="starting"
              sessionGeneration={1}
              visible={props.visible !== false}
              onPtyId={handleNvimPtyId}
              onFailed={handleNvimFailed}
            />
          </Suspense>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        {props.toolbar}
        <div className="min-h-0 flex-1">
          <ProjectSearchPanel
            query={query}
            options={options}
            results={panelResults}
            truncated={props.use.output.truncated}
            loading={props.use.output.running}
            error={props.use.error ?? null}
            projectPath={checkoutPath}
            readFile={readFile}
            onQueryChange={(next) => {
              setQuery(next);
              scheduleSearch(next, options);
            }}
            onOptionsChange={(next) => {
              setOptions(next);
              scheduleSearch(query, next);
            }}
            onSelectResult={(result) => {
              openFile(result.path, result.line, result.column);
            }}
            onLoadMore={props.onLoadMore}
          />
        </div>
      </div>
    </>
  );
}

export default SearchToolView;
