import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  PerfHost,
  SupervisedTerminalHost,
  type TerminalHost,
} from "@yaade/node-host";
import {
  isCliProvider,
  type NotificationStreamEvent,
} from "@yaade/shared";
import type { AgentProvider } from "@yaade/agent-telemetry";
import type { HostConfig } from "./config.js";
import type { EventHub } from "./events.js";
import type { RuntimeSnapshot, ServerIdentity } from "@yaade/rpc";
import {
  NotificationService,
  parseOscStreamChunk,
} from "./notifications/index.js";
import {
  AgentTelemetryService,
  AgentRunService,
  listQueuedHooks,
  markQueuedHookRetry,
  consumeHookQueueDiscardCount,
  removeQueuedHook,
  type AgentSnapshotStreamEvent,
} from "./agents/index.js";
import type { ProjectDatabase } from "./persistence.js";
import { TerminalInstanceService } from "./terminal-instances.js";
import { TerminalLeaseService } from "./terminal-leases.js";
import { DeviceAuthService } from "./device-auth.js";
import { ToolSessionStore } from "./tool-session-store.js";
import { discoverTerminalAgents } from "./terminal-agent-discovery.js";
import {
  ToolService,
  type ToolServiceDependencies,
} from "./tools/service.js";
import {
  resumeTerminalInstance,
  type ProcessDriverDependencies,
} from "./tools/process-driver.js";

export type RuntimeTerminal = TerminalHost | SupervisedTerminalHost;

export type HostRuntime = {
  config: HostConfig;
  identity: ServerIdentity;
  events: EventHub;
  db: ProjectDatabase;
  terminal: RuntimeTerminal;
  perf: PerfHost;
  homeDir: string;
  /** `os.hostname()` — workspace session identity with root path. */
  machineHostname: string;
  notifications: NotificationService;
  agents: AgentTelemetryService;
  agentRuns: AgentRunService;
  terminalInstances: TerminalInstanceService;
  leases: TerminalLeaseService;
  devices: DeviceAuthService;
  toolSessions: ToolSessionStore;
  /** Focused terminal/process port consumed by ToolService and dispatch. */
  terminalExecution: ProcessDriverDependencies;
  toolService: ToolService;
  hookQueueTimer: ReturnType<typeof setInterval>;
  reconcileTimer: ReturnType<typeof setInterval>;
  /** Request an event-driven foreground-process reconciliation for one PTY. */
  requestTerminalAgentScan: (ptyId?: string, armOutputProbe?: boolean) => void;
  stopTerminalAgentScan: () => void;
  pendingHookQueueDrain: () => Promise<void> | null;
};

function hasShellPromptMarker(data: string): boolean {
  return (
    data.includes("\x1b]7;") ||
    data.includes("\x1b]133;A") ||
    data.includes("\x1b]133;D")
  );
}

function asAgentProvider(
  value: string | null | undefined,
): AgentProvider | null {
  return isCliProvider(value) ? value : null;
}

