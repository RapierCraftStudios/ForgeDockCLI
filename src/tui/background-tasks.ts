// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "@earendil-works/pi-coding-agent";
import { controllerEnvironment } from "../runtime/controller-environment.js";
import { BackgroundTaskObservationAdapter } from "../observability/adapters.js";
import type { ObservationEnvelopeV1, ObservationQuerySource, ObservationSink } from "../observability/contracts.js";

export type BackgroundTaskStatus = "running" | "detached" | "completed" | "blocked" | "failed" | "cancelled";

/**
 * A native controller can depend on an in-memory transport owned by the TUI.
 * Keep this marker deliberately non-secret: the bridge URL and bearer token
 * stay in the child environment and are never written to the task record.
 */
export const NESTED_AGENT_BRIDGE_RESTART_REQUIRED = "nested-agent-bridge" as const;
export type BackgroundTaskRestartRequirement = typeof NESTED_AGENT_BRIDGE_RESTART_REQUIRED;
export const TUI_RESTART_TERMINAL_CAUSE = "tui-restart" as const;
export type BackgroundTaskTerminalCause = typeof TUI_RESTART_TERMINAL_CAUSE;
export type BackgroundTaskResumeScope = "orchestration" | "work-on" | "review-pr-rerun" | "promote" | "workflow";

const ORCHESTRATION_RESUME_MESSAGE =
  "The owning orchestration checkpoint is preserved; resume it explicitly with forgedock_resume_orchestration.";
const WORK_ON_RESUME_MESSAGE =
  "The work-on checkpoint is preserved; invoke ForgeDock work-on again with resume=true for the same issue.";
const REVIEW_PR_RERUN_MESSAGE =
  "Review checkpoints are not resumable; rerun the ForgeDock review workflow after restart with /review-pr.";
const PROMOTE_RESUME_MESSAGE =
  "The promotion checkpoint is preserved; invoke ForgeDock promote again with its promotionId to resume.";
const LEGACY_WORKFLOW_RESUME_MESSAGE =
  "The owning workflow checkpoint is preserved; resume that ForgeDock workflow explicitly from its durable checkpoint.";

export interface BackgroundTaskRecord {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  pid: number;
  logPath: string;
  stderrLogPath?: string;
  status: BackgroundTaskStatus;
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  /** Why this record was terminalized operationally, when distinct from its process exit. */
  terminalCause?: BackgroundTaskTerminalCause;
  /** Non-secret operational binding; never store bridge URL/token here. */
  restartRequired?: BackgroundTaskRestartRequirement;
  /** Non-secret routing hint for the durable recovery handoff. */
  resumeScope?: BackgroundTaskResumeScope;
  /** Stable orchestration transport key; it is safe to persist and never contains credentials. */
  launchKey?: string;
  /** Non-secret identity of the TUI supervisor that owns a bridge-bound task. */
  ownerId?: string;
  /** PID of the owning TUI supervisor, not the controller child. */
  ownerPid?: number;
  /** Last durable heartbeat written by the owning TUI supervisor. */
  ownerHeartbeatAt?: string;
  /** Non-secret process-launch witness used to reject PID reuse during adoption. */
  ownerIncarnation?: string;
  /** Set when the owner intentionally releases the task during session teardown. */
  ownerReleasedAt?: string;
}

const MAX_BACKGROUND_TASKS = 4;
/**
 * The task supervisor heartbeat is operational evidence, not workflow truth.
 * A live owner renews it from the existing task ticker; a replacement TUI
 * requires both a live owner PID and a recent heartbeat before it leaves a
 * bridge-bound controller alone.
 */
const SUPERVISOR_HEARTBEAT_TTL_MS = 15_000;
const MIN_OBSERVATION_POLL_MS = 250;
const MAX_OBSERVATION_POLL_MS = 2_000;

interface LiveTask {
  record: BackgroundTaskRecord;
  child?: ChildProcess;
  stderrLogPath?: string;
  stdoutOffset: number;
  stderrOffset: number;
  adopted: boolean;
  cleanup?: () => Promise<void>;
  cleanupPromise?: Promise<void>;
}

export class ForgeDockBackgroundTasks {
  readonly #pi: ExtensionAPI;
  readonly #ownerId = crypto.randomUUID();
  readonly #ownerIncarnation = processIncarnationWitness(process.pid);
  readonly #live = new Map<string, LiveTask>();
  readonly #records = new Map<string, BackgroundTaskRecord>();
  readonly #directories = new Set<string>();
  #ticker: NodeJS.Timeout | undefined;
  #ctx: ExtensionContext | undefined;
  #observationAdapter: BackgroundTaskObservationAdapter | undefined;
  #observationQuery: ObservationQuerySource | undefined;
  readonly #finishing = new Set<string>();

