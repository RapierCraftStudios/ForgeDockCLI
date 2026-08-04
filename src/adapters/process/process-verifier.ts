// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CheckResult, VerificationCommand, VerificationRunner } from "../../core/ports/verification.js";
import { verificationEnvironment } from "../../runtime/controller-environment.js";

const DEFAULT_LOCK_PATH = join(tmpdir(), "forgedock-verification.lock");

export class ProcessVerificationRunner implements VerificationRunner {
  readonly #lockPath: string;
  readonly #environment: NodeJS.ProcessEnv;

  constructor(options: { lockPath?: string; environment?: NodeJS.ProcessEnv } = {}) {
    this.#lockPath = options.lockPath ?? DEFAULT_LOCK_PATH;
    this.#environment = { ...(options.environment ?? process.env) };
  }

  async run(commands: readonly VerificationCommand[], signal?: AbortSignal): Promise<CheckResult[]> {
    const release = await acquireVerificationLock(this.#lockPath, signal);
    try {
      const results: CheckResult[] = [];
      for (const command of commands) {
        if (signal?.aborted) throw signal.reason ?? new Error("Verification aborted");
        const result = await runOne(command, this.#environment, signal);
        results.push(result);
        if (command.required && result.status === "failed") break;
      }
      return results;
    } finally {
      release();
    }
  }
}

async function acquireVerificationLock(path: string, signal?: AbortSignal): Promise<() => void> {
  const token = crypto.randomUUID();
  while (true) {
    if (signal?.aborted) throw signal.reason ?? new Error("Verification aborted while waiting for the machine-wide verification lease");
    try {
      const descriptor = openSync(path, "wx", 0o600);
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }));
      closeSync(descriptor);
      return () => {
        try {
          const current = JSON.parse(readFileSync(path, "utf8")) as { token?: string };
          if (current.token === token) unlinkSync(path);
        } catch {
          // The lease was already removed or replaced; never unlink another owner's lock.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (isStaleVerificationLock(path)) {
        try { unlinkSync(path); } catch { /* another waiter recovered it first */ }
        continue;
      }
      await wait(250, signal);
    }
  }
}

function isStaleVerificationLock(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { pid?: number };
    if (!Number.isSafeInteger(value.pid) || (value.pid ?? 0) < 1) return Date.now() - statSync(path).mtimeMs > 5_000;
    try {
      process.kill(value.pid!, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    try { return Date.now() - statSync(path).mtimeMs > 5_000; }
    catch { return false; }
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new Error("Verification aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function runOne(spec: VerificationCommand, environment: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<CheckResult> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: verificationEnvironment(environment),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const chunks: Buffer[] = [];
    const capture = (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    let timedOut = false;
    let terminating = false;
    const terminate = () => {
      if (terminating) return;
      terminating = true;
      terminateProcessTree(child);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, spec.timeoutMs);
    const abort = terminate;
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const output = Buffer.concat(chunks).toString("utf8");
      const durationMs = Math.max(0, Math.round(performance.now() - started));
      const status = code === 0 && !timedOut ? "passed" as const : "failed" as const;
      const summary = summarize(output, timedOut, status);
      const failureSignatures = status === "failed" ? extractFailureSignatures(output, timedOut) : [];
      resolve({
        command: [spec.command, ...spec.args].join(" "),
        status,
        ...(typeof code === "number" ? { exitCode: code } : {}),
        durationMs,
        outputDigest: createHash("sha256").update(output).digest("hex"),
        ...(summary ? { summary } : {}),
        ...(failureSignatures.length ? { failureSignatures } : {}),
      });
    });
  });
}

function terminateProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) {
    child.kill();
    return;
  }
  if (process.platform === "win32") {
    const result = spawnSync("taskkill.exe", ["/pid", String(pid), "/T", "/F"], {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    if (result.error) child.kill();
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const force = setTimeout(() => {
    try { process.kill(-pid, "SIGKILL"); } catch { /* process group already exited */ }
  }, 2_000);
  force.unref();
}

function summarize(output: string, timedOut: boolean, status: "passed" | "failed"): string {
  if (timedOut) return "Timed out";
  const normalized = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim();
  if (!normalized) return "";
  const lines = normalized.split(/\r?\n/).filter(Boolean);
  if (status === "failed") {
    const firstFailure = lines.findIndex((line) => /^\s*not ok\s+\d+\s+-\s+/.test(line));
    if (firstFailure >= 0) return lines.slice(firstFailure, firstFailure + 16).join(" | ").slice(0, 1_500);
  }
  return lines.slice(-3).join(" | ").slice(0, 500);
}

function extractFailureSignatures(output: string, timedOut: boolean): string[] {
  if (timedOut) return ["timeout"];
  const normalized = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const signatures = normalized.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^not ok\s+\d+\s+-\s+/.test(line))
    .map((line) => line.replace(/^not ok\s+\d+\s+-\s+/, "not ok - "));
  if (signatures.length) return [...new Set(signatures)].sort();
  const codes = [...normalized.matchAll(/\b(?:ERR|E)[A-Z0-9_]{2,}\b/g)].map((match) => match[0]);
  return [...new Set(codes)].sort();
}
