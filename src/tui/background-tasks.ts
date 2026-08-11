// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "@earendil-works/pi-coding-agent";
import { controllerEnvironment } from "../runtime/controller-environment.js";

export type BackgroundTaskStatus = "running" | "detached" | "completed" | "blocked" | "failed" | "cancelled";

export interface BackgroundTaskRecord {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  pid: number;
  logPath: string;
  status: BackgroundTaskStatus;
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
}

const MAX_BACKGROUND_TASKS = 4;

interface LiveTask {
  record: BackgroundTaskRecord;
  child?: ChildProcess;
  adopted: boolean;
  cleanup?: () => Promise<void>;
}

export class ForgeDockBackgroundTasks {
  readonly #pi: ExtensionAPI;
  readonly #live = new Map<string, LiveTask>();
  readonly #records = new Map<string, BackgroundTaskRecord>();
  #ticker: NodeJS.Timeout | undefined;
  #ctx: ExtensionContext | undefined;

  constructor(pi: ExtensionAPI) {
    this.#pi = pi;
  }

  initialize(ctx: ExtensionContext): void {
    this.#ctx = ctx;
    const directory = join(ctx.cwd, ".forgedock", "tasks");
    if (!existsSync(directory)) return;
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".json")) continue;
      try {
        const record = JSON.parse(readFileSync(join(directory, name), "utf8")) as BackgroundTaskRecord;
        if (!record.id || !record.logPath || !record.startedAt) continue;
        if (record.status === "running") {
          if (isProcessAlive(record.pid)) {
            // A terminal restart must not turn a still-running controller into a
            // false failure. Adopt it as a detached task and supervise its PID
            // and durable log until it exits.
            record.status = "detached";
            this.#live.set(record.id, { record, adopted: true });
          } else {
            record.status = "failed";
            record.completedAt = new Date().toISOString();
            this.persist(record);
          }
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
    ctx: ExtensionContext;
  }): BackgroundTaskRecord {
    if (this.#live.size >= MAX_BACKGROUND_TASKS) {
      throw new Error(`ForgeDock background task limit (${MAX_BACKGROUND_TASKS}) reached; wait for or cancel an existing task`);
    }
    const id = `task_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const directory = join(input.cwd, ".forgedock", "tasks");
    mkdirSync(directory, { recursive: true });
    const logPath = join(directory, `${id}.log`);
    const descriptor = openSync(logPath, "w");
    let child: ChildProcess;
    try {
      child = spawn(input.command, input.args, {
        cwd: input.cwd,
        env: controllerEnvironment(process.env, input.env),
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", descriptor, descriptor],
      });
    } finally {
      closeSync(descriptor);
    }
    if (!child.pid) throw new Error("ForgeDock background controller failed to start");
    const record: BackgroundTaskRecord = {
      id,
      command: input.command,
      args: [...input.args],
      cwd: input.cwd,
      pid: child.pid,
      logPath,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    this.#ctx = input.ctx;
    this.#records.set(id, record);
    this.#live.set(id, { record, child, adopted: false, ...(input.cleanup ? { cleanup: input.cleanup } : {}) });
    this.persist(record);
    child.once("error", (error) => void this.finish(id, "failed", undefined, error.message));
    child.once("exit", (code, signal) => {
      const status: BackgroundTaskStatus = signal ? "cancelled" : code === 0 ? "completed" : code === 2 ? "blocked" : "failed";
      void this.finish(id, status, code ?? undefined);
    });
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

  output(id: string): string {
    const record = this.recordsFromDisk().get(id);
    if (!record) throw new Error(`Unknown ForgeDock background task: ${id}`);
    const output = existsSync(record.logPath) ? readFileSync(record.logPath, "utf8") : "";
    const limited = truncateTail(output, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
    return `${renderRecord(record)}\n${limited.content || "(no output yet)"}${limited.truncated ? `\n[Output truncated; full log: ${record.logPath}]` : ""}`;
  }

  cancel(id: string): BackgroundTaskRecord {
    const live = this.#live.get(id);
    if (!live) {
      const record = this.recordsFromDisk().get(id);
      if (!record) throw new Error(`Unknown ForgeDock background task: ${id}`);
      if (record.status === "running" || record.status === "detached") {
        throw new Error(`Task ${id} belongs to another or interrupted ForgeDock session and is not supervised here`);
      }
      return record;
    }
    live.record.status = "cancelled";
    live.record.completedAt = new Date().toISOString();
    this.persist(live.record);
    terminateProcessTree(live.child ?? live.record.pid);
    this.renderStatus();
    return { ...live.record, args: [...live.record.args] };
  }

  async shutdown(): Promise<void> {
    const live = [...this.#live.values()];
    for (const task of live) this.cancel(task.record.id);
    await Promise.allSettled(live.map((task) => task.cleanup?.()));
    this.#live.clear();
    this.stopTicker();
    this.#ctx?.ui.setStatus("forgedock-tasks", undefined);
  }

  private async finish(id: string, status: BackgroundTaskStatus, exitCode?: number, detail?: string): Promise<void> {
    const live = this.#live.get(id);
    if (!live) return;
    if (live.record.status !== "cancelled") live.record.status = status;
    live.record.completedAt ??= new Date().toISOString();
    if (exitCode !== undefined) live.record.exitCode = exitCode;
    this.persist(live.record);
    this.#live.delete(id);
    await live.cleanup?.().catch(() => undefined);
    const message = `${renderRecord(live.record)}${detail ? ` — ${detail}` : ""}\nLog: ${live.record.logPath}`;
    this.#ctx?.ui.notify(message, live.record.status === "completed" ? "info" : "warning");
    try {
      this.#pi.sendMessage({ customType: "forgedock-background-task", content: message, display: true }, { deliverAs: "nextTurn" });
    } catch {
      // Session teardown can race completion; the persisted record and GitHub artifacts remain available.
    }
    this.renderStatus();
    if (!this.#live.size) this.stopTicker();
  }

  private recordsFromDisk(): Map<string, BackgroundTaskRecord> {
    return this.#records;
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
      this.reconcileAdoptedTasks();
      this.renderStatus();
    }, 1_000);
    this.#ticker.unref();
  }

  private stopTicker(): void {
    if (this.#ticker) clearInterval(this.#ticker);
    this.#ticker = undefined;
  }

  private reconcileAdoptedTasks(): void {
    for (const task of [...this.#live.values()]) {
      if (!task.adopted || task.record.status !== "detached") continue;
      if (isProcessAlive(task.record.pid)) continue;
      void this.finish(task.record.id, "failed", undefined, "Detached controller exited before this terminal reattached");
    }
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
}

export function renderRecord(record: BackgroundTaskRecord): string {
  return `${record.id} · ${record.status}${record.exitCode !== undefined ? ` (exit ${record.exitCode})` : ""} · pid ${record.pid} · ${record.args.slice(1, 3).join(" ") || record.command}`;
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
