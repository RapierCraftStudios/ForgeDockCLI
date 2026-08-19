// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { CheckResult, VerificationCommand, VerificationProgressCallback, VerificationRunner } from "../../core/ports/verification.js";
import { sealVerificationEnvironment, verificationEnvironment } from "../../runtime/controller-environment.js";

const DEFAULT_LOCK_PATH = join(tmpdir(), "forgedock-verification.lock");

export class ProcessVerificationRunner implements VerificationRunner {
  readonly #lockPath: string;
  readonly #environment: NodeJS.ProcessEnv;

  constructor(options: { lockPath?: string; environment?: NodeJS.ProcessEnv } = {}) {
    this.#lockPath = options.lockPath ?? DEFAULT_LOCK_PATH;
    this.#environment = sealVerificationEnvironment(options.environment ?? process.env);
  }

  async run(
    commands: readonly VerificationCommand[],
    signal?: AbortSignal,
    onProgress?: VerificationProgressCallback,
  ): Promise<CheckResult[]> {
    const results: CheckResult[] = [];
    const bufferedGlobalProgress: Parameters<VerificationProgressCallback>[0][] = [];
    let releaseGlobal: (() => void) | undefined;
    const flushGlobalProgress = async () => {
      for (const progress of bufferedGlobalProgress.splice(0)) {
        await emitProgress(onProgress, progress);
      }
    };
    const releaseGlobalLock = async () => {
      if (!releaseGlobal) return;
      releaseGlobal();
      releaseGlobal = undefined;
      bufferedGlobalProgress.push({ phase: "lock-released", lockScope: "machine-global" });
      await flushGlobalProgress();
    };
    const reportCommandProgress = async (progress: Parameters<VerificationProgressCallback>[0]) => {
      if (releaseGlobal) bufferedGlobalProgress.push(progress);
      else await emitProgress(onProgress, progress);
    };
    try {
      for (const [index, command] of commands.entries()) {
        if (signal?.aborted) throw signal.reason ?? new Error("Verification aborted");
        const lockScope = command.lockScope ?? "machine-global";
        if (lockScope === "machine-global" && !releaseGlobal) {
          await emitProgress(onProgress, { phase: "lock-waiting", lockScope });
          releaseGlobal = await acquireVerificationLock(this.#lockPath, signal);
          bufferedGlobalProgress.push({ phase: "lock-acquired", lockScope });
        } else if (lockScope === "workspace") {
          await releaseGlobalLock();
        }
        await reportCommandProgress({
          phase: "command-started",
          commandId: command.id,
          index,
          total: commands.length,
        });
        cleanOperationalOutput(command);
        const result = await runOne(command, this.#environment, signal);
        results.push(result);
        await reportCommandProgress({
          phase: "command-completed",
          commandId: command.id,
          index,
          total: commands.length,
          status: result.status,
          durationMs: result.durationMs,
        });
      }
      return results;
    } finally {
      await releaseGlobalLock();
    }
  }
}

function cleanOperationalOutput(command: VerificationCommand): void {
  if (command.typescriptLayout) {
    const configPath = resolve(command.cwd, command.typescriptLayout.project);
    const digest = createHash("sha256").update(readFileSync(configPath)).digest("hex").slice(0, 16);
    if (digest !== command.typescriptLayout.configDigest) {
      throw new Error(`Frozen TypeScript configuration changed before verification: ${command.typescriptLayout.project}`);
    }
  }
  if (!command.cleanOutputRoot) return;
  const workspace = resolve(command.cwd);
  const output = resolve(workspace, command.cleanOutputRoot);
  const relativeOutput = relative(workspace, output).replaceAll("\\", "/");
  if (!relativeOutput.startsWith(".forgedock/verification-") || relativeOutput.includes("..")) {
    throw new Error(`Unsafe verification output cleanup path: ${command.cleanOutputRoot}`);
  }
  rmSync(output, { recursive: true, force: true });
}

async function emitProgress(
  callback: VerificationProgressCallback | undefined,
  progress: Parameters<VerificationProgressCallback>[0],
): Promise<void> {
  if (!callback) return;
  try { await callback(progress); } catch { /* progress is operational evidence, never command authority */ }
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
    // Cancellation can win between the caller's pre-check and listener
    // registration. AbortSignal does not replay an already-fired event.
    if (signal?.aborted) abort();
  });
}

function verificationResultMetadata(spec: VerificationCommand): Pick<
  CheckResult,
  "command" | "commandId" | "policyVersion" | "commandTargets" | "coveredBy" | "planId"
