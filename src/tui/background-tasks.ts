// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "@earendil-works/pi-coding-agent";
import { controllerEnvironment } from "../runtime/controller-environment.js";
import { BackgroundTaskObservationAdapter } from "../observability/adapters.js";
import type { ObservationSink } from "../observability/contracts.js";

export type BackgroundTaskStatus = "running" | "detached" | "completed" | "blocked" | "failed" | "cancelled";

/**
 * A native controller can depend on an in-memory transport owned by the TUI.
 * Keep this marker deliberately non-secret: the bridge URL and bearer token
 * stay in the child environment and are never written to the task record.
 */
export const NESTED_AGENT_BRIDGE_RESTART_REQUIRED = "nested-agent-bridge" as const;
export type BackgroundTaskRestartRequirement = typeof NESTED_AGENT_BRIDGE_RESTART_REQUIRED;
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
  /** Non-secret operational binding; never store bridge URL/token here. */
  restartRequired?: BackgroundTaskRestartRequirement;
  /** Non-secret routing hint for the durable recovery handoff. */
  resumeScope?: BackgroundTaskResumeScope;
}

const MAX_BACKGROUND_TASKS = 4;

interface LiveTask {
  record: BackgroundTaskRecord;
  child?: ChildProcess;
  stderrLogPath?: string;
  stdoutOffset: number;
  stderrOffset: number;
  adopted: boolean;
  cleanup?: () => Promise<void>;
}

export class ForgeDockBackgroundTasks {
  readonly #pi: ExtensionAPI;
  readonly #live = new Map<string, LiveTask>();
  readonly #records = new Map<string, BackgroundTaskRecord>();
  readonly #directories = new Set<string>();
  #ticker: NodeJS.Timeout | undefined;
  #ctx: ExtensionContext | undefined;
  #observationAdapter: BackgroundTaskObservationAdapter | undefined;
  readonly #finishing = new Set<string>();

  constructor(pi: ExtensionAPI) {
    this.#pi = pi;
  }

  setObservationSink(sink: ObservationSink | undefined): void {
    this.#observationAdapter = sink ? new BackgroundTaskObservationAdapter(sink) : undefined;
    if (!this.#observationAdapter) return;
    for (const live of this.#live.values()) {
      if (live.adopted) this.#observationAdapter.adopted(live.record.id, live.record.pid);
    }
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
            // The nested-agent bridge lives in the previous TUI process. It
            // cannot be reattached from a fresh terminal, so adopting this
            // controller would present a healthy PID with a dead reviewer
            // transport. Stop it and make the interruption an explicit,
            // resumable checkpoint instead.
            if (isProcessAlive(record.pid)) terminateProcessTree(record.pid);
            record.status = "blocked";
            record.completedAt ??= new Date().toISOString();
            record.exitCode ??= 2;
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
    ctx: ExtensionContext;
  }): BackgroundTaskRecord {
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
    let child: ChildProcess;
    try {
      child = spawn(input.command, input.args, {
        cwd: input.cwd,
        env: controllerEnvironment(process.env, { ...input.env, FORGEDOCK_CONTROLLER_TASK_ID: id }),
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", stdoutFd, stderrFd],
      });
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
    };
    this.#ctx = input.ctx;
    const live: LiveTask = { record, child, stderrLogPath, stdoutOffset: 0, stderrOffset: 0, adopted: false, ...(input.cleanup ? { cleanup: input.cleanup } : {}) };
    this.#records.set(id, record);
    this.#live.set(id, live);
    this.persist(record);
    this.#observationAdapter?.started(record);
    const onError = (error: Error) => void this.finish(id, "failed", undefined, error.message);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const status: BackgroundTaskStatus = signal ? "cancelled" : code === 0 ? "completed" : code === 2 ? "blocked" : "failed";
      void this.finish(id, status, code ?? undefined);
    };
    child.once("error", onError);
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
    let lastOutputSize = 0;
    let lastProgressAt = Date.now();
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
      const outputSize = fileSize(record.logPath) + fileSize(record.stderrLogPath);
      if (outputSize > lastOutputSize) {
        lastOutputSize = outputSize;
        lastProgressAt = Date.now();
        warned = false;
      } else if (!warned && Date.now() - lastProgressAt >= warnAfterMs) {
        warned = true;
        const message = `ForgeDock controller task ${id} has no observable semantic output for ${Math.round(warnAfterMs / 1_000)}s; durable state remains authoritative and recovery is still explicit.`;
        this.#ctx?.ui.notify(message, "warning");
        try { this.#pi.sendMessage({ customType: "forgedock-progress-warning", content: message, display: true }, { deliverAs: "nextTurn" }); } catch { /* session teardown */ }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
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
      await Promise.allSettled(live.map((task) => task.cleanup?.()));
    } else {
      for (const task of live) {
        if (task.record.status === "running") {
          task.record.status = "detached";
          this.persist(task.record);
        }
      }
    }
    this.#live.clear();
    this.stopTicker();
    this.#ctx?.ui.setStatus("forgedock-tasks", undefined);
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
      const restartBlocked = persisted?.status === "blocked"
        && persisted.restartRequired === NESTED_AGENT_BRIDGE_RESTART_REQUIRED;
      if (persisted) live.record = persisted;
      if (!restartBlocked && live.record.status !== "cancelled") live.record.status = status;
      live.record.completedAt ??= new Date().toISOString();
      if (exitCode !== undefined) live.record.exitCode = exitCode;
      this.captureLogDeltas(live);
      this.persist(live.record);
      if (observationAdapter) await observationAdapter.finished(id, live.record.status, exitCode);
      this.#live.delete(id);
      await live.cleanup?.().catch(() => undefined);
      const terminalDetail = detail ?? (live.record.status === "completed" ? undefined : boundedTerminalError(live.record.stderrLogPath));
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
      void this.reconcileAdoptedTasks();
      this.renderStatus();
    }, 1_000);
    this.#ticker.unref();
  }

  private stopTicker(): void {
    if (this.#ticker) clearInterval(this.#ticker);
    this.#ticker = undefined;
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
      this.#ctx?.ui.notify(message, "warning");
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
    this.#ctx?.ui.notify(message, "warning");
    try {
      this.#pi.sendMessage({ customType: "forgedock-background-task", content: message, display: true }, { deliverAs: "nextTurn" });
    } catch {
      // Session startup/teardown can race notification delivery; the blocked
      // record and durable workflow checkpoint remain authoritative.
    }
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
    && (record.restartRequired === undefined || record.restartRequired === NESTED_AGENT_BRIDGE_RESTART_REQUIRED)
    && (record.resumeScope === undefined || ["orchestration", "work-on", "review-pr-rerun", "promote", "workflow"].includes(record.resumeScope))
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

export function renderRecord(record: BackgroundTaskRecord): string {
  const restartHint = record.restartRequired === NESTED_AGENT_BRIDGE_RESTART_REQUIRED && record.status === "blocked"
    ? " · resume required after TUI restart"
    : "";
  return `${record.id} · ${record.status}${record.exitCode !== undefined ? ` (exit ${record.exitCode})` : ""}${restartHint} · pid ${record.pid} · ${record.args.slice(1, 3).join(" ") || record.command}`;
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
