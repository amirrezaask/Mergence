import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, FileCode2 } from "lucide-react";
import type {
  CheckoutTarget,
  ProjectSearchResult,
  ProjectTarget,
  SearchToolOptions,
  ToolUse,
} from "@yaade/rpc";
import {
  languageIdFromPath,
  pathToFileUri,
  type ProjectSearchOptions,
  type YaadeTheme,
} from "@yaade/shared";
import { MonacoEditorHost } from "@yaade/monaco";
import { setPendingEditorNavigation } from "@yaade/monaco/pending";
import {
  PierreWorkspaceFileTree,
  ProjectSearchPanel,
  QuickOpenOverlay,
} from "@yaade/ui";
import { Button } from "@yaade/ui/primitives";
import { ensureMonacoWorkersConfigured } from "../../editor/monaco-workers.js";

export type SearchToolViewProps = {
  readonly use: ToolUse;
  readonly theme: YaadeTheme;
  readonly fontSize: number;
  readonly results: readonly ProjectSearchResult[];
  readonly toolbar: React.ReactNode;
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
};

type OpenResult = {
  readonly uri: string;
  readonly path: string;
  readonly line: number;
  readonly column: number;
};

function absoluteResultPath(root: string, resultPath: string): string {
  if (resultPath.startsWith("/")) return resultPath;
  return `${root.replace(/\/+$/, "")}/${resultPath.replace(/^\/+/, "")}`;
}

function relativePathFromRoot(root: string, path: string): string {
  const normalizedRoot = root.replace(/\/+$/, "");
  return path.startsWith(`${normalizedRoot}/`)
    ? path.slice(normalizedRoot.length + 1)
    : path.replace(/^\/+/, "");
}

function editableOptions(options: SearchToolOptions): ProjectSearchOptions {
  return {
    ...(options.include ? { include: [...options.include] } : {}),
    ...(options.exclude ? { exclude: [...options.exclude] } : {}),
    ...(options.caseSensitive != null
      ? { caseSensitive: options.caseSensitive }
      : {}),
    ...(options.regex != null ? { regex: options.regex } : {}),
    ...(options.fuzzy != null ? { fuzzy: options.fuzzy } : {}),
    ...(options.wholeWord != null ? { wholeWord: options.wholeWord } : {}),
    ...(options.limit != null ? { limit: options.limit } : {}),
    ...(options.cursor != null ? { cursor: options.cursor } : {}),
  };
}

