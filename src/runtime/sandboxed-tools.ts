// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign } from "node:crypto";
import { constants } from "node:fs";
import { access, glob as fsGlob, lstat, mkdir, open, readFile, readdir, realpath, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import {
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type GrepOperations,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { isConcreteScopePath, type ScopeManifest, type ToolGrant } from "./agent-runtime.js";

/**
 * Replaces Pi's local filesystem tools with worktree-confined operations.
 * Prompt instructions are not a security boundary; every filesystem operation
 * is checked lexically and through real paths to reject absolute/path-traversal
 * and symlink escapes.
 */
/** Test-only synchronization; it supplies no filesystem operation or authorization decision. */
type SandboxMutationTestAdapter = {
  beforeMutation?: (kind: "file" | "directory", candidate: string) => void | Promise<void>;
};

export async function createSandboxedTools(
  cwd: string,
  grants: readonly ToolGrant[],
  scope?: ScopeManifest,
  testAdapter?: SandboxMutationTestAdapter,
): Promise<ToolDefinition[]> {
  const guard = await WorkspaceGuard.create(cwd, scope, testAdapter);
  if (grants.includes("bash")) throw new Error("The Pi adapter does not expose unrestricted bash to workflow roles");
  const tools: ToolDefinition[] = [];
  if (grants.includes("read")) {
    tools.push(createReadTool(cwd, { operations: {
      readFile: async (path) => readFile(await guard.existing(path)),
      access: async (path) => { await access(await guard.existing(path), constants.R_OK); },
    } }) as unknown as ToolDefinition);
  }
  if (grants.includes("grep")) {
    const grep = createGrepTool(cwd, { operations: {
      isDirectory: async (path) => (await stat(await guard.existing(path))).isDirectory(),
      readFile: async (path) => readFile(await guard.existing(path), "utf8"),
      search: createWorkspaceSearch(guard),
    } });
    const execute = grep.execute.bind(grep);
    grep.execute = (async (...args: Parameters<typeof grep.execute>) => {
      const [toolCallId, supplied, signal, onUpdate] = args;
      let params = supplied;
      const scoped = params as typeof params & { path?: string; cwd?: string; searchPath?: string };
      const validatedSearchRoot = await guard.searchRoot(scoped.path ?? scoped.cwd ?? scoped.searchPath);
      params = { ...params, path: validatedSearchRoot };
      if (params.literal !== true) {
        try { new RegExp(params.pattern); }
        catch { params = { ...params, literal: true }; }
      }
      return execute(toolCallId, params, signal, onUpdate);
    }) as typeof grep.execute;
    tools.push(grep as unknown as ToolDefinition);
  }
  if (grants.includes("find")) {
    tools.push(createFindTool(cwd, { operations: {
      exists: async (path) => { try { await guard.existing(path); return true; } catch { return false; } },
      glob: async (pattern, searchCwd, options) => {
        const safeCwd = await guard.existing(searchCwd);
        const results: string[] = [];
        for await (const path of fsGlob(pattern, { cwd: safeCwd, exclude: options.ignore })) {
          if (results.length >= options.limit) break;
          await guard.existing(resolve(safeCwd, path));
          results.push(path);
        }
        return results;
      },
    } }) as unknown as ToolDefinition);
  }
  if (grants.includes("ls")) {
    tools.push(createLsTool(cwd, { operations: {
      exists: async (path) => { try { await guard.existing(path); return true; } catch { return false; } },
      stat: async (path) => stat(await guard.existing(path)),
      readdir: async (path) => readdir(await guard.existing(path)),
    } }) as unknown as ToolDefinition);
  }
  if (grants.includes("compute")) tools.push(createDeterministicComputeTool());
  if (grants.includes("edit")) {
    tools.push(createEditTool(cwd, { operations: {
      readFile: async (path) => readFile(await guard.existing(path)),
      writeFile: async (path, content) => guard.writeFile(path, content),
      access: async (path) => { await access(await guard.existing(path), constants.R_OK | constants.W_OK); },
    } }) as unknown as ToolDefinition);
  }
  if (grants.includes("write")) {
    tools.push(createWriteTool(cwd, { operations: {
      writeFile: async (path, content) => guard.writeFile(path, content),
      mkdir: async (path) => guard.makeDirectory(path),
    } }) as unknown as ToolDefinition);
  }
  return tools;
}

type WorkspaceSearch = NonNullable<GrepOperations["search"]>;
type WorkspaceSearchResult = Awaited<ReturnType<WorkspaceSearch>>;

interface IgnoreRule {
  base: string;
  pattern: string;
  negated: boolean;
  directoryOnly: boolean;
  basenameOnly: boolean;
}

/** Portable grep backend for confined agents; Pi's ordinary local tool still uses ripgrep. */
function createWorkspaceSearch(guard: WorkspaceGuard): WorkspaceSearch {
  return async ({ pattern, path: requestedPath, glob, ignoreCase, literal, maxResults, signal }) => {
    const searchRoot = await guard.existing(requestedPath);
    const rootStats = await stat(searchRoot);
    const matches: WorkspaceSearchResult["matches"] = [];
    const lineMatches = createLineMatcher(pattern, literal, ignoreCase);
    let truncated = false;

    const throwIfAborted = () => {
      if (signal?.aborted) throw new Error("Operation aborted");
    };

    const searchFile = async (safePath: string, relativePath: string, reportedPath: string): Promise<void> => {
      throwIfAborted();
      if (glob && !matchesGlob(relativePath, glob)) return;

      let content: string;
      try {
        content = await readFile(await guard.existing(safePath), "utf8");
      } catch {
        return;
      }
      // Match ripgrep's default binary-file behavior for the common NUL-byte case.
      if (content.includes("\0")) return;

      const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const lines = normalized.split("\n");
      if (normalized.endsWith("\n")) lines.pop();
      for (let index = 0; index < lines.length; index++) {
        throwIfAborted();
        const line = lines[index] ?? "";
        if (!lineMatches(line)) continue;
        if (matches.length >= maxResults) {
          truncated = true;
          return;
        }
        matches.push({ filePath: reportedPath, lineNumber: index + 1, lineText: line });
      }
    };

    const walk = async (safeDirectory: string, relativeDirectory: string, inherited: readonly IgnoreRule[]) => {
      throwIfAborted();
      const rules = await readIgnoreRules(guard, safeDirectory, inherited);
      let entries;
      try {
        entries = await readdir(safeDirectory, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));

      for (const entry of entries) {
        throwIfAborted();
        if (truncated) return;
        if (entry.name === ".git" || entry.name === "node_modules" || entry.isSymbolicLink()) continue;

        const candidate = resolve(safeDirectory, entry.name);
        let safeCandidate: string;
        try {
          safeCandidate = await guard.existing(candidate);
        } catch {
          // A raced symlink or other escape is never followed.
          continue;
        }
        const relativePath = toPosixPath(relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name);
        if (isIgnored(safeCandidate, entry.isDirectory(), rules)) continue;

        if (entry.isDirectory()) {
          await walk(safeCandidate, relativePath, rules);
        } else if (entry.isFile()) {
          await searchFile(safeCandidate, relativePath, resolve(requestedPath, ...relativePath.split("/")));
        }
      }
    };

    throwIfAborted();
    if (rootStats.isDirectory()) {
      await walk(searchRoot, "", await readAncestorIgnoreRules(guard, searchRoot));
    } else if (rootStats.isFile()) {
      const relativePath = toPosixPath(requestedPath).split("/").pop() ?? requestedPath;
      await searchFile(searchRoot, relativePath, requestedPath);
    }
    throwIfAborted();
    return { matches, truncated };
  };
}

async function readAncestorIgnoreRules(guard: WorkspaceGuard, directory: string): Promise<readonly IgnoreRule[]> {
  const relativeDirectory = relative(guard.root, directory);
  if (!relativeDirectory) return [];
  let current = guard.root;
  let rules: readonly IgnoreRule[] = [];
  for (const segment of relativeDirectory.split(sep)) {
    rules = await readIgnoreRules(guard, current, rules);
    current = resolve(current, segment);
  }
  return rules;
}

function createLineMatcher(pattern: string, literal: boolean, ignoreCase: boolean): (line: string) => boolean {
  if (literal) {
    const needle = ignoreCase ? pattern.toLocaleLowerCase() : pattern;
    return (line) => (ignoreCase ? line.toLocaleLowerCase() : line).includes(needle);
  }
  const expression = new RegExp(pattern, ignoreCase ? "i" : undefined);
  return (line) => expression.test(line);
}

function matchesGlob(relativePath: string, rawPattern: string): boolean {
  const path = toPosixPath(relativePath);
  let pattern = toPosixPath(rawPattern);
  const negated = pattern.startsWith("!");
  if (negated) pattern = pattern.slice(1);
  pattern = pattern.replace(/^\.\//, "").replace(/^\//, "");
  const subject = pattern.includes("/") ? path : posix.basename(path);
  const matched = posix.matchesGlob(subject, pattern);
  return negated ? !matched : matched;
}

async function readIgnoreRules(
  guard: WorkspaceGuard,
  directory: string,
  inherited: readonly IgnoreRule[],
): Promise<readonly IgnoreRule[]> {
  let source: string;
  try {
    source = await readFile(await guard.existing(resolve(directory, ".gitignore")), "utf8");
  } catch {
    return inherited;
  }

  const local: IgnoreRule[] = [];
  for (const rawLine of source.replace(/\r/g, "").split("\n")) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1);
    }
    line = line.replace(/^\\([#!])/, "$1");
    const directoryOnly = line.endsWith("/");
    if (directoryOnly) line = line.slice(0, -1);
    const anchored = line.startsWith("/");
    if (anchored) line = line.slice(1);
    if (!line) continue;
    local.push({
      base: directory,
      pattern: toPosixPath(line),
      negated,
      directoryOnly,
      basenameOnly: !anchored && !line.includes("/"),
    });
  }
  return local.length === 0 ? inherited : [...inherited, ...local];
}

function isIgnored(candidate: string, isDirectory: boolean, rules: readonly IgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.directoryOnly && !isDirectory) continue;
    const relativePath = toPosixPath(relative(rule.base, candidate));
    if (!relativePath || relativePath === ".." || relativePath.startsWith("../")) continue;
    const subject = rule.basenameOnly ? posix.basename(relativePath) : relativePath;
    if (posix.matchesGlob(subject, rule.pattern)) ignored = !rule.negated;
  }
  return ignored;
}

function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

const ComputeSchema = Type.Object({
  operation: Type.Union([
    Type.Literal("sha256"), Type.Literal("base64url_encode"), Type.Literal("jcs"), Type.Literal("ed25519_sign"),
  ]),
  data: Type.Optional(Type.String({ maxLength: 1_000_000 })),
  encoding: Type.Optional(Type.Union([
    Type.Literal("utf8"), Type.Literal("hex"), Type.Literal("base64"), Type.Literal("base64url"),
  ])),
  seedHex: Type.Optional(Type.String({ pattern: "^[0-9a-fA-F]{64}$" })),
  value: Type.Optional(Type.Unknown()),
});
type ComputeInput = Static<typeof ComputeSchema>;

/** Pure bounded computation for builders; no process, network, environment, or filesystem authority. */
export function createDeterministicComputeTool(): ToolDefinition {
  return {
    name: "compute",
    label: "compute",
    description: "Perform side-effect-free SHA-256, base64url, canonical JSON (JCS-compatible JSON domain), or Ed25519 test-vector signing. This tool cannot access files, processes, environment variables, Git, or the network.",
    promptSnippet: "Perform bounded deterministic cryptographic/encoding computations without shell access",
    parameters: ComputeSchema,
    async execute(_toolCallId, input: ComputeInput, signal?: AbortSignal) {
      if (signal?.aborted) throw signal.reason ?? new Error("Computation aborted");
      let output: Record<string, unknown>;
      if (input.operation === "jcs") {
        if (input.value === undefined) throw new Error("jcs requires value");
        const canonical = canonicalJson(input.value);
        output = { canonical, utf8Hex: Buffer.from(canonical, "utf8").toString("hex") };
      } else {
        if (input.data === undefined) throw new Error(`${input.operation} requires data`);
        const bytes = decodeComputeData(input.data, input.encoding ?? "utf8");
        if (input.operation === "sha256") {
          const digest = createHash("sha256").update(bytes).digest();
          output = { hex: digest.toString("hex"), base64url: digest.toString("base64url") };
        } else if (input.operation === "base64url_encode") {
          output = { base64url: bytes.toString("base64url"), byteLength: bytes.length };
        } else {
          if (!input.seedHex) throw new Error("ed25519_sign requires a 32-byte seedHex");
          const seed = Buffer.from(input.seedHex, "hex");
          const privateDer = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
          const privateKey = createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" });
          const publicDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
          const signature = cryptoSign(null, bytes, privateKey);
          output = {
            publicKeyHex: publicDer.subarray(-32).toString("hex"),
            signatureHex: signature.toString("hex"),
            signatureBase64url: signature.toString("base64url"),
            messageByteLength: bytes.length,
          };
        }
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(output) }], details: output };
    },
  } as ToolDefinition;
}

