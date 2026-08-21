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
} from "./fs.js";
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
} from "./fs-mutations.js";
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
} from "./git.js";
export {
  TerminalHost,
  type TerminalLaunch,
  type TerminalAttachSnapshot,
  type TerminalInspectSnapshot,
  type TerminalCreateResult,
  type TerminalHostOptions,
  TERMINAL_FLOW_ACK_CHARS,
  TERMINAL_FLOW_HIGH_WATERMARK_CHARS,
  TERMINAL_FLOW_LOW_WATERMARK_CHARS,
} from "./terminal.js";
export { makeTerminalHostScoped } from "./effect-terminal.js";
export { PtyWriteQueue, PtyWriteQueueOverflow } from "./pty-write-queue.js"
export { TerminalSemanticRuntime } from "./terminal-semantic-runtime.js"
export {
  BasicTerminalStateRecorder,
  type TerminalCheckpoint,
  type TerminalStateRecorder,
} from "./terminal-state/recorder.js";
export { SupervisedTerminalHost } from "./terminal-supervisor-client.js"
export { SupervisorPeerWriter } from "./supervisor-peer-writer.js"
export {
  TerminalControlError,
  TerminalControlRegistry,
  type TerminalLease as RuntimeTerminalLease,
  type TerminalLeaseRequest,
  type TerminalMutationFence,
} from "./terminal-control.js"
export {
  encodeSupervisorProtocolMessage,
  decodeSupervisorProtocolMessage,
  assertSupervisorDeadline,
  assertPendingRequestCapacity,
  SupervisorProtocolFrameReader,
} from "./terminal-protocol/codec.js"
export {
  SupervisorProtocolError,
  type SupervisorProtocolErrorCode,
} from "./terminal-protocol/errors.js"
export * from "./terminal-protocol/limits.js"
export * from "./terminal-protocol/schema.js"
export {
  legacyEventToV2,
  legacyRequestToCommand,
  legacyResponseToV2,
} from "./terminal-protocol/legacy-v1-adapter.js"
export {
  TerminalRuntimeRegistry,
  parseRuntimeManifest,
  runtimeManifestPath,
  runtimeOwnerDirectory,
  runtimeRegistryDirectory,
  runtimeRegistryPath,
  runtimeSocketPath,
  runtimeProcessIsAlive,
  runtimeSupports,
  type TerminalRuntimeManifest,
} from "./terminal-runtime-registry.js"
export {
  TerminalRuntimeRouter,
  type RoutedTerminalRef,
  type RuntimeConnection,
  type RunningTerminalRef,
} from "./terminal-runtime-router.js"
export {
  MultiGenerationTerminalHost,
  type MultiGenerationRuntimeOptions,
} from "./terminal-runtime-client.js"
export {
  TerminalRecoveryStore,
  type RecoveryReadResult,
  type RecoveryWriteResult,
  type TerminalHistoryPersistence,
  type TerminalRecoveryMetadata,
  type TerminalRecoveryRecord,
} from "./terminal-recovery-store.js";
export {
  ensureTerminalSupervisor,
  ensureTerminalSupervisorGeneration,
  listenTerminalSupervisor,
  supervisorLockPath,
  supervisorManifestPath,
  supervisorSocketPath,
  supervisorPidPath,
  type SupervisorGenerationOptions,
  type SupervisorManifest,
} from "./terminal-supervisor.js";
export {
  captureProcessIdentity,
  isProcessAlive,
  matchesProcessIdentity,
  signalVerifiedProcess,
  signalVerifiedProcessGroup,
  type ProcessIdentity,
} from "./process-identity.js";
export { PTY_SANITIZED_ENV_KEYS, sanitizePtyEnv } from "./terminal-env.js";
export { openInApp, revealInFolder } from "./shell.js";
export {
  spawnTask,
  type TaskSpawnRequest,
  type TaskSpawnResult,
} from "./tasks.js";
export { PerfHost } from "./perf.js";
export {
  assertAllowedPath,
  assertAllowedUri,
  normalizeRoots,
} from "./sandbox.js";
export { loadGlobalYaadercScanRoots } from "./global-yaaderc.js";
export {
  applyLoginShellEnv,
  enrichProcessPath,
  resolveLoginShellPath,
} from "./shell-env.js";
export {
  findWorkspaceRoot,
  resolveLaunchTarget,
  WORKSPACE_MARKERS,
  type LaunchConfig,
} from "./resolve-launch.js";