export function SearchToolView(props: SearchToolViewProps) {
  const input = props.use.input.kind === "search" ? props.use.input : null;
  const [query, setQuery] = useState(input?.query ?? "");
  const [options, setOptions] = useState<ProjectSearchOptions>(() =>
    input ? editableOptions(input.options) : {},
  );
  const [openResult, setOpenResult] = useState<OpenResult | null>(null);
  const [editorContent, setEditorContent] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [filePaths, setFilePaths] = useState<readonly string[]>([]);
  const [fileTreeLoading, setFileTreeLoading] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const searchTimer = useRef<number | undefined>(undefined);
  const checkoutPath = props.use.context.checkoutPath;
  const rootUri = pathToFileUri(checkoutPath);

  useEffect(() => {
    if (props.use.input.kind !== "search") return;
    setQuery(props.use.input.query);
    setOptions(editableOptions(props.use.input.options));
  }, [props.use.id, props.use.inputRevision]);

  const openFile = useCallback(
    (relativePath: string, line = 1, column = 1) => {
      const path = absoluteResultPath(checkoutPath, relativePath);
      setOpenResult({
        path,
        uri: pathToFileUri(path),
        line: Math.max(1, line),
        column: Math.max(1, column),
      });
    },
    [checkoutPath],
  );

  const quickOpenSearch = useCallback(
    async (nextQuery: string, _workspaceId: string | null, signal: AbortSignal) => {
      const search = window.yaade?.search;
      if (!search) return [];
      const currentFile = openResult
        ? relativePathFromRoot(checkoutPath, openResult.path)
        : undefined;
      const page = await search.fileSearch(rootUri, nextQuery, {
        pageSize: 100,
        ...(currentFile ? { currentFile } : {}),
      });
      return signal.aborted ? [] : page.items;
    },
    [checkoutPath, openResult, rootUri],
  );

  useEffect(() => {
    const showQuickOpen = () => setQuickOpen(true);
    window.addEventListener("yaade:quick-open", showQuickOpen);
    return () => window.removeEventListener("yaade:quick-open", showQuickOpen);
  }, []);

  useEffect(() => {
    if (!openResult || filePaths.length > 0) return;
    let cancelled = false;
    setFileTreeLoading(true);
    void window.yaade?.search
      ?.listFiles(rootUri)
      .then((page) => {
        if (!cancelled) setFilePaths(page.items);
      })
      .catch(() => {
        if (!cancelled) setFilePaths([]);
      })
      .finally(() => {
        if (!cancelled) setFileTreeLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filePaths.length, openResult, rootUri]);

  useEffect(() => {
    setFilePaths([]);
  }, [rootUri]);

  useEffect(() => {
    if (!openResult) return;
    let cancelled = false;
    setEditorContent(null);
    setEditorError(null);
    setPendingEditorNavigation(openResult.uri, {
      line: openResult.line,
      column: openResult.column,
    });
    void ensureMonacoWorkersConfigured();
    void window.yaade?.fs
      ?.readFile(openResult.uri)
      .then((content) => {
        if (!cancelled) setEditorContent(content);
      })
      .catch((error) => {
        if (!cancelled)
          setEditorError(
            error instanceof Error ? error.message : "Could not open file",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [openResult]);

  useEffect(
    () => () => {
      if (searchTimer.current != null) window.clearTimeout(searchTimer.current);
    },
    [],
  );

  const scheduleSearch = (
    nextQuery: string,
    nextOptions: ProjectSearchOptions,
  ) => {
    if (searchTimer.current != null) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      void props.onSearchChange(nextQuery, nextOptions);
    }, 150);
  };

  const quickOpenOverlay = (
    <QuickOpenOverlay
      open={quickOpen}
      onOpenChange={setQuickOpen}
      onSearch={quickOpenSearch}
      onSelect={(path, nextQuery) => {
        void window.yaade?.search?.trackFileAccess?.(rootUri, nextQuery, path);
        openFile(path);
      }}
    />
  );

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
    const selectedPath = relativePathFromRoot(checkoutPath, openResult.path);
    const breadcrumbSegments = selectedPath.split("/").filter(Boolean);
    return (
      <>
        <div
          className="flex min-h-0 flex-1 flex-col"
          data-yaade-search-editor={openResult.uri}
        >
          {props.toolbar}
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2">
            <Button size="sm" variant="ghost" onClick={() => setOpenResult(null)}>
              <ArrowLeft data-icon="inline-start" /> Search results
            </Button>
            <nav
              className="min-w-0 flex-1 overflow-hidden"
              aria-label="File path"
              data-yaade-editor-breadcrumbs=""
            >
              <ol className="flex min-w-0 items-center overflow-hidden font-mono text-xs">
                {breadcrumbSegments.map((segment, index) => {
                  const current = index === breadcrumbSegments.length - 1;
                  const path = breadcrumbSegments.slice(0, index + 1).join("/");
                  return (
                    <li key={path} className="flex min-w-0 items-center">
                      {index > 0 ? (
                        <ChevronRight
                          className="size-3.5 shrink-0 text-muted-foreground/60"
                          aria-hidden
                        />
                      ) : (
                        <FileCode2
                          className="mr-1.5 size-4 shrink-0 text-muted-foreground"
                          aria-hidden
                        />
                      )}
                      <span
                        className={
                          current
                            ? "truncate font-medium text-foreground"
                            : "truncate text-muted-foreground"
                        }
                        title={path}
                      >
                        {segment}
                        {current ? `:${openResult.line}` : ""}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </nav>
            <span className="hidden font-mono text-3xs text-muted-foreground sm:inline">
              ⌘P quick open
            </span>
          </div>
          <div className="flex min-h-0 flex-1">
            <div className="min-h-0 min-w-0 flex-1">
              {editorError ? (
                <div className="grid h-full place-items-center p-6 text-sm text-destructive">
                  {editorError}
                </div>
              ) : editorContent != null ? (
                <MonacoEditorHost
                  uri={openResult.uri}
                  content={editorContent}
                  languageId={languageIdFromPath(openResult.path)}
                  theme={props.theme}
                  fontSize={props.fontSize}
                  readOnly
                  autoFocus
                  viewStateId={`tool-search:${props.use.id}`}
                  onQuickOpen={() => setQuickOpen(true)}
                />
              ) : (
                <div className="grid h-full place-items-center text-sm text-muted-foreground">
                  Opening editor…
                </div>
              )}
            </div>
            <aside className="hidden w-72 shrink-0 border-l border-sidebar-border lg:block">
              <PierreWorkspaceFileTree
                paths={filePaths}
                selectedPath={selectedPath}
                loading={fileTreeLoading}
                onSelectPath={openFile}
              />
            </aside>
          </div>
        </div>
        {quickOpenOverlay}
      </>
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
      {quickOpenOverlay}
    </>
  );
}

export default SearchToolView;
