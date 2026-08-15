/**
 * Browser URL → project root under $HOME.
 *
 * `http://localhost:5174/dev/consultation` → `{home}/dev/consultation`
 * `/` → HQ, `/~` → home itself.
 * Project state is encoded in query parameters so every surface is deep-linkable.
 */

const RESERVED_PREFIXES = [
  "/api",
  "/ws",
  "/health",
  "/@",
  "/node_modules",
  "/src",
  "/assets",
];

/** True when pathname is a Vite/host asset or API route, not a project path. */
export function isReservedWorkspacePathname(pathname: string): boolean {
  if (pathname === "/" || pathname === "") return false;
  const lower = pathname.toLowerCase();
  for (const prefix of RESERVED_PREFIXES) {
    if (lower === prefix || lower.startsWith(`${prefix}/`)) return true;
  }
  // Vite hashed assets / source maps
  if (/\.[a-z0-9]{1,8}$/i.test(pathname) && !pathname.includes("/"))
    return true;
  return false;
}

/**
 * Join home + URL pathname segments. Leading slashes are stripped so the path
 * is always under `homeDir` (never absolute-from-root via pathname).
 */
export function resolveHomeRelativePath(
  homeDir: string,
  pathname: string,
): string {
  const home = homeDir.replace(/\/+$/, "") || "/";
  const rel = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!rel) return home;
  // Avoid path traversal escaping home.
  const parts = rel.split("/").filter((p) => p.length > 0 && p !== ".");
  const safe: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      if (safe.length > 0) safe.pop();
      continue;
    }
    safe.push(part);
  }
  if (safe.length === 0) return home;
  return `${home}/${safe.join("/")}`;
}

/** Short document title for a project root — just the directory name. */
export function workspaceDocumentTitle(
  absolutePath: string,
  _homeDir?: string,
): string {
  const base = absolutePath.split("/").filter(Boolean).pop();
  return base || absolutePath || "YAADE";
}

/** One crumb in the project-page path bar (GitHub-style). */
export type ProjectBreadcrumb = {
  label: string;
  absolutePath: string;
  /** Parent dir for sibling listing; `null` at filesystem root. */
  parentPath: string | null;
};

function parentDirectory(absolutePath: string): string | null {
  const trimmed = absolutePath.replace(/\/+$/, "") || "/";
  if (trimmed === "/") return null;
  const idx = trimmed.lastIndexOf("/");
  if (idx < 0) return null;
  if (idx === 0) return "/";
  return trimmed.slice(0, idx);
}

/** Join a parent directory with a child name (POSIX). */
export function joinProjectPath(parentPath: string, name: string): string {
  if (parentPath === "/") return `/${name}`;
  return `${parentPath.replace(/\/+$/, "")}/${name}`;
}

/**
 * Breadcrumb segments for the project path bar.
 * Under `$HOME` the first label is `~`; otherwise segments are absolute.
 */
export function projectBreadcrumbs(
  projectPath: string,
  homeDir: string,
): ProjectBreadcrumb[] {
  const home = homeDir.replace(/\/+$/, "");
  const abs = projectPath.replace(/\/+$/, "") || "/";

  if (home && (abs === home || abs.startsWith(`${home}/`))) {
    const crumbs: ProjectBreadcrumb[] = [
      {
        label: "~",
        absolutePath: home,
        parentPath: parentDirectory(home),
      },
    ];
    if (abs === home) return crumbs;
    let cur = home;
    for (const part of abs
      .slice(home.length + 1)
      .split("/")
      .filter(Boolean)) {
      const parent = cur;
      cur = joinProjectPath(cur, part);
      crumbs.push({ label: part, absolutePath: cur, parentPath: parent });
    }
    return crumbs;
  }

  const parts = abs.split("/").filter(Boolean);
  const crumbs: ProjectBreadcrumb[] = [];
  let cur = "";
  for (const part of parts) {
    const parent = cur === "" ? "/" : cur;
    cur = joinProjectPath(parent, part);
    crumbs.push({ label: part, absolutePath: cur, parentPath: parent });
  }
  return crumbs.length > 0
    ? crumbs
    : [{ label: "/", absolutePath: "/", parentPath: null }];
}