export function createRuntime(
  config: HostConfig,
  events: EventHub,
  db: ProjectDatabase,
  terminal: RuntimeTerminal,
  options?: {
    /** When set, notification stream events go here (e.g. PubSub → EventHub bridge). */
    emitNotification?: (event: NotificationStreamEvent) => void;
    /** Identity is supplied by the daemon boot sequence. */
    identity?: ServerIdentity;
  },
): HostRuntime {
  const identity = options?.identity ?? {
    serverId: db.serverId(),
    serverEpoch: randomUUID(),
    protocolVersion: 2 as const,
    runtimeVersion: "0.0.1",
    startedAt: new Date().toISOString(),
  };
  const terminalOscBuffers = new Map<string, string>();
  const emitNotification =
    options?.emitNotification ??
    ((streamEvent: NotificationStreamEvent) => {
      events.emit("notifications:event", [streamEvent]);
    });
  const notifications = new NotificationService(db.session(), emitNotification);

  const emitAgent = (streamEvent: AgentSnapshotStreamEvent) => {
    events.emit("agents:event", [streamEvent]);
  };
  let agentRuns: AgentRunService | null = null;
  let terminalInstances: TerminalInstanceService | null = null;
  const agents = new AgentTelemetryService(
    db.session(),
    notifications,
    emitAgent,
    (event) => {
      const instance = terminalInstances?.onTelemetry(event);
      if (instance) {
        return (
          instance.processState === "starting" ||
          instance.processState === "running"
        );
      }
      const run = agentRuns?.onTelemetry(event);
      return (
        !run ||
        run.processState === "starting" ||
        run.processState === "running"
      );
    },
  );
  const runService = new AgentRunService(db.session(), (streamEvent) => {
    events.emit("agents:event", [streamEvent]);
  });
  agentRuns = runService;
  const processInstances = new TerminalInstanceService(
    db.session(),
    (streamEvent) => {
      events.emit("terminal-instances:event", [streamEvent]);
    },
  );
  terminalInstances = processInstances;
  const leases = new TerminalLeaseService();
  const devices = new DeviceAuthService(db.session());
  // Construct after terminal persistence so migration 15 can correlate existing PTYs.
  const toolSessions = new ToolSessionStore(db.session(), os.hostname());
  const homeDir = process.env.HOME ?? config.allowedRoots[0] ?? "";
  const terminalExecution: ProcessDriverDependencies = {
    config,
    db,
    terminal,
    terminalInstances: processInstances,
    agentRuns: runService,
    notifications,
    agents,
  };
  const toolServiceDependencies: ToolServiceDependencies = {
    config,
    db,
    homeDir,
    events,
    toolSessions,
    terminalInstances: processInstances,
    process: terminalExecution,
  };
  const toolService = new ToolService(toolServiceDependencies);

  // Foreground process changes have no portable child-process event in node-pty.
  // Reconcile on PTY command/output boundaries instead of polling all terminals.
  let terminalAgentScanInFlight: Promise<void> | null = null;
  let terminalAgentScanQueued = false;
  let terminalAgentScanStopped = false;
  let scanAllTerminals = false;
  const pendingTerminalAgentPtys = new Set<string>();
  // Prevent a noisy non-agent command from turning every PTY frame into a ps
  // walk. A command boundary clears the gate for one post-submit probe.
  const outputProbeArmed = new Set<string>();

  const runTerminalAgentScan = () => {
    if (terminalAgentScanStopped || terminalAgentScanInFlight) return;
    const ptyIds = scanAllTerminals
      ? undefined
      : [...pendingTerminalAgentPtys];
    scanAllTerminals = false;
    pendingTerminalAgentPtys.clear();
    if (ptyIds && ptyIds.length === 0) return;
    terminalAgentScanInFlight = discoverTerminalAgents(runtime, ptyIds)
      .catch(error => console.warn("Failed to discover terminal agents", error))
      .finally(() => {
        terminalAgentScanInFlight = null;
        if (
          !terminalAgentScanStopped &&
          (scanAllTerminals || pendingTerminalAgentPtys.size > 0)
        ) {
          queueMicrotask(runTerminalAgentScan);
        }
      });
  };

  const requestTerminalAgentScan = (
    ptyId?: string,
    armOutputProbe = false,
  ) => {
    if (terminalAgentScanStopped) return;
    if (ptyId) {
      if (armOutputProbe) outputProbeArmed.delete(ptyId);
      pendingTerminalAgentPtys.add(ptyId);
    } else {
      scanAllTerminals = true;
    }
    if (terminalAgentScanInFlight || terminalAgentScanQueued) return;
    terminalAgentScanQueued = true;
    queueMicrotask(() => {
      terminalAgentScanQueued = false;
      runTerminalAgentScan();
    });
  };

  const stopTerminalAgentScan = () => {
    terminalAgentScanStopped = true;
    scanAllTerminals = false;
    pendingTerminalAgentPtys.clear();
    outputProbeArmed.clear();
  };

  terminal.setEmit((channel, args) => {
    events.emit(channel, args);
    if (channel === "terminal:data") {
      const ptyId = String(args[0] ?? "");
      const data = String(args[1] ?? "");
      handleTerminalOsc(notifications, agents, terminalOscBuffers, ptyId, data);
      const instance = processInstances.byPtyId(ptyId);
      const shellPrompt = hasShellPromptMarker(data);
      const shellCommandStart = data.includes("\x1b]133;C");
      // OSC 7/133 prompt markers are cheap, precise signals for an agent
      // returning to the shell. OSC 133 command-start markers also reopen the
      // one output probe used to catch a CLI that starts just after the input
      // reconciliation.
      if (shellPrompt) {
        outputProbeArmed.add(ptyId);
        requestTerminalAgentScan(ptyId);
        if (instance?.provider) {
          let attempts = 0;
          const timer = setInterval(() => {
            attempts += 1;
            requestTerminalAgentScan(ptyId, true);
            if (attempts >= 8) clearInterval(timer);
          }, 400);
          timer.unref?.();
        }
      } else if (shellCommandStart && !instance?.provider) {
        outputProbeArmed.delete(ptyId);
        requestTerminalAgentScan(ptyId);
      } else if (!instance?.provider && !outputProbeArmed.has(ptyId)) {
        outputProbeArmed.add(ptyId);
        requestTerminalAgentScan(ptyId);
      }
    } else if (channel === "terminal:exit") {
      const ptyId = String(args[0] ?? "");
      terminalOscBuffers.delete(ptyId);
      outputProbeArmed.delete(ptyId);
      const exitCode =
        typeof args[1] === "number" ? args[1] : Number(args[1] ?? 0);
      void Promise.resolve(terminal.readOutput(ptyId)).then((replay) => {
        processInstances.onPtyExit(
          ptyId,
          exitCode,
          replay?.output ?? "",
          replay?.truncated ?? false,
        );
        runService.storeTranscript(
          ptyId,
          replay?.output ?? "",
          replay?.truncated ?? false,
        );
        handleTerminalExit(
          notifications,
          agents,
          processInstances,
          agentRuns,
          ptyId,
          exitCode,
        );
        toolService.onProcessExit(ptyId);
      });
    }
  });

  let hookQueueDrain: Promise<void> | null = null;
  const requestHookQueueDrain = () => {
    if (hookQueueDrain) return;
    hookQueueDrain = drainHookQueue(agents, notifications, config.dataDir)
      .catch((error) => console.warn("Failed to drain agent hook queue", error))
      .finally(() => {
        hookQueueDrain = null;
      });
  };
  const hookQueueTimer = setInterval(requestHookQueueDrain, 5_000);
  hookQueueTimer.unref?.();
  const reconcileTimer = setInterval(() => {
    toolService.reconcile();
  }, 15_000);
  reconcileTimer.unref?.();
  const runtime: HostRuntime = {
    config,
    identity,
    events,
    db,
    terminal,
    perf: new PerfHost(homeDir, Date.now()),
    homeDir,
    machineHostname: os.hostname(),
    notifications,
    agents,
    agentRuns: runService,
    terminalInstances: processInstances,
    leases,
    devices,
    toolSessions,
    terminalExecution,
    toolService,
    hookQueueTimer,
    reconcileTimer,
    requestTerminalAgentScan,
    stopTerminalAgentScan,
    pendingHookQueueDrain: () => hookQueueDrain,
  };
  try {
    db.addProject(config.launchConfig.workspacePath);
  } catch {
    /* Launch target validation remains authoritative; HQ can still load. */
  }
  requestHookQueueDrain();
  requestTerminalAgentScan();
  if (terminal instanceof SupervisedTerminalHost) {
    terminal.onState(state => {
      events.emit("connection:status", [state]);
      if (state === "lost") {
        processInstances.markSupervisorInterrupted("supervisor_epoch_changed");
        runtime.toolService.reconcile();
      } else if (state === "reconnecting" || state === "degraded") {
        processInstances.markSupervisorDisconnected("supervisor_unavailable");
        runtime.toolService.reconcile();
      } else if (state === "healthy") {
        void Promise.resolve(terminal.listRunning()).then(live => {
          processInstances.markSupervisorRecovered(new Set(live.map(item => item.id)));
          runtime.toolService.reconcile();
        });
      }
    });
  }

  return runtime;
}