function decodeComputeData(data: string, encoding: "utf8" | "hex" | "base64" | "base64url"): Buffer {
  if (encoding === "hex" && (data.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(data))) throw new Error("Invalid hexadecimal data");
  return Buffer.from(data, encoding);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON does not support non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error(`Canonical JSON does not support ${typeof value}`);
}

export class WorkspaceGuard {
  private constructor(
    readonly root: string,
    private readonly readRoots: readonly string[],
    private readonly writeRoots: readonly string[],
    private readonly writePaths: readonly string[],
    private readonly testAdapter?: SandboxMutationTestAdapter,
  ) {}

  static async create(cwd: string, scope?: ScopeManifest, testAdapter?: SandboxMutationTestAdapter): Promise<WorkspaceGuard> {
    const root = await realpath(resolve(cwd));
    const readRoots = await resolveScopeRoots(root, scope?.readRoots ?? ["."], false);
    const writeRoots = await resolveScopeRoots(root, scope ? scope.writeRoots : ["."], true);
    const writePaths = await resolveScopePaths(root, scope?.writePaths ?? []);
    if (!readRoots.length) throw new Error("Scope manifest contains no existing read roots");
    return new WorkspaceGuard(root, readRoots, writeRoots, writePaths, testAdapter);
  }

  async existing(path: string): Promise<string> {
    const candidate = this.lexical(path);
    const resolved = await realpath(candidate);
    this.assertInside(resolved);
    this.assertAllowed(resolved, this.readRoots, "read");
    return resolved;
  }