  constructor(pi: ExtensionAPI) {
    this.#pi = pi;
  }

  setObservationSink(sink: (ObservationSink & Partial<ObservationQuerySource>) | undefined): void {
    this.#observationAdapter = sink ? new BackgroundTaskObservationAdapter(sink) : undefined;
    this.#observationQuery = sink && isObservationQuerySource(sink) ? sink : undefined;
    if (!this.#observationAdapter) return;
    for (const live of this.#live.values()) {
      if (live.adopted) this.#observationAdapter.adopted(live.record.id, live.record.pid);
    }
  }

  /**
   * Bind the supervisor to a checkout without adopting any persisted task.
   *
   * Session startup and read-only previews may need the task directory for
   * presentation, but initialize() is deliberately reserved for an
   * authorized controller dispatch: it can adopt a live process or
   * terminalize a bridge-bound task from a previous session.
   */
  bindContext(ctx: ExtensionContext): void {
    this.#ctx = ctx;
    this.#directories.add(join(ctx.cwd, ".forgedock", "tasks"));
  }

  /** Return records already terminalized specifically by TUI restart recovery. */
  pendingRestartRecords(ctx: ExtensionContext): BackgroundTaskRecord[] {
    this.bindContext(ctx);
    return [...this.recordsFromDisk().values()].filter(isRestartBlockedTask);
  }

  /** Present a pending restart warning without adopting or terminalizing it. */
  announceRestartRequired(record: BackgroundTaskRecord): void {
    this.notifyRestartRequired(record);
  }

  initialize(ctx: ExtensionContext): void {
    this.#ctx = ctx;
    const directory = join(ctx.cwd, ".forgedock", "tasks");
    this.#directories.add(directory);
    if (!existsSync(directory)) return;
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(directory, name), "utf8")) as unknown;
        if (!isBackgroundTaskRecord(parsed) || !recordBelongsToTaskFile(parsed, directory, name)) continue;
        const record = parsed;
        if (record.status === "running" || record.status === "detached") {
          if (record.restartRequired === NESTED_AGENT_BRIDGE_RESTART_REQUIRED) {
            // A second terminal can inspect the task directory while the
            // original TUI still owns this controller and its in-memory
            // nested-agent bridge. It must not present that healthy task as
            // interrupted or terminate it merely because the bridge cannot
            // be reattached by the second terminal.
            if (this.bridgeOwnerIsLive(record)) {
              this.#records.set(record.id, record);
              continue;
            }
            // The nested-agent bridge lives in the previous TUI process. It
            // cannot be reattached from a fresh terminal, so adopting this
            // controller would present a healthy PID with a dead reviewer
            // transport. Stop it and make the interruption an explicit,
            // resumable checkpoint instead.
            if (isProcessAlive(record.pid)) terminateProcessTree(record.pid);
            record.status = "blocked";
            record.completedAt ??= new Date().toISOString();
            record.exitCode ??= 2;
            record.terminalCause = TUI_RESTART_TERMINAL_CAUSE;
            this.persist(record);
            this.notifyRestartRequired(record);
            this.#records.set(record.id, record);
            continue;
          }
          record.status = "detached";
          if (isProcessAlive(record.pid)) {
            // A terminal restart must not turn a still-running controller into a
            // false failure. Adopt it as a detached task and supervise its PID
            // and durable log until it exits.
            this.#live.set(record.id, {
              record,
              ...(record.stderrLogPath ? { stderrLogPath: record.stderrLogPath } : {}),
              stdoutOffset: fileSize(record.logPath),
              stderrOffset: fileSize(record.stderrLogPath),
              adopted: true,
            });
          }
          // A restarted supervisor cannot recover an already-consumed process
          // exit code. Persist only the operational loss of attachment; the
          // controller/GitHub result must decide semantic completion or failure.
          this.persist(record);
        }
        this.#records.set(record.id, record);
      } catch {
        // Ignore damaged operational records; durable workflow truth remains on GitHub.
      }
    }
    if (this.#live.size) this.ensureTicker();
  }

  start(input: {
    command: string;
    args: string[];
    cwd: string;
    env?: Record<string, string>;
    cleanup?: () => Promise<void>;
    restartRequired?: BackgroundTaskRestartRequirement;
    resumeScope?: BackgroundTaskResumeScope;
    launchKey?: string;
    ctx: ExtensionContext;
  }): BackgroundTaskRecord {
    if (input.launchKey) {
      const existing = this.findByLaunchKey(input.launchKey);
      if (existing) return existing;
    }
    if (this.#live.size >= MAX_BACKGROUND_TASKS) {
      throw new Error(`ForgeDock background task limit (${MAX_BACKGROUND_TASKS}) reached; wait for or cancel an existing task`);
    }
    const id = `task_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const directory = join(input.cwd, ".forgedock", "tasks");
    this.#directories.add(directory);
    mkdirSync(directory, { recursive: true });
    const logPath = join(directory, `${id}.log`);
    const stderrLogPath = join(directory, `${id}.stderr.log`);
    const stdoutFd = openSync(logPath, "w");
    const stderrFd = openSync(stderrLogPath, "w");
    let registered = false;
    const onError = (error: Error) => {
      if (registered) void this.finish(id, "failed", undefined, error.message);
    };
    let child: ChildProcess;
    try {
      child = spawn(input.command, input.args, {
        cwd: input.cwd,
        env: controllerEnvironment(process.env, { ...input.env, FORGEDOCK_CONTROLLER_TASK_ID: id }),
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", stdoutFd, stderrFd],
      });
      child.once("error", onError);
    } catch (error) {
      closeSync(stdoutFd);
      closeSync(stderrFd);
      throw error;
    }
    closeSync(stdoutFd);
    closeSync(stderrFd);
    if (!child.pid) throw new Error("ForgeDock background controller failed to start");
    const record: BackgroundTaskRecord = {
      id,
      command: input.command,
      args: [...input.args],
      cwd: input.cwd,
      pid: child.pid,
      logPath,
      stderrLogPath,
      status: "running",
      startedAt: new Date().toISOString(),
      ...(input.restartRequired !== undefined ? { restartRequired: input.restartRequired } : {}),
      ...(input.resumeScope !== undefined ? { resumeScope: input.resumeScope } : {}),
      ...(input.launchKey !== undefined ? { launchKey: input.launchKey } : {}),
      ...(input.restartRequired === NESTED_AGENT_BRIDGE_RESTART_REQUIRED ? {
        ownerId: this.#ownerId,
        ownerPid: process.pid,
        ...(this.#ownerIncarnation !== undefined ? { ownerIncarnation: this.#ownerIncarnation } : {}),
        ownerHeartbeatAt: new Date().toISOString(),
      } : {}),
    };
    this.#ctx = input.ctx;
    const live: LiveTask = { record, child, stderrLogPath, stdoutOffset: 0, stderrOffset: 0, adopted: false, ...(input.cleanup ? { cleanup: input.cleanup } : {}) };
    this.#records.set(id, record);
    this.#live.set(id, live);
    registered = true;
    this.persist(record);
    this.#observationAdapter?.started(record);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const status: BackgroundTaskStatus = signal ? "cancelled" : code === 0 ? "completed" : code === 2 ? "blocked" : "failed";
      void this.finish(id, status, code ?? undefined);
    };
    child.once("exit", onExit);
    // Very short-lived controllers can exit between spawn() and listener
    // registration. Node retains their terminal fields, so reconcile once
    // after subscribing instead of relying on the event alone.
    if (child.exitCode !== null || child.signalCode !== null) {
      queueMicrotask(() => onExit(child.exitCode, child.signalCode));
    }
    child.unref();
    this.ensureTicker();
    this.renderStatus();
    return { ...record, args: [...record.args] };
  }

  list(): BackgroundTaskRecord[] {
    return [...this.recordsFromDisk().values()]
      .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
      .map((record) => ({ ...record, args: [...record.args] }));
  }

  /**
   * Reconcile a launch that may have completed before its orchestration
   * attempt could record the returned task id.  The key is the exact
   * orchestration/node/attempt identity, so a later retry cannot adopt it.
   */
  findByLaunchKey(launchKey: string): BackgroundTaskRecord | undefined {
    if (!launchKey.trim()) return undefined;
    this.recordsFromDisk();
    return [...this.#records.values()].find((record) => record.launchKey === launchKey);
  }

  /**
   * Operational liveness is supervisor-owned, not inferred from a stale
   * persisted `running`/`detached` label. Dead detached records remain audit
   * evidence but must not consume controller transport capacity.
   */
  isOperationallyActive(id: string): boolean {
    const live = this.#live.get(id);
    if (!live || ["completed", "blocked", "failed", "cancelled"].includes(live.record.status)) return false;
    return isProcessAlive(live.record.pid);
  }

  async waitForTerminal(id: string, options: { warnAfterMs?: number } = {}): Promise<BackgroundTaskRecord> {
    const warnAfterMs = options.warnAfterMs ?? 120_000;
    const waitStartedAt = new Date().toISOString();
    let observationCursor: string | undefined;
    let observationCursorInitialized = false;
    let lastProgressAt = Date.now();
    let emptyObservationPolls = 0;
    let warned = false;
    while (true) {
      const record = this.recordsFromDisk().get(id);
      if (!record) throw new Error(`Unknown ForgeDock background task: ${id}`);
      if (["completed", "blocked", "failed", "cancelled"].includes(record.status)) return { ...record, args: [...record.args] };
      if ((record.status === "running" || record.status === "detached") && !this.#live.has(id) && !isProcessAlive(record.pid)) {
        if (record.status === "running") {
          record.status = "detached";
          this.#records.set(record.id, record);
          this.persist(record);
        }
        throw new Error(`ForgeDock controller task ${id} exited while detached without a locally observable controller result; inspect durable workflow state and resume explicitly`);
      }

      if (this.#observationQuery) {
        let semanticActivity = false;
        try {
          const events = await this.#observationQuery.query({
            controllerTaskId: id,
            ...(observationCursorInitialized && observationCursor !== undefined ? { cursor: observationCursor } : {}),
            ...(!observationCursorInitialized ? { newestFirst: true, limit: 1 } : { limit: 500 }),
          });
          const chronological = observationCursorInitialized ? events : [...events].reverse();
          if (events.length) observationCursor = chronological.at(-1)?.eventId;
          semanticActivity = chronological.some((event) => isSemanticBackgroundActivity(event)
            && (observationCursorInitialized || event.ingestedAt >= waitStartedAt));
          observationCursorInitialized = true;
          if (semanticActivity) {
            lastProgressAt = Date.now();
            warned = false;
          }
        } catch {
          // Observation storage is rebuildable operational state. A transient or
          // permanent query failure must neither fail the workflow wait nor be
          // misreported as semantic progress.
        }
        emptyObservationPolls = semanticActivity
          ? 0
          : Math.min(32, emptyObservationPolls + 1);
      }

      const observationPollMs = Math.min(
        MAX_OBSERVATION_POLL_MS,
        MIN_OBSERVATION_POLL_MS * 2 ** Math.floor(emptyObservationPolls / 4),
      );
      if (!warned && Date.now() - lastProgressAt >= warnAfterMs) {
        warned = true;
        const message = `ForgeDock controller task ${id} has no semantic activity for ${Math.round(warnAfterMs / 1_000)}s; durable state remains authoritative and recovery is still explicit.`;
        const notify = this.#ctx?.ui.notify;
      if (typeof notify === "function") notify.call(this.#ctx!.ui, message, "warning");
        try { this.#pi.sendMessage({ customType: "forgedock-progress-warning", content: message, display: true }, { deliverAs: "nextTurn" }); } catch { /* session teardown */ }
      }
      const warningPollMs = warned
        ? observationPollMs
        : Math.max(1, warnAfterMs - (Date.now() - lastProgressAt));
      // Query often enough that activity arriving anywhere inside the warning
      // window is observed before an idle warning can be emitted. Normal
      // production windows still back off to the capped adaptive cadence.
      const semanticSafetyPollMs = Math.max(MIN_OBSERVATION_POLL_MS, Math.floor(warnAfterMs / 2));
      await new Promise((resolve) => setTimeout(
        resolve,
        Math.min(observationPollMs, warningPollMs, semanticSafetyPollMs),
      ));
    }
  }

  output(id: string): string {
    const record = this.recordsFromDisk().get(id);
    if (!record) {
      throw new Error(`Unknown ForgeDock background task: ${id}. Orchestration IDs are durable DAG records; use forgedock_tasks action=list for the DAG status or forgedock_resume_orchestration to resume one explicitly.`);
    }
    const stdout = existsSync(record.logPath) ? readFileSync(record.logPath, "utf8") : "";
    const stderr = record.stderrLogPath && existsSync(record.stderrLogPath) ? readFileSync(record.stderrLogPath, "utf8") : "";
    const output = [stdout, stderr].filter(Boolean).join("\n");
    const limited = truncateTail(output, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
    return `${renderRecord(record)}\n${limited.content || "(no output yet)"}${limited.truncated ? `\n[Output truncated; full log: ${record.logPath}]` : ""}`;
  }

  cancel(id: string): BackgroundTaskRecord {
    const latest = this.recordsFromDisk().get(id);
    const live = this.#live.get(id);
    if (!live) {
      if (!latest) throw new Error(`Unknown ForgeDock background task: ${id}`);
      if (latest.status === "running" || latest.status === "detached") {
        throw new Error(`Task ${id} belongs to another or interrupted ForgeDock session and is not supervised here`);
      }
      return latest;
    }
    if (["completed", "blocked", "failed", "cancelled"].includes(live.record.status)) {
      return { ...live.record, args: [...live.record.args] };
    }
    live.record.status = "cancelled";
    live.record.completedAt = new Date().toISOString();
    this.persist(live.record);
    terminateProcessTree(live.child ?? live.record.pid);
    this.renderStatus();
    return { ...live.record, args: [...live.record.args] };
  }

  async shutdown(options: { cancel?: boolean } = {}): Promise<void> {
    const live = [...this.#live.values()];
    if (options.cancel ?? true) {
      for (const task of live) this.cancel(task.record.id);
      await Promise.allSettled(live.map((task) => this.cleanupTask(task)));
    } else {
      const persisted = this.recordsFromDisk();
      const bridgeTasks: LiveTask[] = [];
      for (const task of live) {
        const latest = persisted.get(task.record.id);
        if (latest) task.record = latest;
        if (task.record.restartRequired === NESTED_AGENT_BRIDGE_RESTART_REQUIRED
          && task.record.ownerId === this.#ownerId) {
          // A bridge is an in-memory capability of this supervisor. Do not
          // detach its controller: release ownership, checkpoint it as a
          // restart interruption, and stop it before closing the bridge.
          task.record.ownerReleasedAt = new Date().toISOString();
          task.record.status = "blocked";
          task.record.completedAt ??= new Date().toISOString();
          task.record.exitCode ??= 2;
          task.record.terminalCause = TUI_RESTART_TERMINAL_CAUSE;
          this.persist(task.record);
          bridgeTasks.push(task);
        } else {
          if (task.record.status === "running") task.record.status = "detached";
          this.persist(task.record);
        }
      }
      // SIGINT gives the controller a chance to flush its durable checkpoint
      // and process-signal handlers before the bounded hard-stop fallback.
      for (const task of bridgeTasks) interruptProcessTree(task.child ?? task.record.pid);
      await Promise.all(bridgeTasks.map((task) => waitForProcessExit(task, 5_000)));
      await Promise.allSettled(bridgeTasks.map((task) => boundedCleanup(this.cleanupTask(task), 2_000)));
      for (const task of bridgeTasks) this.notifyRestartRequired(task.record);
    }
    this.#live.clear();
    this.stopTicker();
    this.#ctx?.ui.setStatus("forgedock-tasks", undefined);
  }

  private cleanupTask(task: LiveTask): Promise<void> {
    if (!task.cleanup) return Promise.resolve();
    task.cleanupPromise ??= Promise.resolve().then(() => task.cleanup!()).catch(() => undefined);
    return task.cleanupPromise;
  }

  private async finish(id: string, status: BackgroundTaskStatus, exitCode?: number, detail?: string): Promise<void> {
    const live = this.#live.get(id);
    const observationAdapter = this.#observationAdapter;
    if (!live || (observationAdapter && this.#finishing.has(id))) return;
    if (observationAdapter) this.#finishing.add(id);
    try {
      // A previous supervisor may still observe the process exit after the
      // replacement TUI has durably blocked a bridge-bound task. Preserve that
      // restart classification instead of letting the old supervisor turn it
      // back into an ordinary failed/cancelled result.
      const persisted = this.recordsFromDisk().get(id);
      const restartBlocked = persisted !== undefined && isRestartBlockedTask(persisted);
      if (persisted) live.record = persisted;
      if (!restartBlocked && live.record.status !== "cancelled") live.record.status = status;
      live.record.completedAt ??= new Date().toISOString();
      if (exitCode !== undefined) live.record.exitCode = exitCode;
      this.captureLogDeltas(live);
      this.persist(live.record);
      if (observationAdapter) await observationAdapter.finished(id, live.record.status, exitCode);
      this.#live.delete(id);
      await this.cleanupTask(live);
      const terminalDetail = detail ?? (live.record.status === "completed"
        ? boundedTerminalWarnings(live.record.stderrLogPath)
        : boundedTerminalError(live.record.stderrLogPath));
      const message = [`${renderRecord(live.record)}${terminalDetail ? ` — ${terminalDetail}` : ""}`, `Log: ${live.record.logPath}`, ...(live.record.stderrLogPath ? [`Error log: ${live.record.stderrLogPath}`] : [])].join("\n");
      this.#ctx?.ui.notify(message, live.record.status === "completed" ? "info" : "warning");
      try {
        this.#pi.sendMessage({ customType: "forgedock-background-task", content: message, display: true }, { deliverAs: "nextTurn" });
      } catch {
        // Session teardown can race completion; the persisted record and GitHub artifacts remain available.
      }
      this.renderStatus();
      if (!this.#live.size) this.stopTicker();
    } finally {
      if (observationAdapter) this.#finishing.delete(id);
    }
  }

  private captureLogDeltas(live: LiveTask): void {
    for (const [channel, path, offset] of [["stdout", live.record.logPath, live.stdoutOffset] as const, ["stderr", live.stderrLogPath, live.stderrOffset] as const]) {
      let currentOffset = offset;
      while (true) {
        const delta = readLogDelta(path, currentOffset);
        if (!delta) break;
        currentOffset = delta.nextOffset;
        this.#observationAdapter?.output(live.record.id, channel, delta.text, currentOffset);
      }
      if (channel === "stdout") live.stdoutOffset = currentOffset;
      else live.stderrOffset = currentOffset;
    }
  }

  private recordsFromDisk(): Map<string, BackgroundTaskRecord> {
    for (const directory of this.#directories) {
      if (!existsSync(directory)) continue;
      for (const name of readdirSync(directory)) {
        if (!name.endsWith(".json")) continue;
        try {
          const record = JSON.parse(readFileSync(join(directory, name), "utf8")) as unknown;
          if (!isBackgroundTaskRecord(record) || !recordBelongsToTaskFile(record, directory, name)) continue;
          this.#records.set(record.id, record);
          const live = this.#live.get(record.id);
          if (live) live.record = record;
        } catch {
          // Atomic writers may leave unrelated or damaged operational files;
          // keep the last valid projection and retry on the next observation.
        }
      }
    }
    return new Map(this.#records);
  }

  private persist(record: BackgroundTaskRecord): void {
    const path = join(record.cwd, ".forgedock", "tasks", `${record.id}.json`);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  }

  private ensureTicker(): void {
    if (this.#ticker) return;
    this.#ticker = setInterval(() => {
      for (const task of this.#live.values()) this.captureLogDeltas(task);
      this.refreshBridgeOwnerHeartbeats();
      void this.reconcileAdoptedTasks();
      this.renderStatus();
    }, 1_000);
    this.#ticker.unref();
  }

  private stopTicker(): void {
    if (this.#ticker) clearInterval(this.#ticker);
    this.#ticker = undefined;
  }

  /** Renew ownership without overwriting a replacement supervisor's result. */
  private refreshBridgeOwnerHeartbeats(): void {
    const persisted = this.recordsFromDisk();
    const heartbeatAt = new Date().toISOString();
    for (const task of this.#live.values()) {
      if (task.adopted || task.record.restartRequired !== NESTED_AGENT_BRIDGE_RESTART_REQUIRED) continue;
      const latest = persisted.get(task.record.id);
      if (!latest || latest.ownerId !== this.#ownerId || latest.ownerPid !== process.pid || latest.ownerReleasedAt !== undefined) continue;
      if (["completed", "blocked", "failed", "cancelled"].includes(latest.status)) continue;
      task.record = { ...latest, ownerHeartbeatAt: heartbeatAt };
      this.#records.set(task.record.id, task.record);
      this.persist(task.record);
    }
  }

  private reconcileAdoptedTasks(): void {
    this.recordsFromDisk();
    for (const task of [...this.#live.values()]) {
      if (!task.adopted) continue;
      if (["completed", "blocked", "failed", "cancelled"].includes(task.record.status)) {
        void this.finish(task.record.id, task.record.status, task.record.exitCode, "Recovered durable controller task result");
        continue;
      }
      if (task.record.status !== "detached") continue;
      if (isProcessAlive(task.record.pid)) continue;
      this.captureLogDeltas(task);
      void this.#observationAdapter?.discarded(task.record.id);
      this.#live.delete(task.record.id);
      const message = `${renderRecord(task.record)} — detached controller exited without an observable exit result; durable workflow state remains authoritative\nLog: ${task.record.logPath}`;
      const notify = this.#ctx?.ui.notify;
      if (typeof notify === "function") notify.call(this.#ctx!.ui, message, "warning");
      try { this.#pi.sendMessage({ customType: "forgedock-background-task", content: message, display: true }, { deliverAs: "nextTurn" }); } catch { /* session teardown */ }
      this.renderStatus();
    }
    if (!this.#live.size) this.stopTicker();
  }

  private renderStatus(): void {
    if (!this.#ctx) return;
    const running = [...this.#live.values()];
    if (!running.length) {
      this.#ctx.ui.setStatus("forgedock-tasks", undefined);
      return;
    }
    const recent = running[0]?.record;
    const elapsed = recent ? Math.max(0, Math.round((Date.now() - Date.parse(recent.startedAt)) / 1_000)) : 0;
    this.#ctx.ui.setStatus("forgedock-tasks", `◆ ${running.length} background task${running.length === 1 ? "" : "s"} · ${recent?.id ?? ""} · ${elapsed}s`);
  }

  private notifyRestartRequired(record: BackgroundTaskRecord): void {
    if (record.terminalCause !== TUI_RESTART_TERMINAL_CAUSE) return;
    const resumeMessage = record.resumeScope === "orchestration"
      ? ORCHESTRATION_RESUME_MESSAGE
      : record.resumeScope === "work-on"
        ? WORK_ON_RESUME_MESSAGE
        : record.resumeScope === "review-pr-rerun"
          ? REVIEW_PR_RERUN_MESSAGE
          : record.resumeScope === "promote"
            ? PROMOTE_RESUME_MESSAGE
            : LEGACY_WORKFLOW_RESUME_MESSAGE;
    const message = `${renderRecord(record)} — interrupted during terminal restart because its ephemeral nested-agent bridge cannot be reattached. ${resumeMessage}`;
    const notify = this.#ctx?.ui.notify;
    if (typeof notify === "function") notify.call(this.#ctx!.ui, message, "warning");
    try {
      this.#pi.sendMessage({ customType: "forgedock-background-task", content: message, display: true }, { deliverAs: "nextTurn" });
    } catch {
      // Session startup/teardown can race notification delivery; the blocked
      // record and durable workflow checkpoint remain authoritative.
    }
  }

  private bridgeOwnerIsLive(record: BackgroundTaskRecord): boolean {
    return isBridgeOwnerLive(record, this.#ownerId);
  }
}

function isBackgroundTaskRecord(value: unknown): value is BackgroundTaskRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<BackgroundTaskRecord>;
  return typeof record.id === "string" && Boolean(record.id)
    && typeof record.command === "string"
    && Array.isArray(record.args) && record.args.every((arg) => typeof arg === "string")
    && typeof record.cwd === "string" && Boolean(record.cwd)
    && Number.isInteger(record.pid) && (record.pid ?? 0) > 0
    && typeof record.logPath === "string" && Boolean(record.logPath)
    && typeof record.startedAt === "string"
    && (record.terminalCause === undefined || record.terminalCause === TUI_RESTART_TERMINAL_CAUSE)
    && (record.restartRequired === undefined || record.restartRequired === NESTED_AGENT_BRIDGE_RESTART_REQUIRED)
    && (record.resumeScope === undefined || ["orchestration", "work-on", "review-pr-rerun", "promote", "workflow"].includes(record.resumeScope))
    && (record.launchKey === undefined || (typeof record.launchKey === "string" && record.launchKey.length > 0 && record.launchKey.length <= 512))
    && (record.ownerId === undefined || (typeof record.ownerId === "string" && record.ownerId.length > 0 && record.ownerId.length <= 128))
    && (record.ownerPid === undefined || (Number.isInteger(record.ownerPid) && (record.ownerPid ?? 0) > 0))
    && (record.ownerHeartbeatAt === undefined || typeof record.ownerHeartbeatAt === "string")
    && (record.ownerIncarnation === undefined || (typeof record.ownerIncarnation === "string" && record.ownerIncarnation.length > 0 && record.ownerIncarnation.length <= 256))
    && (record.ownerIncarnation === undefined || (typeof record.ownerIncarnation === "string" && record.ownerIncarnation.length > 0 && record.ownerIncarnation.length <= 256))
    && (record.ownerReleasedAt === undefined || typeof record.ownerReleasedAt === "string")
    && ["running", "detached", "completed", "blocked", "failed", "cancelled"].includes(record.status ?? "");
}

function recordBelongsToTaskFile(record: BackgroundTaskRecord, directory: string, name: string): boolean {
  if (!/^task_[A-Za-z0-9_-]{1,120}$/.test(record.id) || name !== `${record.id}.json`) return false;
  const expected = resolve(record.cwd, ".forgedock", "tasks");
  const actual = resolve(directory);
  if (!samePath(expected, actual)) return false;
  if (!samePath(record.logPath, join(actual, `${record.id}.log`))) return false;
  return record.stderrLogPath === undefined || samePath(record.stderrLogPath, join(actual, `${record.id}.stderr.log`));
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function fileSize(path: string | undefined): number {
  if (!path) return 0;
  try { return statSync(path).size; } catch { return 0; }
}

function isObservationQuerySource(value: ObservationSink): value is ObservationSink & ObservationQuerySource {
  return typeof (value as Partial<ObservationQuerySource>).query === "function";
}

function isSemanticBackgroundActivity(event: ObservationEnvelopeV1): boolean {
  if (event.source === "workflow" && event.channel === "activity") {
    return event.kind === "workflow.progress" || event.kind === "workflow.heartbeat";
  }
  if (event.source === "agent" && event.channel === "activity") {
    return event.kind === "activity.changed"
      || event.kind === "output.delta"
      || event.kind === "agent.session.progress";
  }
  if (event.source === "agent" && event.channel === "lifecycle") {
    return /(?:^|\.)session\.(?:started|completed|failed|cancelled)$/.test(event.kind);
  }
  if (event.source === "agent" && event.channel === "tool") {
    return event.kind === "tool.progress" || event.kind === "tool.completed";
  }
  if ((event.source === "agent" || event.source === "artifact") && event.channel === "artifact") {
    return event.kind === "artifact.created" || event.kind === "artifact.submitted";
  }
  return false;
}

function boundedTerminalWarnings(path: string | undefined): string | undefined {
  if (!path || !existsSync(path)) return undefined;
  const warnings = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("ForgeDock warning: "));
  if (!warnings.length) return undefined;
  return truncateTail(warnings.join("\n"), { maxBytes: 2_000, maxLines: 4 }).content.replace(/\s*\n\s*/g, " | ");
}

function boundedTerminalError(path: string | undefined): string | undefined { if (!path || !existsSync(path)) return undefined; const raw = readFileSync(path, "utf8").trim(); if (!raw) return undefined; return truncateTail(raw, { maxBytes: 2_000, maxLines: 8 }).content.replace(/\s*\n\s*/g, " | "); }

function readLogDelta(path: string | undefined, offset: number): { text: string; nextOffset: number } | undefined {
  if (!path) return undefined;
  let size: number;
  try { size = statSync(path).size; } catch { return undefined; }
  if (size <= offset) return undefined;
  const length = Math.min(size - offset, 64 * 1024);
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, offset);
    if (bytesRead <= 0) return undefined;
    return { text: buffer.subarray(0, bytesRead).toString("utf8"), nextOffset: offset + bytesRead };
  } finally {
    closeSync(fd);
  }
}

export function isRestartBlockedTask(record: BackgroundTaskRecord): boolean {
  return record.status === "blocked"
    && record.restartRequired === NESTED_AGENT_BRIDGE_RESTART_REQUIRED
    && record.terminalCause === TUI_RESTART_TERMINAL_CAUSE;
}

export function renderRecord(record: BackgroundTaskRecord): string {
  const restartHint = isRestartBlockedTask(record)
    ? " · resume required after TUI restart"
    : "";
  return `${record.id} · ${record.status}${record.exitCode !== undefined ? ` (exit ${record.exitCode})` : ""}${restartHint} · pid ${record.pid} · ${record.args.slice(1, 3).join(" ") || record.command}`;
}

function boundedCleanup(cleanup: Promise<void>, timeoutMs: number): Promise<void> {
  return Promise.race([
    cleanup,
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    }),
  ]);
}

export function interruptProcessTree(childOrPid: ChildProcess | number): void {
  const pid = typeof childOrPid === "number" ? childOrPid : childOrPid.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    if (typeof childOrPid !== "number") childOrPid.kill();
    return;
  }
  try { process.kill(-pid, "SIGINT"); }
  catch {
    if (typeof childOrPid !== "number") childOrPid.kill("SIGINT");
  }
}

function waitForProcessExit(task: LiveTask, timeoutMs: number): Promise<void> {
  if (!isProcessAlive(task.record.pid)) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      task.child?.removeListener("exit", finish);
      if (isProcessAlive(task.record.pid)) terminateProcessTree(task.child ?? task.record.pid);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    task.child?.once("exit", finish);
    if (!isProcessAlive(task.record.pid)) finish();
  });
}

export function terminateProcessTree(childOrPid: ChildProcess | number): void {
  const pid = typeof childOrPid === "number" ? childOrPid : childOrPid.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    const result = spawnSync("taskkill.exe", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore" });
    if (result.error || result.status !== 0) {
      if (typeof childOrPid !== "number") childOrPid.kill();
      else { try { process.kill(pid, "SIGTERM"); } catch { /* already exited */ } }
    }
    return;
  }
  try { process.kill(-pid, "SIGTERM"); }
  catch {
    if (typeof childOrPid !== "number") childOrPid.kill("SIGTERM");
  }
  const force = setTimeout(() => {
    try { process.kill(-pid, "SIGKILL"); } catch { /* already exited */ }
  }, 2_000);
  force.unref();
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return a non-secret process incarnation witness. Linux exposes a monotonic
 * process start tick in /proc; on platforms without a safe local primitive we
 * return undefined and adoption fails closed rather than trusting PID reuse.
 */
export function processIncarnationWitness(pid: number): string | undefined {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const closeParen = stat.lastIndexOf(")");
      if (closeParen < 0) return undefined;
      const fields = stat.slice(closeParen + 2).trim().split(/\s+/);
      const startTicks = fields[19];
      return startTicks ? `proc-start:${startTicks}` : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function isBridgeOwnerLive(record: BackgroundTaskRecord, currentOwnerId: string): boolean {
  if (record.ownerReleasedAt !== undefined) return false;
  if (record.ownerId === undefined && record.ownerPid === undefined && record.ownerHeartbeatAt === undefined && record.ownerIncarnation === undefined) return false;
  if (!record.ownerId || !record.ownerPid || !record.ownerHeartbeatAt || !record.ownerIncarnation) return false;
  if (record.ownerId === currentOwnerId) return true;
  if (!isProcessAlive(record.ownerPid)) return false;
  const heartbeatAt = Date.parse(record.ownerHeartbeatAt);
  if (!Number.isFinite(heartbeatAt) || Date.now() - heartbeatAt > SUPERVISOR_HEARTBEAT_TTL_MS) return false;
  return processIncarnationWitness(record.ownerPid) === record.ownerIncarnation;
}