/**
 * Build the control-plane snapshot used after every modern realtime handshake.
 * PTY bytes are intentionally absent; terminals have their own attach/replay
 * sequence and are reattached only after this snapshot is applied.
 */
export function buildRuntimeSnapshot(runtime: HostRuntime): RuntimeSnapshot {
  const projects = runtime.db.projects().map(project => ({
    projectId: project.id,
    projectPath: project.rootPath,
    projectName: project.name,
  }));
  const sessions = runtime.toolSessions.listSessions(false).map(session => ({
    session,
    tabs: runtime.toolSessions.listTabs(session.id),
    toolUses: runtime.toolSessions.listToolUses(session.id),
  }));
  const generatedAt = new Date().toISOString();
  return {
    type: "runtime:snapshot",
    schemaVersion: 1,
    identity: runtime.identity,
    cursor: {
      serverEpoch: runtime.identity.serverEpoch,
      sequence: runtime.events.lastSequence,
    },
    generatedAt,
    projects,
    sessions,
    terminalInstances: runtime.terminalInstances.listAll(),
    agents: runtime.terminalInstances.listAll().filter(instance => instance.provider),
    notifications: runtime.notifications.counts(),
    leases: runtime.leases.listAll(),
  };
}

export async function prepareLiveTerminals(runtime: HostRuntime): Promise<void> {
  let liveIds = new Set<string>();
  try {
    const live = await Promise.resolve(runtime.terminal.listRunning());
    liveIds = new Set(live.map((item) => item.id));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("SUPERVISOR_PROTOCOL_INCOMPATIBLE")) return;
    throw error;
  }
  runtime.terminalInstances.reconcileHostStart(liveIds);
  runtime.toolService.reconcile();

  const recoverable = runtime.terminalInstances
    .listAll()
    .filter(
      instance =>
        instance.processState === "interrupted" &&
        instance.restartPolicy === "resume-on-daemon-start" &&
        instance.provider &&
        instance.nativeSessionRef,
    );
  await Promise.all(
    recoverable.map(async instance => {
      try {
        await resumeTerminalInstance(
          runtime.terminalExecution,
          instance,
          "daemon-restore",
        );
      } catch (error) {
        const current = runtime.terminalInstances.get(instance.id);
        const reason = error instanceof Error ? error.message : String(error);
        runtime.terminalInstances.markRestoreFailed(
          instance.id,
          current?.generation ?? instance.generation,
          reason,
        );
        if (current?.processState === "starting") {
          runtime.terminalInstances.fail(
            instance.id,
            current.generation,
            reason,
          );
        }
      }
    }),
  );
}

