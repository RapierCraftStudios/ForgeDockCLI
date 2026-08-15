// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { persistControllerTaskTerminal } from "./controller-task-record.js";

describe("controller-owned background task terminal records", () => {
  it("terminalizes a detached task before its controller exits", () => {
    const cwd = mkdtempSync(join(tmpdir(), "forgedock-controller-task-"));
    try {
      const path = taskRecord(cwd, { status: "detached", pid: 4242 });
      assert.equal(persistControllerTaskTerminal(2, {
        cwd,
        pid: 4242,
        env: { FORGEDOCK_CONTROLLER_TASK_ID: "task_owned" },
        completedAt: "2026-08-15T12:00:00.000Z",
      }), true);
      const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      assert.equal(record.status, "blocked");
      assert.equal(record.exitCode, 2);
      assert.equal(record.completedAt, "2026-08-15T12:00:00.000Z");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("maps successful and failed controller exits without overwriting terminal evidence", () => {
    for (const [exitCode, expected] of [[0, "completed"], [1, "failed"]] as const) {
      const cwd = mkdtempSync(join(tmpdir(), "forgedock-controller-task-"));
      try {
        const path = taskRecord(cwd, { status: "running", pid: 5252 });
        persistControllerTaskTerminal(exitCode, { cwd, pid: 5252, env: { FORGEDOCK_CONTROLLER_TASK_ID: "task_owned" } });
        assert.equal((JSON.parse(readFileSync(path, "utf8")) as { status: string }).status, expected);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  });

  it("rejects a task record owned by another process", () => {
    const cwd = mkdtempSync(join(tmpdir(), "forgedock-controller-task-"));
    try {
      const path = taskRecord(cwd, { status: "detached", pid: 6262 });
      const before = readFileSync(path, "utf8");
      assert.throws(() => persistControllerTaskTerminal(0, {
        cwd,
        pid: 7272,
        env: { FORGEDOCK_CONTROLLER_TASK_ID: "task_owned" },
      }), /does not belong to this process/);
      assert.equal(readFileSync(path, "utf8"), before);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("preserves an existing terminal result", () => {
    const cwd = mkdtempSync(join(tmpdir(), "forgedock-controller-task-"));
    try {
      const path = taskRecord(cwd, { status: "completed", pid: 8282, exitCode: 0 });
      const before = readFileSync(path, "utf8");
      assert.equal(persistControllerTaskTerminal(1, {
        cwd,
        pid: 8282,
        env: { FORGEDOCK_CONTROLLER_TASK_ID: "task_owned" },
      }), true);
      assert.equal(readFileSync(path, "utf8"), before);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

function taskRecord(cwd: string, input: {
  status: "running" | "detached" | "completed";
  pid: number;
  exitCode?: number;
}): string {
  const directory = join(cwd, ".forgedock", "tasks");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "task_owned.json");
  writeFileSync(path, JSON.stringify({
    id: "task_owned",
    command: process.execPath,
    args: ["controller"],
    cwd,
    pid: input.pid,
    logPath: join(directory, "task_owned.log"),
    status: input.status,
    startedAt: "2026-08-15T11:00:00.000Z",
    ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
  }));
  return path;
}
