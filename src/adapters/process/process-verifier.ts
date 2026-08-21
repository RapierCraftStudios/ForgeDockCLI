// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve as resolvePath, sep } from "node:path";
import { tmpdir } from "node:os";
import type { CheckResult, VerificationCommand, VerificationProgressCallback, VerificationRunner } from "../../core/ports/verification.js";
import { sealVerificationEnvironment, verificationEnvironment } from "../../runtime/controller-environment.js";

const DEFAULT_LOCK_PATH = join(tmpdir(), "forgedock-verification.lock");

export const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
export const MAX_CAPTURE_CHUNKS = 1_024;
export const MAX_REDACTION_CARRY_CHARS = 4_096;
export const OUTPUT_TRUNCATION_MARKER = "[verification output truncated]";

export class ProcessVerificationRunner implements VerificationRunner {
  readonly #lockPath: string;
  readonly #environment: NodeJS.ProcessEnv;

  constructor(options: { lockPath?: string; environment?: NodeJS.ProcessEnv } = {}) {
    this.#lockPath = options.lockPath ?? DEFAULT_LOCK_PATH;
    this.#environment = sealVerificationEnvironment(options.environment ?? process.env);
  }

  async prepareOperationalOutput(commands: readonly VerificationCommand[]): Promise<void> {
    const prepared = new Map<string, { token: string; markerName: string; identity: string; root: string }>();
    let primaryError: unknown;
    let cleanupError: unknown;
    try {
      for (const command of commands) {
        validateTypeScriptConfiguration(command);
        prepareOperationalOutput(command, prepared);
      }
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      for (const [root, ownership] of prepared) {
        try { cleanupOperationalOutput(root, ownership.token, ownership.markerName); }
        catch (error) {
          if (error instanceof DeferredCleanupError && primaryError !== undefined) {
            attachCleanupDiagnostic(primaryError, error);
          } else cleanupError ??= error;
        }
      }
      if (cleanupError !== undefined) {
        if (primaryError !== undefined) attachCleanupDiagnostic(primaryError, cleanupError);
        else throw cleanupError;
      }
    }
  }

  async recoverOperationalOutput(commands: readonly VerificationCommand[]): Promise<void> {
    const recovered = new Set<string>();
    for (const command of commands) {
      if (!command.typescriptLayout) continue;
      const root = resolvePath(command.cwd, command.typescriptLayout.outputRoot);
      if (recovered.has(root)) continue;
      validateTypeScriptConfiguration(command);
      recoverStaleOperationalOutput(command);
      recovered.add(root);
    }
  }

  async run(
    commands: readonly VerificationCommand[],
    signal?: AbortSignal,
    onProgress?: VerificationProgressCallback,
  ): Promise<CheckResult[]> {
    const preparedOutputs = new Map<string, { token: string; markerName: string; identity: string; root: string }>();
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
    let primaryError: unknown;
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
        validateTypeScriptConfiguration(command);
        prepareOperationalOutput(command, preparedOutputs);
        const ownership = command.typescriptLayout
          ? preparedOutputs.get(resolvePath(command.cwd, command.typescriptLayout.outputRoot))
          : undefined;
        const result = await runOne(command, this.#environment, signal, ownership);
        results.push(result);
        if (result.status === "failed" && primaryError === undefined) {
          primaryError = new Error(result.summary ?? `Verification command failed: ${result.commandId}`);
        }
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
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      let cleanupError: unknown;
      for (const [root, ownership] of preparedOutputs) {
        try { cleanupOperationalOutput(root, ownership.token, ownership.markerName); }
        catch (error) {
          if (error instanceof DeferredCleanupError && primaryError !== undefined) {
            attachCleanupDiagnostic(primaryError, error);
          } else cleanupError ??= error;
        }
        finally { preparedOutputs.delete(root); }
      }
      try { await releaseGlobalLock(); }
      catch (error) { cleanupError ??= error; }
      if (cleanupError !== undefined) {
        if (primaryError !== undefined) attachCleanupDiagnostic(primaryError, cleanupError);
        else throw cleanupError;
      }
    }
  }
}