async function drainHookQueue(
  agents: AgentTelemetryService,
  notifications: NotificationService,
  dataDir: string,
): Promise<void> {
  for (const item of await listQueuedHooks(dataDir)) {
    const provider = asAgentProvider(item.meta.provider);
    if (!provider || !item.meta.sessionId) {
      await removeQueuedHook(item.file);
      continue;
    }
    try {
      agents.ingestNative(item.payload, {
        provider,
        sessionId: item.meta.sessionId,
      });
      await removeQueuedHook(item.file);
    } catch (error) {
      await markQueuedHookRetry(item.file, error);
    }
  }
  const discarded = consumeHookQueueDiscardCount();
  if (discarded > 0) {
    notifications.ingest({
      source: "system",
      type: "failed",
      severity: "warning",
      title: "Discarded invalid agent hook events",
      message: `${discarded} corrupt, expired, or over-limit queued event${discarded === 1 ? " was" : "s were"} removed.`,
      eventId: `hook-queue-discard:${new Date().toISOString().slice(0, 10)}`,
    });
  }
}

function handleTerminalOsc(
  notifications: NotificationService,
  agents: AgentTelemetryService,
  buffers: Map<string, string>,
  ptyId: string,
  data: string,
): void {
  const buffered = buffers.get(ptyId) ?? "";
  // Hot path: almost all PTY frames are screen paint with no OSC. Skip the
  // stream parser entirely when nothing is buffered and this chunk cannot start
  // an OSC sequence.
  if (buffered.length === 0 && !data.includes("\x1b]")) return;
  const result = parseOscStreamChunk(buffered, data);
  if (result.buffered) buffers.set(ptyId, result.buffered);
  else buffers.delete(ptyId);
  const parsed = result.notifications;
  if (parsed.length === 0) return;
  const binding = notifications.bindingForPty(ptyId);
  for (const item of parsed) {
    const provider = asAgentProvider(
      binding?.provider ?? item.provider ?? null,
    );
    if (provider && binding?.sessionId) {
      agents.ingestNative(
        {
          type: item.type,
          title: item.title,
          message: item.message,
          providerEvent: item.type,
          providerSessionId: item.providerSessionId,
        },
        {
          provider,
          sessionId: binding.sessionId,
          processId: ptyId,
          projectId: binding.projectId ?? undefined,
          projectName: binding.projectName ?? undefined,
          sessionTitle: binding.sessionTitle ?? undefined,
        },
      );
      continue;
    }
    notifications.ingest({
      ...item,
      sessionId: binding?.sessionId ?? null,
      projectId: binding?.projectId ?? null,
      projectName: binding?.projectName ?? null,
      sessionTitle: binding?.sessionTitle ?? null,
      provider: binding?.provider ?? item.provider ?? null,
    });
  }
}

