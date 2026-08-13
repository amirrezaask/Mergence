import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, FileCode2 } from "lucide-react";
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
import { ProjectSearchPanel } from "@yaade/ui";
import { Button } from "@yaade/ui/primitives";
import { ensureMonacoWorkersConfigured } from "../../editor/monaco-workers.js";
import { ToolContextControls } from "../ToolContextControls.js";

export type SearchToolViewProps = {
  readonly use: ToolUse;
  readonly theme: YaadeTheme;
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
  const searchTimer = useRef<number | undefined>(undefined);
  const checkoutPath = props.use.context.checkoutPath;

  useEffect(() => {
    if (props.use.input.kind !== "search") return;
    setQuery(props.use.input.query);
    setOptions(editableOptions(props.use.input.options));
  }, [props.use.id, props.use.inputRevision]);

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
        data-yaade-search-editor={openResult.uri}
      >
        {props.toolbar}
        <ToolContextControls
          use={props.use}
          projects={props.projects}
          onChange={props.onContextChange}
        />
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <Button size="sm" variant="ghost" onClick={() => setOpenResult(null)}>
            <ArrowLeft data-icon="inline-start" /> Search results
          </Button>
          <FileCode2 className="size-4 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
            {openResult.path}:{openResult.line}
          </span>
        </div>
        <div className="min-h-0 flex-1">
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
              autoFocus
              viewStateId={`tool-search:${props.use.id}`}
            />
          ) : (
            <div className="grid h-full place-items-center text-sm text-muted-foreground">
              Opening editor…
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {props.toolbar}
      <ToolContextControls
        use={props.use}
        projects={props.projects}
        onChange={props.onContextChange}
      />
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
            const path = absoluteResultPath(checkoutPath, result.path);
            setOpenResult({
              path,
              uri: pathToFileUri(path),
              line: Math.max(1, result.line),
              column: Math.max(1, result.column),
            });
          }}
          onLoadMore={() => void props.onLoadMore()}
        />
      </div>
    </div>
  );
}

export default SearchToolView;