class DeferredCleanupError extends Error {
  readonly deferred = true;
}

function attachCleanupDiagnostic(primary: unknown, cleanup: unknown): void {
  if (!primary || (typeof primary !== "object" && typeof primary !== "function")) return;
  const message = cleanup instanceof Error ? cleanup.message : String(cleanup);
  try { Object.defineProperty(primary, "verificationCleanupDiagnostic", { value: message.slice(0, 1_000), configurable: true }); }
  catch { /* diagnostics never replace the primary failure */ }
}
function validateTypeScriptConfiguration(command: VerificationCommand): void {
  if (!command.typescriptLayout) return;
  const markerName = command.typescriptLayout.markerName;
  if (markerName !== undefined && (!markerName || markerName === "." || markerName === ".." || markerName.includes("/") || markerName.includes("\\"))) {
    throw new Error(`Unsafe verification output marker name: ${markerName}`);
  }
  const configPath = resolvePath(command.cwd, command.typescriptLayout.project);
  const configRelative = relative(resolvePath(command.cwd), configPath);
  if (!configRelative || configRelative === ".." || configRelative.startsWith(`..${sep}`)) {
    throw new Error(`Unsafe TypeScript project path: ${command.typescriptLayout.project}`);
  }
  validateProjectComponents(resolvePath(command.cwd), configPath);
  const configStat = tryLstat(configPath);
  if (!configStat || configStat.isSymbolicLink() || !configStat.isFile()) {
    throw new Error(`Unsafe TypeScript project path: ${command.typescriptLayout.project}`);
  }
  const digest = createHash("sha256").update(readFileSync(configPath)).digest("hex").slice(0, 16);
  if (digest !== command.typescriptLayout.configDigest) {
    throw new Error(`Frozen TypeScript configuration changed before verification: ${command.typescriptLayout.project}`);
  }
}

function prepareOperationalOutput(command: VerificationCommand, prepared: Map<string, { token: string; markerName: string; identity: string; root: string }>): void {
  const layout = command.typescriptLayout;
  if (!layout) return;
  const workspace = resolvePath(command.cwd);
  const outputRelative = command.cleanOutputRoot ?? layout.outputRoot;
  const output = resolvePath(workspace, outputRelative);
  const configured = resolvePath(workspace, layout.configuredOutputRoot ?? "");
  const relativeOutput = relative(workspace, output).replaceAll("\\", "/");
  const relativeConfigured = relative(workspace, configured).replaceAll("\\", "/");
  if (!relativeOutput || relativeOutput === ".." || relativeOutput.startsWith("../") || relativeOutput.includes("/../")
    || !relativeConfigured || relativeConfigured === ".." || relativeConfigured.startsWith("../") || relativeConfigured.includes("/../")
    || output === configured) throw new Error(`Unsafe verification output cleanup path: ${outputRelative}`);
  validateRegularComponents(workspace, output, "staging output");
  validateRegularComponents(workspace, configured, "configured output");
  const markerName = layout.markerName ?? ".forgedock-verification-marker.json";
  const identity = layout.stagingIdentity ?? `${command.planId ?? "unbound"}:${layout.configDigest}`;
  const existingToken = prepared.get(output);
  if (existingToken) {
    if (existingToken.markerName !== markerName || existingToken.identity !== identity || existingToken.root !== output) {
      throw new Error(`Verification staging identity collision refused: ${output}`);
    }
    return;
  }
  recoverStaleOperationalOutput(command);
  const token = randomUUID();
  const pending = join(dirname(output), `.${basename(output)}.forgedock-verification-pending-${token}`);
  mkdirSync(pending, { recursive: false, mode: 0o700 });
  try {
    const descriptor = openSync(join(pending, markerName), "wx", 0o600);
    try { writeFileSync(descriptor, JSON.stringify({ schema: "forgedock.verification-output/v1", identity, pid: process.pid, token })); }
    finally { closeSync(descriptor); }
    renameSync(pending, output);
  } catch (error) {
    try { rmSync(pending, { recursive: true, force: false }); } catch { /* preserve the original publication failure */ }
    throw error;
  }
  prepared.set(output, { token, markerName, identity, root: output });
}