function handleTerminalExit(
  notifications: NotificationService,
  agents: AgentTelemetryService,
  terminalInstances: TerminalInstanceService | null,
  agentRuns: AgentRunService | null,
  ptyId: string,
  exitCode: number,
): void {
  const durableInstance = terminalInstances?.byPtyId(ptyId);
  if (durableInstance?.provider) {
    agents.onProcessExited({
      provider: durableInstance.provider,
      sessionId: durableInstance.id,
      processId: ptyId,
      exitCode,
      expectedExit: exitCode === 0,
      projectId: durableInstance.projectId,
    });
    return;
  }
  const durableRun = agentRuns?.onPtyExit(ptyId, exitCode, exitCode === 0);
  if (durableRun) {
    agents.onProcessExited({
      provider: durableRun.provider,
      sessionId: durableRun.runId,
      processId: ptyId,
      exitCode,
      expectedExit: exitCode === 0,
      projectId: durableRun.projectId,
    });
    return;
  }
  const binding = notifications.bindingForPty(ptyId);
  const provider = asAgentProvider(binding?.provider ?? null);
  if (provider && binding?.sessionId) {
    agents.onProcessExited({
      provider,
      sessionId: binding.sessionId,
      processId: ptyId,
      exitCode,
      expectedExit: exitCode === 0,
      projectId: binding.projectId ?? undefined,
    });
    return;
  }
  if (exitCode === 0) return;
  const providerLabel = binding?.provider
    ? binding.provider.charAt(0).toUpperCase() + binding.provider.slice(1)
    : "Process";
  notifications.ingest({
    source: "process",
    type: exitCode > 0 ? "failed" : "process-exited",
    title: `${providerLabel} exited with code ${exitCode}`,
    message: binding?.sessionTitle
      ? `Session “${binding.sessionTitle}” ended unexpectedly.`
      : "Session process ended unexpectedly.",
    sessionId: binding?.sessionId ?? null,
    projectId: binding?.projectId ?? null,
    projectName: binding?.projectName ?? null,
    sessionTitle: binding?.sessionTitle ?? null,
    provider: binding?.provider ?? null,
    eventId: `exit:${ptyId}:${exitCode}`,
    metadata: { exitCode, ptyId },
  });
}

export async function shutdownRuntime(
  runtime: HostRuntime,
  options?: { killPtys?: boolean },
): Promise<void> {
  runtime.events.emit("server:shuttingDown", []);
  clearInterval(runtime.hookQueueTimer);
  clearInterval(runtime.reconcileTimer);
  runtime.stopTerminalAgentScan();
  runtime.terminalInstances.dispose();
  await runtime.pendingHookQueueDrain();
  await runtime.toolService?.close();
  const killPtys = options?.killPtys ?? runtime.config.killPtysOnShutdown;
  if (runtime.terminal instanceof SupervisedTerminalHost) {
    if (killPtys) await runtime.terminal.shutdownSupervisor();
    else await runtime.terminal.disconnect();
  } else {
    runtime.terminal.stopAll();
  }
}