  /**
   * Validate and open the file itself. Callers must close the returned handle;
   * the handle, rather than the lexical name, is the authority used for the write.
   */
  async writable(path: string): Promise<FileHandle> {
    const candidate = this.lexical(path);
    if (candidate === this.root) throw new Error(`Workspace path has no writable file parent: ${path}`);
    await this.assertWritableCandidate(candidate);
    await this.beforeMutation("file", candidate);
    return this.openWritableFile(candidate);
  }

  /**
   * Validate, open, and if necessary create a directory one component at a
   * time. The returned handle is bound to the final directory and must be
   * closed by the caller.
   */
  async writableDirectory(path: string): Promise<FileHandle> {
    const candidate = this.lexical(path);
    if (this.writePaths.length) {
      if (!this.writePaths.some((writePath) => samePathOrUnder(candidate, writePath))) {
        throw new Error(`Tool write directory is outside the assigned scope: ${candidate}`);
      }
      const nearest = await existingOrNearest(candidate);
      this.assertInside(nearest);
    } else {
      await this.assertWritableCandidate(candidate);
    }
    await this.beforeMutation("directory", candidate);
    const directory = await this.openDirectory(candidate, true);
    return directory.handle;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const handle = await this.writable(path);
    try {
      await handle.truncate(0);
      await handle.writeFile(content, "utf8");
    } finally {
      await closeFileHandle(handle);
    }
  }