function recoverStaleOperationalOutput(command: VerificationCommand): void {
  const layout = command.typescriptLayout;
  if (!layout) return;
  const workspace = resolvePath(command.cwd);
  const outputRelative = command.cleanOutputRoot ?? layout.outputRoot;
  const output = resolvePath(workspace, outputRelative);
  const configured = resolvePath(workspace, layout.configuredOutputRoot ?? "");
  const relativeOutput = relative(workspace, output).replaceAll("\\", "/");
  const relativeConfigured = relative(workspace, configured).replaceAll("\\", "/");
  if (!relativeOutput || relativeOutput === ".." || relativeOutput.startsWith("../") || relativeOutput.includes("/../")
    || !relativeConfigured || relativeConfigured === ".." || relativeConfigured.startsWith("../") || relativeConfigured.includes("/../")
    || output === configured) throw new Error(`Unsafe verification output cleanup path: ${outputRelative}`);
  validateRegularComponents(workspace, output, "staging output");
  validateRegularComponents(workspace, configured, "configured output");
  const markerName = layout.markerName ?? ".forgedock-verification-marker.json";
  const identity = layout.stagingIdentity ?? `${command.planId ?? "unbound"}:${layout.configDigest}`;
  recoverPendingOperationalOutput(dirname(output), `.${basename(output)}.forgedock-verification-pending-`, markerName, identity);
  const stat = tryLstat(output);
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Verification staging collision is not a regular directory: ${output}`);
  const marker = readOperationalMarker(join(output, markerName));
  if (!marker || marker.identity !== identity || marker.schema !== "forgedock.verification-output/v1" || typeof marker.token !== "string" || !Number.isSafeInteger(marker.pid)) {
    throw new Error(`Unknown verification staging collision refused: ${output}`);
  }
  if (isLivePid(marker.pid!)) throw new Error(`Active verification staging collision refused: ${output}`);
  if (marker.childPgid !== undefined && isLiveProcessGroup(marker.childPgid)) throw new Error(`Active verification child process group refused: ${output}`);
  if (marker.childPid !== undefined && isLivePid(marker.childPid)) throw new Error(`Active verification child refused: ${output}`);
  rmSync(output, { recursive: true, force: false });
}
function recoverPendingOperationalOutput(parent: string, prefix: string, markerName: string, identity: string): void {
  let entries: string[];
  try { entries = readdirSync(parent); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries.filter((name) => name.startsWith(prefix)).slice(0, 16)) {
    const pending = join(parent, entry);
    const stat = tryLstat(pending);
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Verification pending staging collision refused: ${pending}`);
    const marker = readOperationalMarker(join(pending, markerName));
    if (!marker) continue;
    if (marker.schema !== "forgedock.verification-output/v1" || marker.identity !== identity || typeof marker.token !== "string" || !Number.isSafeInteger(marker.pid)) continue;
    if (isLivePid(marker.pid!) || (marker.childPgid !== undefined && isLiveProcessGroup(marker.childPgid)) || (marker.childPid !== undefined && isLivePid(marker.childPid))) {
      throw new Error(`Active verification pending staging collision refused: ${pending}`);
    }
    rmSync(pending, { recursive: true, force: false });
  }
}