/** Navigate to a project path (drops `?s=`). Caller must react to the URL change. */
export function pushProjectUrl(pathname: string): void {
  if (typeof history === "undefined") return;
  const next = pathname || "/";
  if (`${location.pathname}${location.search}` === next) return;
  history.pushState({ sessionId: null }, "", next);
}

/**
 * Map the current location to an absolute project root.
 * Returns `null` when the pathname is reserved (asset/API) — caller should not navigate.
 */
export function projectRootFromLocation(
  homeDir: string,
  pathname: string = typeof location !== "undefined" ? location.pathname : "/",
): string | null {
  if (isReservedWorkspacePathname(pathname)) return null;
  if (pathname === "/" || pathname === "") return null;
  if (pathname === "/~" || pathname === "/~/") {
    return homeDir.replace(/\/+$/, "") || "/";
  }
  if (knownProjectIdFromPathname(pathname)) return null;
  return resolveHomeRelativePath(homeDir, pathname);
}

export function isHqPathname(pathname: string): boolean {
  return pathname === "/" || pathname === "";
}

export function knownProjectIdFromPathname(pathname: string): string | null {
  const match = /^\/_project\/([^/]+)\/?$/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function urlPathForKnownProject(projectId: string): string {
  return `/_project/${encodeURIComponent(projectId)}`;
}

/** Home-relative URL path for an absolute filesystem path (for `window.open`). */
export function urlPathForProjectRoot(
  absolutePath: string,
  homeDir: string,
): string {
  const home = homeDir.replace(/\/+$/, "");
  const abs = absolutePath.replace(/\/+$/, "") || "/";
  if (!home) return "/";
  if (abs === home) return "/~";
  if (abs.startsWith(`${home}/`)) {
    return `/${abs.slice(home.length + 1)}`;
  }
  // Outside home — still open `/` (caller may use a different affordance).
  return "/";
}

/** Read `?s=` session id from a search string (`?s=ses-…` or `s=ses-…`). */
export function sessionIdFromSearch(
  search: string = typeof location !== "undefined" ? location.search : "",
): string | null {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(raw);
  const id = params.get("s")?.trim() ?? "";
  return id.length > 0 ? id : null;
}

export const PROJECT_VIEWS = [
  "changes",
  "running",
  "editors",
  "history",
  "search",
] as const;

export type ProjectView = (typeof PROJECT_VIEWS)[number];

export type ProjectRoute = {
  view: ProjectView;
  workspaceId: string | null;
  checkoutKey: string | null;
  processId: string | null;
  searchId: string | null;
  filePath: string | null;
  line: number | null;
  column: number | null;
  /** Whether the editor location should open as a clean preview tab. */
  preview: boolean | null;
  searchQuery: string | null;
};

function positiveIntParam(params: URLSearchParams, key: string): number | null {
  const value = Number(params.get(key));
  return Number.isInteger(value) && value > 0 ? value : null;
}

function nonEmptyParam(params: URLSearchParams, key: string): string | null {
  const value = params.get(key)?.trim() ?? "";
  return value.length > 0 ? value : null;
}

function booleanParam(params: URLSearchParams, key: string): boolean | null {
  const value = params.get(key);
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return null;
}

function normalizeProjectView(
  requestedView: string | null,
  workspaceId: string | null,
): ProjectView {
  if (requestedView === "agents" || requestedView === "terminals")
    return "running";
  if (PROJECT_VIEWS.includes(requestedView as ProjectView)) {
    return requestedView as ProjectView;
  }
  return workspaceId ? "running" : "history";
}

/** Parse the complete project route. Legacy `?s=` links open Running. */
export function projectRouteFromSearch(
  search: string = typeof location !== "undefined" ? location.search : "",
): ProjectRoute {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  const workspaceId = nonEmptyParam(params, "s");
  const requestedView = nonEmptyParam(params, "view");
  const processId =
    nonEmptyParam(params, "process") ??
    nonEmptyParam(params, "agent") ??
    nonEmptyParam(params, "terminal");
  return {
    view: normalizeProjectView(requestedView, workspaceId),
    workspaceId,
    checkoutKey: nonEmptyParam(params, "checkout"),
    processId,
    searchId: nonEmptyParam(params, "search"),
    filePath: nonEmptyParam(params, "file"),
    line: positiveIntParam(params, "line"),
    column: positiveIntParam(params, "column"),
    preview: booleanParam(params, "preview"),
    searchQuery: nonEmptyParam(params, "q"),
  };
}

/** Build a canonical project URL without discarding unrelated route state. */
export function projectRouteUrl(
  pathname: string,
  route: Partial<ProjectRoute> & { view: ProjectView },
): string {
  const params = new URLSearchParams();
  if (route.view !== "history") params.set("view", route.view);
  if (route.workspaceId) params.set("s", route.workspaceId);
  if (route.checkoutKey && route.checkoutKey !== "main") {
    params.set("checkout", route.checkoutKey);
  }
  if (route.processId && route.view === "running") {
    params.set("process", route.processId);
  }
  if (route.searchId && (route.view === "search" || route.view === "editors")) {
    params.set("search", route.searchId);
  }
  if (
    route.searchQuery &&
    (route.view === "search" || route.view === "editors")
  ) {
    params.set("q", route.searchQuery);
  }
  if (route.filePath && route.view === "editors")
    params.set("file", route.filePath);
  if (route.line && route.view === "editors")
    params.set("line", String(route.line));
  if (route.column && route.view === "editors")
    params.set("column", String(route.column));
  if (route.preview != null && route.view === "editors") {
    params.set("preview", route.preview ? "1" : "0");
  }
  const query = params.toString();
  return `${pathname || "/"}${query ? `?${query}` : ""}`;
}

/** Fired after push/replace so SPA listeners can re-read `location` (pushState has no popstate). */
export const PROJECT_ROUTE_EVENT = "yaade:project-route";

function notifyProjectRouteChange(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(PROJECT_ROUTE_EVENT));
}

