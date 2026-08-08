// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign } from "node:crypto";
import { constants } from "node:fs";
import { access, glob as fsGlob, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
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
export async function createSandboxedTools(cwd: string, grants: readonly ToolGrant[], scope?: ScopeManifest): Promise<ToolDefinition[]> {
  const guard = await WorkspaceGuard.create(cwd, scope);
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
    } });
    const execute = grep.execute.bind(grep);
    grep.execute = (async (...args: Parameters<typeof grep.execute>) => {
      const [toolCallId, supplied, signal, onUpdate] = args;
      let params = supplied;
      const scoped = params as typeof params & { path?: string; cwd?: string; searchPath?: string };
      await guard.searchRoot(scoped.path ?? scoped.cwd ?? scoped.searchPath);
      if (params.literal === undefined) {
        params = { ...params, literal: true };
      } else if (params.literal === false) {
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
      writeFile: async (path, content) => writeFile(await guard.writable(path), content, "utf8"),
      access: async (path) => { await access(await guard.existing(path), constants.R_OK | constants.W_OK); },
    } }) as unknown as ToolDefinition);
  }
  if (grants.includes("write")) {
    tools.push(createWriteTool(cwd, { operations: {
      writeFile: async (path, content) => writeFile(await guard.writable(path), content, "utf8"),
      mkdir: async (path) => mkdir(await guard.writable(path), { recursive: true }).then(() => undefined),
    } }) as unknown as ToolDefinition);
  }
  return tools;
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
  ) {}

  static async create(cwd: string, scope?: ScopeManifest): Promise<WorkspaceGuard> {
    const root = await realpath(resolve(cwd));
    const readRoots = await resolveScopeRoots(root, scope?.readRoots ?? ["."], false);
    const writeRoots = await resolveScopeRoots(root, scope ? scope.writeRoots : ["."], true);
    const writePaths = await resolveScopePaths(root, scope?.writePaths ?? []);
    if (!readRoots.length) throw new Error("Scope manifest contains no existing read roots");
    return new WorkspaceGuard(root, readRoots, writeRoots, writePaths);
  }

  async existing(path: string): Promise<string> {
    const candidate = this.lexical(path);
    const resolved = await realpath(candidate);
    this.assertInside(resolved);
    this.assertAllowed(resolved, this.readRoots, "read");
    return resolved;
  }

  async writable(path: string): Promise<string> {
    const candidate = this.lexical(path);
    if (this.writePaths.length) this.assertExactlyAllowed(candidate);
    let parent = dirname(candidate);
    while (parent !== dirname(parent)) {
      try {
        const resolvedParent = await realpath(parent);
        this.assertInside(resolvedParent);
        if (!this.writePaths.length) this.assertAllowed(resolvedParent, this.writeRoots, "write");
        try {
          const resolvedCandidate = await realpath(candidate);
          this.assertInside(resolvedCandidate);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (!this.writePaths.length) this.assertAllowed(candidate, this.writeRoots, "write");
        return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        parent = dirname(parent);
      }
    }
    throw new Error(`Workspace path has no parent inside the worktree: ${path}`);
  }

  async searchRoot(path: string | undefined): Promise<string> {
    return this.existing(path ?? ".");
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