> {
  return {
    command: [spec.command, ...spec.args].join(" "),
    commandId: spec.id,
    ...(spec.policyVersion !== undefined ? { policyVersion: spec.policyVersion } : {}),
    ...(spec.targets !== undefined ? { commandTargets: [...spec.targets] } : {}),
    ...(spec.coveredBy !== undefined ? { coveredBy: [...spec.coveredBy] } : {}),
    ...(spec.planId !== undefined ? { planId: spec.planId } : {}),
  };
}

function runOne(spec: VerificationCommand, environment: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<CheckResult> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    let settled = false;
    let cancelled = false;
    let abortReason: unknown;
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
    const abort = () => {
      if (!cancelled) {
        cancelled = true;
        abortReason = signal?.reason ?? new Error("Verification aborted");
      }
      terminate();
    };
    signal?.addEventListener("abort", abort, { once: true });
    // Do not miss cancellation fired after the run-loop pre-check but before
    // this listener was installed. Termination still settles through the child
    // event so no process is left behind when the promise rejects.
    if (signal?.aborted) abort();
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (cancelled) {
        reject(abortReason);
        return;
      }
      const durationMs = Math.max(0, Math.round(performance.now() - started));
      const errorCode = error.code ?? error.name ?? "spawn-error";
      const summary = `Failed to start verification command (${errorCode})`;
      resolve({
        ...verificationResultMetadata(spec),
        status: "failed",
        failureClass: "infrastructure",
        durationMs,
        outputDigest: createHash("sha256").update(summary).digest("hex"),
        summary,
        failureSignatures: [summary],
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (cancelled) {
        reject(abortReason);
        return;
      }
      const output = redactVerificationOutput(Buffer.concat(chunks).toString("utf8"));
      const durationMs = Math.max(0, Math.round(performance.now() - started));
      const status = code === 0 && !timedOut ? "passed" as const : "failed" as const;
      const summary = summarize(output, timedOut, status);
      const failureSignatures = status === "failed" ? extractFailureSignatures(output, timedOut) : [];
      resolve({
        ...verificationResultMetadata(spec),
        status,
        ...(status === "failed" ? {
          failureClass: timedOut ? ("timeout" as const) : ("command" as const),
        } : {}),
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
    if (!windowsTaskkillSucceeded(result)) child.kill();
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

/** A launched taskkill process can fail without populating `error`; its exit status is authoritative. */
export function windowsTaskkillSucceeded(result: { error?: Error; status: number | null }): boolean {
  return result.error === undefined && result.status === 0;
}

function redactVerificationOutput(output: string): string {
  return output
    .replace(/(?:\x1b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/(?:\x1b\]|\u009d)[\s\S]*?(?:\x07|\x1b\\|\u009c)/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1[REDACTED]@")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b(?:ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|glpat-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{8,})\b/gi, "[REDACTED_TOKEN]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]")
    .replace(/\b([A-Za-z0-9_]*(?:token|secret|password|passwd|api[_-]?key|private[_-]?key|credential)[A-Za-z0-9_]*)\s*[:=]\s*[^\s|]+/gi, "$1=[REDACTED]");
}

function summarize(output: string, timedOut: boolean, status: "passed" | "failed"): string {
  if (timedOut) return "Timed out";
  const normalized = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim();
  if (!normalized) return "";
  const lines = normalized.split(/\r?\n/).filter(Boolean);
  if (status === "failed") {
    const firstFailure = lines.findIndex((line) => /^\s*not ok\s+\d+\s+-\s+/.test(line));
    if (firstFailure >= 0) return lines.slice(firstFailure, firstFailure + 16).join(" | ").slice(0, 1_500);
    const nodeFailure = lines.findIndex((line) => /^\s*[✖✕]\s+failing tests:\s*$/i.test(line));
    if (nodeFailure >= 0) return lines.slice(nodeFailure, nodeFailure + 16).join(" | ").slice(0, 1_500);
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
  const nodeLines = normalized.split(/\r?\n/);
  const nodeFailure = nodeLines.findIndex((line) => /^\s*[✖✕]\s+failing tests:\s*$/i.test(line));
  const nodeTestSignatures = (nodeFailure >= 0 ? nodeLines.slice(nodeFailure + 1) : [])
    .map((line) => line.trim())
    .map((line) => /^\s*[✖✕]\s+(.+?)(?:\s+\([\d.]+ms\))?\s*$/.exec(line)?.[1]?.trim())
    .filter((value): value is string => value !== undefined && value.length > 0)
    .map((value) => `node test - ${value}`);
  if (nodeTestSignatures.length) return [...new Set(nodeTestSignatures)].sort();
  const codes = [...normalized.matchAll(/\b(?:ERR|E)[A-Z0-9_]{2,}\b/g)].map((match) => match[0]);
  return [...new Set(codes)].sort();
}
