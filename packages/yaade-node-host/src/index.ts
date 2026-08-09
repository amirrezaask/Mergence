export {
  uriToPath,
  pathToUri,
  readFile,
  writeFile,
  readTextFile,
  writeTextFile,
  writeTempDrop,
  readDir,
  stat,
  exists,
  MAX_READ_BYTES,
  MAX_WRITE_BYTES,
  MAX_TEXT_FILE_BYTES,
} from "./fs.js"
export {
  createFile,
  createDirectory,
  renamePath,
  trashPath,
  restoreTrash,
  listTrash,
  emptyTrash,
  TRASH_RETENTION_MS,
  TRASH_MAX_BYTES,
  type FsMutationOptions,
  type FsMutationStat,
  type RestoreTrashResult,
  type EmptyTrashResult,
} from "./fs-mutations.js"
export {
  gitIsRepo,
  gitStatus,
  gitDiff,
  gitBranch,
  gitSummary,
  gitHistory,
  gitHistoryPage,
  gitStage,
  gitUnstage,
  gitCommit,
  gitCommitWithBody,
  gitBranches,
  gitCheckout,
  gitDiscard,
  gitFetch,
  gitPull,
  gitPush,
  gitShow,
  gitCommitFileContents,
  gitNumstat,
  gitCommitFiles,
  gitApplyPatch,
  gitWorktreeList,
  gitWorktreeAdd,
  gitWorktreeRemove,
  gitDefaultBranch,
  type GitShowRef,
  type GitSummary,
  type GitHistoryCommit,
} from "./git.js"
export { TerminalHost, type TerminalLaunch, type TerminalAttachSnapshot, type TerminalInspectSnapshot, TERMINAL_FLOW_ACK_CHARS, TERMINAL_FLOW_HIGH_WATERMARK_CHARS, TERMINAL_FLOW_LOW_WATERMARK_CHARS } from "./terminal.js"
export { makeTerminalHostScoped } from "./effect-terminal.js"
export { openInApp, revealInFolder } from "./shell.js"
export { spawnTask, type TaskSpawnRequest, type TaskSpawnResult } from "./tasks.js"
export { PerfHost } from "./perf.js"
export {
  projectSearch,
  listProjectFiles,
  fileSearch,
  trackFileAccess,
  ensureFffIndex,
  isFffScanReady,
  isGitWorkspace,
  isSearchScanReady,
  isSearchSupported,
  invalidateProjectFileCache,
  refreshProjectFileCache,
  disposeSearchRoot,
  DEFAULT_LIST_PROJECT_FILES,
} from "./search.js"
export { probeFffAvailable, isFffAvailable, disposeFffIndex } from "./fff-service.js"
export { assertAllowedPath, assertAllowedUri, normalizeRoots } from "./sandbox.js"
export { loadGlobalYaadercScanRoots } from "./global-yaaderc.js"
export {
  applyLoginShellEnv,
  enrichProcessPath,
  resolveLoginShellPath,
} from "./shell-env.js"
export {
  findWorkspaceRoot,
  resolveLaunchTarget,
  WORKSPACE_MARKERS,
  type LaunchConfig,
} from "./resolve-launch.js"
export {
  LspBridge,
  LspFramingDecoder,
  encodeLspMessage,
  type LspSession,
  type StartLspSessionOptions,
  type StartLspSessionResult,
  type LspBridgeOptions,
} from "./lsp-bridge.js"
export {
  getLanguageServerDefinition,
  resolveLanguageServerCommand,
  serverIdForLanguage,
  listLanguageServerDefinitions,
  findExecutableOnPath,
  resetLanguageServerRegistryForTests,
  type LanguageServerDefinition,
} from "./lsp-registry.js"
export {
  LspHost,
  makeLspHostScoped,
  type LspHostOptions,
} from "./lsp-host.js"
export {
  builtinLanguageServerDefinitions,
  loadLanguageServerConfig,
  parseLanguageServerConfig,
  redactConfiguredEnvironment,
  watchLanguageServerConfig,
  type LanguageServerCatalog,
  type LanguageServerConfigResult,
  type LanguageServerConfigWatcher,
} from "./lsp-config.js"