function validateRegularComponents(workspace: string, target: string, label: string): void {
  const rel = relative(workspace, target);
  const components = rel.split(sep);
  let current = workspace;
  for (const component of components.slice(0, -1)) {
    current = join(current, component);
    const stat = tryLstat(current);
    if (!stat) throw new Error(`Verification ${label} parent does not exist: ${current}`);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Verification ${label} path component is unsafe: ${current}`);
  }
  const stat = tryLstat(target);
  if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new Error(`Verification ${label} is unsafe: ${target}`);
}

function validateProjectComponents(workspace: string, target: string): void {
  const rel = relative(workspace, target);
  const components = rel.split(sep);
  let current = workspace;
  for (const component of components) {
    current = join(current, component);
    const stat = tryLstat(current);
    if (!stat) throw new Error(`TypeScript project path does not exist: ${target}`);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && component !== components.at(-1))) {
      throw new Error(`TypeScript project path is unsafe: ${target}`);
    }
  }
}
function tryLstat(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function readOperationalMarker(path: string): { schema?: string; identity?: string; pid?: number; token?: string; childPid?: number; childPgid?: number } | undefined {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Verification marker is not a regular file: ${path}`);
    return JSON.parse(readFileSync(path, "utf8")) as { schema?: string; identity?: string; pid?: number; token?: string };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isLivePid(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

function isLiveProcessGroup(pgid: number): boolean {
  if (process.platform === "win32") return isLivePid(pgid);
  try { process.kill(-pgid, 0); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

export async function waitForProcessTreeQuiescence(
  pid: number | undefined,
  pgid: number | undefined,
  timeoutMs = 2_500,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const livePid = pid !== undefined && isLivePid(pid);
    const liveGroup = pgid !== undefined && isLiveProcessGroup(pgid);
    if (!livePid && !liveGroup) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !(
    (pid !== undefined && isLivePid(pid)) ||
    (pgid !== undefined && isLiveProcessGroup(pgid))
  );
}
function cleanupDiagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function updateOperationalMarker(root: string, markerName: string, identity: string, token: string, childPid?: number): void {
  const markerPath = join(root, markerName);
  const current = readOperationalMarker(markerPath);
  if (!current || current.schema !== "forgedock.verification-output/v1" || current.identity !== identity || current.token !== token) {
    throw new Error(`Verification staging marker changed unexpectedly: ${root}`);
  }
  const next = { schema: current.schema, identity: current.identity, pid: current.pid, token: current.token, ...(childPid === undefined ? {} : { childPid, ...(process.platform === "win32" ? {} : { childPgid: childPid }) }) };
  if (childPid === undefined) delete (next as { childPid?: number; childPgid?: number }).childPid;
  if (childPid === undefined) delete (next as { childPid?: number; childPgid?: number }).childPgid;
  const temporary = join(root, `.${markerName}.update-${randomUUID()}`);
  const descriptor = openSync(temporary, "wx", 0o600);
  try { writeFileSync(descriptor, JSON.stringify(next)); }
  finally { closeSync(descriptor); }
  renameSync(temporary, markerPath);
}
function clearOperationalMarker(root: string, markerName: string, identity: string, token: string, childPid?: number): void {
  const marker = readOperationalMarker(join(root, markerName));
  if (!marker || marker.childPid !== childPid) throw new Error(`Verification staging marker changed unexpectedly: ${root}`);
  if ((marker.childPgid !== undefined && isLiveProcessGroup(marker.childPgid)) || (marker.childPid !== undefined && isLivePid(marker.childPid))) {
    throw new DeferredCleanupError(`Verification staging child is still active: ${root}`);
  }
  updateOperationalMarker(root, markerName, identity, token);
}

function cleanupOperationalOutput(root: string, token: string, markerName: string): void {
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Verification staging root changed unexpectedly: ${root}`);
  const markerPath = join(root, markerName);
  const marker = readOperationalMarker(markerPath);
  if (!marker || marker.schema !== "forgedock.verification-output/v1" || marker.token !== token) throw new Error(`Verification staging marker changed unexpectedly: ${root}`);
  if ((marker.childPgid !== undefined && isLiveProcessGroup(marker.childPgid)) || (marker.childPid !== undefined && isLivePid(marker.childPid))) {
    throw new DeferredCleanupError(`Verification staging child is still active: ${root}`);
  }
  rmSync(root, { recursive: true, force: false });
}

async function emitProgress(
  callback: VerificationProgressCallback | undefined,
  progress: Parameters<VerificationProgressCallback>[0],
): Promise<void> {
  if (!callback) return;
  try { await callback(progress); } catch { /* progress is operational evidence, never command authority */ }
}

async function acquireVerificationLock(path: string, signal?: AbortSignal): Promise<() => void> {
  const token = randomUUID();
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

function validateCommandTargets(spec: VerificationCommand): void {
  if (spec.targeting !== "expected-test-paths") return;
  const workspace = resolvePath(spec.cwd);
  for (const target of spec.targets ?? []) {
    if (!target || target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target)) throw new Error(`Verification target must be workspace-relative: ${target}`);
    const absolute = resolvePath(workspace, target);
    const rel = relative(workspace, absolute);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || rel.split(sep).some((part) => part === "..")) throw new Error(`Verification target escapes workspace: ${target}`);
    let current = workspace;
    for (const component of rel.split(sep).slice(0, -1)) {
      current = join(current, component);
      const parent = tryLstat(current);
      if (!parent) throw new Error(`Verification test target parent does not exist: ${target}`);
      if (parent.isSymbolicLink() || !parent.isDirectory()) throw new Error(`Verification test target path is unsafe: ${target}`);
    }
    const stat = tryLstat(absolute);
    if (!stat) throw new Error(`Verification targeted test does not exist: ${target}`);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Verification targeted test is not a regular file: ${target}`);
  }
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

function runOne(
  spec: VerificationCommand,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  ownership?: { token: string; markerName: string; identity: string; root: string },
): Promise<CheckResult> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    try {
      validateCommandTargets(spec);
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      resolve({
        ...verificationResultMetadata(spec),
        status: "failed",
        failureClass: "infrastructure",
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        outputDigest: createHash("sha256").update(summary).digest("hex"),
        summary,
        failureSignatures: [summary],
      });
      return;
    }
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
    if (ownership && child.pid) {
      try { updateOperationalMarker(ownership.root, ownership.markerName, ownership.identity, ownership.token, child.pid); }
      catch (error) {
        child.once("error", () => { /* close settles the rejected marker publication */ });
        child.once("close", () => reject(error));
        terminateProcessTree(child);
        if (child.exitCode !== null) reject(error);
        return;
      }
    }
    const output = new BoundedOutputCapture();
    const capture = (chunk: Buffer | string) => output.push(chunk);
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
    if (signal?.aborted) abort();
    child.on("error", async (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const quiescent = await waitForProcessTreeQuiescence(child.pid, process.platform === "win32" ? undefined : child.pid);
      let markerCleanupError: unknown;
      if (ownership && quiescent) {
        try { clearOperationalMarker(ownership.root, ownership.markerName, ownership.identity, ownership.token, child.pid); }
        catch (markerError) { markerCleanupError = markerError; }
      }
      if (cancelled) {
        if (markerCleanupError !== undefined) attachCleanupDiagnostic(abortReason, markerCleanupError);
        reject(abortReason);
        return;
      }
      const durationMs = Math.max(0, Math.round(performance.now() - started));
      const errorCode = error.code ?? error.name ?? "spawn-error";
      const baseSummary = `Failed to start verification command (${errorCode})`;
      const summary = markerCleanupError === undefined
        ? baseSummary
        : `${baseSummary}; verification cleanup: ${cleanupDiagnostic(markerCleanupError)}`;
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
    child.on("close", async (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const quiescent = await waitForProcessTreeQuiescence(child.pid, process.platform === "win32" ? undefined : child.pid);
      let markerCleanupError: unknown;
      if (ownership && quiescent) {
        try { clearOperationalMarker(ownership.root, ownership.markerName, ownership.identity, ownership.token, child.pid); }
        catch (markerError) { markerCleanupError = markerError; }
      }
      if (cancelled) {
        if (markerCleanupError !== undefined) attachCleanupDiagnostic(abortReason, markerCleanupError);
        reject(abortReason);
        return;
      }
      const renderedOutput = output.finish();
      const durationMs = Math.max(0, Math.round(performance.now() - started));
      const commandStatus = code === 0 && !timedOut ? "passed" as const : "failed" as const;
      const status = markerCleanupError === undefined ? commandStatus : "failed" as const;
      const summaryBase = summarize(renderedOutput.text, timedOut, commandStatus);
      const summary = markerCleanupError === undefined
        ? summaryBase
        : `${summaryBase ? `${summaryBase}; ` : ""}verification cleanup: ${cleanupDiagnostic(markerCleanupError)}`;
      const failureSignatures = status === "failed"
        ? [...(commandStatus === "failed" ? extractFailureSignatures(renderedOutput.text, timedOut) : []), ...(markerCleanupError === undefined ? [] : [cleanupDiagnostic(markerCleanupError)])]
        : [];
      resolve({
        ...verificationResultMetadata(spec),
        status,
        ...(status === "failed" ? {
          failureClass: markerCleanupError !== undefined
            ? ("infrastructure" as const)
            : (timedOut ? ("timeout" as const) : ("command" as const)),
        } : {}),
        ...(typeof code === "number" ? { exitCode: code } : {}),
        durationMs,
        outputDigest: renderedOutput.digest,
        ...(summary ? { summary } : {}),
        ...(failureSignatures.length ? { failureSignatures } : {}),
      });
    });
  });
}

interface CapturedOutput { text: string; digest: string; truncated: boolean }

/** Drains both pipes while retaining only a redacted, bounded diagnostic tail. */
class BoundedOutputCapture {
  readonly #hash = createHash("sha256");
  #carry = "";
  #tail = "";
  #chunks = 0;
  #truncated = false;

  push(chunk: Buffer | string): void {
    this.#chunks += 1;
    if (this.#chunks > MAX_CAPTURE_CHUNKS) {
      this.#truncated = true;
      return;
    }
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    for (let offset = 0; offset < text.length; offset += 64 * 1024) {
      this.#carry += text.slice(offset, offset + 64 * 1024);
      if (this.#carry.length <= MAX_REDACTION_CARRY_CHARS) continue;
      const safe = this.#carry.slice(0, -MAX_REDACTION_CARRY_CHARS);
      this.#carry = this.#carry.slice(-MAX_REDACTION_CARRY_CHARS);
      this.#emit(safe);
    }
  }

  finish(): CapturedOutput {
    this.#emit(this.#carry);
    this.#carry = "";
    if (this.#truncated) this.#emit(`\n${OUTPUT_TRUNCATION_MARKER}\n`);
    return { text: this.#tail, digest: this.#hash.digest("hex"), truncated: this.#truncated };
  }

  #emit(value: string): void {
    if (!value) return;
    const redacted = redactVerificationOutput(value);
    if (!redacted) return;
    this.#hash.update(redacted);
    this.#tail += redacted;
    const bytes = Buffer.from(this.#tail, "utf8");
    if (bytes.byteLength > MAX_DIAGNOSTIC_BYTES) {
      this.#truncated = true;
      this.#tail = bytes.subarray(-MAX_DIAGNOSTIC_BYTES).toString("utf8");
    }
  }
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
  const truncated = output.includes(OUTPUT_TRUNCATION_MARKER);
  if (timedOut) return truncated ? `Timed out · ${OUTPUT_TRUNCATION_MARKER}` : "Timed out";
  const normalized = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim();
  if (!normalized) return truncated ? OUTPUT_TRUNCATION_MARKER : "";
  const lines = normalized.split(/\r?\n/).filter(Boolean);
  let summary: string;
  if (status === "failed") {
    const firstFailure = lines.findIndex((line) => /^\s*not ok\s+\d+\s+-\s+/.test(line));
    if (firstFailure >= 0) summary = lines.slice(firstFailure, firstFailure + 16).join(" | ").slice(0, 1_500);
    else {
      const nodeFailure = lines.findIndex((line) => /^\s*[✖✕]\s+failing tests:\s*$/i.test(line));
      summary = nodeFailure >= 0 ? lines.slice(nodeFailure, nodeFailure + 16).join(" | ").slice(0, 1_500) : lines.slice(-3).join(" | ").slice(0, 500);
    }
  } else summary = lines.slice(-3).join(" | ").slice(0, 500);
  return truncated ? `${summary} · ${OUTPUT_TRUNCATION_MARKER}` : summary;
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