/** SPA navigation for a project surface, checkout, workspace, or agent run. */
export function pushProjectRoute(
  pathname: string,
  route: Partial<ProjectRoute> & { view: ProjectView },
): void {
  if (typeof history === "undefined") return;
  const next = projectRouteUrl(pathname, route);
  if (`${location.pathname}${location.search}` === next) return;
  history.pushState({ projectRoute: route }, "", next);
  notifyProjectRouteChange();
}

/** Update selection within the current project surface without adding a history entry. */
export function replaceProjectRoute(
  pathname: string,
  route: Partial<ProjectRoute> & { view: ProjectView },
): void {
  if (typeof history === "undefined") return;
  const next = projectRouteUrl(pathname, route);
  if (`${location.pathname}${location.search}` === next) return;
  history.replaceState({ projectRoute: route }, "", next);
  notifyProjectRouteChange();
}

/** Build `pathname?s=<sessionId>` (or bare pathname when sessionId is null). */
export function sessionSearchUrl(
  pathname: string,
  sessionId: string | null,
): string {
  const path = pathname || "/";
  if (!sessionId) return path;
  const params = new URLSearchParams();
  params.set("s", sessionId);
  return `${path}?${params.toString()}`;
}

/** Navigate into a session without remounting the SPA (keeps PTYs alive). */
export function pushSessionUrl(pathname: string, sessionId: string): void {
  const next = sessionSearchUrl(pathname, sessionId);
  if (typeof history === "undefined") return;
  if (`${location.pathname}${location.search}` === next) return;
  history.pushState({ sessionId }, "", next);
}

/** Return to the project page (drop `?s=`). */
export function popToProjectUrl(pathname?: string): void {
  if (typeof history === "undefined") return;
  const path = pathname ?? location.pathname;
  const next = sessionSearchUrl(path, null);
  if (`${location.pathname}${location.search}` === next) return;
  history.pushState({ sessionId: null }, "", next);
}

/** Replace the current URL's session id without adding a history entry. */
export function replaceSessionUrl(
  pathname: string,
  sessionId: string | null,
): void {
  if (typeof history === "undefined") return;
  const next = sessionSearchUrl(pathname, sessionId);
  if (`${location.pathname}${location.search}` === next) return;
  history.replaceState({ sessionId }, "", next);
}
