// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

type ControllerTaskStatus = "running" | "detached" | "completed" | "blocked" | "failed" | "cancelled";

interface ControllerTaskRecord {
  id: string;
  cwd: string;
  pid: number;
  status: ControllerTaskStatus;
  completedAt?: string;
  exitCode?: number;
  [key: string]: unknown;
}

export interface ControllerTaskTerminalOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  pid?: number;
  completedAt?: string;
}

/**
 * Persist the controller's own terminal result before process exit. This lets
 * a restarted TUI adopt a detached process without losing its exit status.
 * The task file, checkout, and PID must all bind to this exact process.
 */
export function persistControllerTaskTerminal(
  exitCode: number,
  options: ControllerTaskTerminalOptions = {},
): boolean {
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const pid = options.pid ?? process.pid;
  const id = env.FORGEDOCK_CONTROLLER_TASK_ID?.trim();
  if (!id) return false;
  if (!/^task_[A-Za-z0-9_-]{1,120}$/.test(id)) throw new Error("Invalid ForgeDock controller task identity");
  if (!Number.isInteger(exitCode) || exitCode < 0 || !Number.isInteger(pid) || pid < 1) {
    throw new Error("Controller task terminal evidence is invalid");
  }

  const taskPath = resolve(cwd, ".forgedock", "tasks", `${id}.json`);
  if (!existsSync(taskPath)) return false;
  for (const path of [resolve(cwd, ".forgedock"), resolve(cwd, ".forgedock", "tasks"), taskPath]) {
    if (lstatSync(path).isSymbolicLink()) throw new Error("Controller task record path cannot contain symbolic links");
  }
  const record = JSON.parse(readFileSync(taskPath, "utf8")) as unknown;
  if (!isControllerTaskRecord(record)
    || record.id !== id
    || !samePath(record.cwd, cwd)
    || record.pid !== pid) {
    throw new Error("Controller task record does not belong to this process");
  }
  if (isTerminal(record.status)) return true;

  const terminal: ControllerTaskRecord = {
    ...record,
    status: exitCode === 0 ? "completed" : exitCode === 2 ? "blocked" : "failed",
    completedAt: options.completedAt ?? new Date().toISOString(),
    exitCode,
  };
  const temporary = `${taskPath}.${pid}.${randomUUID()}.terminal.tmp`;
  writeFileSync(temporary, `${JSON.stringify(terminal, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, taskPath);
  return true;
}

function isControllerTaskRecord(value: unknown): value is ControllerTaskRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<ControllerTaskRecord>;
  return typeof record.id === "string"
    && typeof record.cwd === "string"
    && Number.isInteger(record.pid)
    && typeof record.status === "string"
    && ["running", "detached", "completed", "blocked", "failed", "cancelled"].includes(record.status);
}

function isTerminal(status: ControllerTaskStatus): boolean {
  return status === "completed" || status === "blocked" || status === "failed" || status === "cancelled";
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