  async makeDirectory(path: string): Promise<void> {
    const handle = await this.writableDirectory(path);
    await closeFileHandle(handle);
  }

  async searchRoot(path: string | undefined): Promise<string> {
    return this.existing(path ?? ".");
  }

  private async beforeMutation(kind: "file" | "directory", candidate: string): Promise<void> {
    await this.testAdapter?.beforeMutation?.(kind, candidate);
  }

  private async assertWritableCandidate(candidate: string): Promise<void> {
    if (this.writePaths.length) this.assertExactlyAllowed(candidate);
    const nearest = await existingOrNearest(candidate);
    this.assertInside(nearest);
    if (!this.writePaths.length) {
      this.assertAllowed(nearest, this.writeRoots, "write");
      this.assertAllowed(candidate, this.writeRoots, "write");
    }
  }

  private async openWritableFile(candidate: string): Promise<FileHandle> {
    const parent = await this.openDirectory(dirname(candidate), false);
    let handle: FileHandle | undefined;
    try {
      const target = join(parent.operationPath, basename(candidate));
      await rejectSymbolicLink(target);
      handle = await open(target, writableFileFlags(), 0o666);
      const targetStats = await handle.stat();
      if (!targetStats.isFile()) throw new Error(`Tool write target is not a regular file: ${candidate}`);
      return handle;
    } catch (error) {
      if (handle) await closeFileHandle(handle);
      throw error;
    } finally {
      await closeFileHandle(parent.handle);
    }
  }

