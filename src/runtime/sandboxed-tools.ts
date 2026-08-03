// SPDX-License-Identifier: AGPL-3.0-or-later

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
import type { ToolGrant } from "./agent-runtime.js";

/**
 * Replaces Pi's local filesystem tools with worktree-confined operations.
 * Prompt instructions are not a security boundary; every filesystem operation
 * is checked lexically and through real paths to reject absolute/path-traversal
 * and symlink escapes.
 */
export async function createSandboxedTools(cwd: string, grants: readonly ToolGrant[]): Promise<ToolDefinition[]> {
  const guard = await WorkspaceGuard.create(cwd);
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

export class WorkspaceGuard {
  private constructor(readonly root: string) {}

  static async create(cwd: string): Promise<WorkspaceGuard> {
    return new WorkspaceGuard(await realpath(resolve(cwd)));
  }

  async existing(path: string): Promise<string> {
    const candidate = this.lexical(path);
    const resolved = await realpath(candidate);
    this.assertInside(resolved);
    return resolved;
  }

  async writable(path: string): Promise<string> {
    const candidate = this.lexical(path);
    let parent = dirname(candidate);
    while (parent !== dirname(parent)) {
      try {
        const resolvedParent = await realpath(parent);
        this.assertInside(resolvedParent);
        return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        parent = dirname(parent);
      }
    }
    throw new Error(`Workspace path has no parent inside the worktree: ${path}`);
  }

  private lexical(path: string): string {
    const candidate = resolve(this.root, path);
    this.assertInside(candidate);
    return candidate;
  }

  private assertInside(candidate: string): void {
    const rel = relative(this.root, candidate);
    if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return;
    throw new Error(`Tool path escapes the assigned workspace: ${candidate}`);
  }
}