  private async openDirectory(candidate: string, createMissing: boolean): Promise<SafeDirectory> {
    const segments = relative(this.root, candidate) ? relative(this.root, candidate).split(sep) : [];
    let current: SafeDirectory = {
      handle: await openDirectoryHandle(this.root),
      operationPath: this.root,
    };
    current.operationPath = directoryHandlePath(current.handle, current.operationPath);
    let currentLexical = this.root;
    try {
      for (const segment of segments) {
        const lexicalChild = resolve(currentLexical, segment);
        const operationChild = join(current.operationPath, segment);
        let next: FileHandle;
        try {
          next = await openDirectoryHandle(operationChild);
        } catch (error) {
          if (!createMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          try {
            await mkdir(operationChild, { recursive: false });
          } catch (mkdirError) {
            if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
          }
          next = await openDirectoryHandle(operationChild);
        }
        await closeFileHandle(current.handle);
        current = {
          handle: next,
          operationPath: directoryHandlePath(next, lexicalChild),
        };
        currentLexical = lexicalChild;
      }
      return current;
    } catch (error) {
      await closeFileHandle(current.handle);
      throw error;
    }
  }

  private lexical(path: string): string {
    const candidate = resolve(this.root, path);
    this.assertInside(candidate);
    return candidate;
  }

  private assertAllowed(candidate: string, roots: readonly string[], operation: string): void {
    if (roots.some((root) => samePathOrUnder(root, candidate))) return;
    throw new Error(`Tool ${operation} path is outside the assigned scope: ${candidate}`);
  }

  private assertExactlyAllowed(candidate: string): void {
    if (this.writePaths.some((path) => samePathOrUnder(path, candidate) && samePathOrUnder(candidate, path))) return;
    throw new Error(`Tool write path is outside the assigned scope: ${candidate}`);
  }

  private assertInside(candidate: string): void {
    const rel = relative(this.root, candidate);
    if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return;
    throw new Error(`Tool path escapes the assigned workspace: ${candidate}`);
  }
}

type SafeDirectory = {
  handle: FileHandle;
  operationPath: string;
};

function writableFileFlags(): number {
  return constants.O_WRONLY
    | constants.O_CREAT
    | (constants.O_NOFOLLOW ?? 0)
    | (constants.O_NONBLOCK ?? 0);
}

function directoryFlags(): number {
  return constants.O_RDONLY
    | (constants.O_DIRECTORY ?? 0)
    | (constants.O_NOFOLLOW ?? 0);
}

async function openDirectoryHandle(path: string): Promise<FileHandle> {
  await rejectSymbolicLink(path);
  const handle = await open(path, directoryFlags());
  try {
    if (!(await handle.stat()).isDirectory()) throw new Error(`Tool write path is not a directory: ${path}`);
    return handle;
  } catch (error) {
    await closeFileHandle(handle);
    throw error;
  }
}

async function rejectSymbolicLink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new Error(`Tool path escapes the assigned workspace through a symbolic link: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function directoryHandlePath(handle: FileHandle, fallback: string): string {
  const prefix = process.platform === "linux" ? "/proc/self/fd"
    : ["aix", "darwin", "freebsd", "openbsd"].includes(process.platform) ? "/dev/fd"
      : undefined;
  return prefix ? `${prefix}/${handle.fd}` : fallback;
}

async function closeFileHandle(handle: FileHandle): Promise<void> {
  try { await handle.close(); }
  catch { /* Preserve the operation's result; the handle is no longer usable. */ }
}

async function resolveScopeRoots(root: string, roots: readonly string[], allowMissing: boolean): Promise<string[]> {
  const resolved: string[] = [];
  for (const value of roots) {
    const lexical = resolve(root, value);
    let candidate: string;
    try {
      candidate = await realpath(lexical);
    } catch (error) {
      if (!allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      candidate = await existingOrNearest(lexical);
    }
    const rel = relative(root, candidate);
    if (rel !== "" && (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
      throw new Error(`Scope root escapes the assigned workspace: ${value}`);
    }
    resolved.push(candidate);
  }
  return [...new Set(resolved)];
}

async function resolveScopePaths(root: string, paths: readonly string[]): Promise<string[]> {
  const resolved: string[] = [];
  for (const value of paths) {
    if (!isConcreteScopePath(value)) {
      throw new Error(`Scope write paths must be concrete repository-relative files: ${value}`);
    }
    const lexical = resolve(root, value);
    try {
      const existing = await realpath(lexical);
      assertInsideResolved(root, existing, value);
      resolved.push(existing);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = await existingOrNearest(dirname(lexical));
    assertInsideResolved(root, parent, value);
    resolved.push(lexical);
  }
  return [...new Set(resolved)];
}

function assertInsideResolved(root: string, candidate: string, value: string): void {
  const rel = relative(root, candidate);
  if (rel !== "" && (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
    throw new Error(`Scope path escapes the assigned workspace: ${value}`);
  }
}

async function existingOrNearest(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return existingOrNearest(parent);
  }
}

function samePathOrUnder(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
