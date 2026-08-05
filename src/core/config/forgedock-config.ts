// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const START = "# FORGEDOCK:NEXT-CONFIG:START";
const END = "# FORGEDOCK:NEXT-CONFIG:END";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const DEFAULT_AUTO_MERGE = true;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ForgeDockNextConfig {
  workerModel?: string;
  workerThinking?: ThinkingLevel;
  reviewerModel?: string;
  reviewerThinking?: ThinkingLevel;
  maxReviewSpecialists?: number;
  maxParallel?: number;
  autoMerge?: boolean;
}

export function readForgeDockConfig(cwd: string): ForgeDockNextConfig {
  const path = join(cwd, "forge.yaml");
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  const managed = managedBlock(raw);
  if (!managed) return {};
  const value = (key: string) => new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "m").exec(managed)?.[1];
  return compact({
    workerModel: parseString(value("worker_model")),
    workerThinking: parseThinking(value("worker_thinking")),
    reviewerModel: parseString(value("reviewer_model")),
    reviewerThinking: parseThinking(value("reviewer_thinking")),
    maxReviewSpecialists: parsePositiveInteger(value("max_review_specialists")),
    maxParallel: parsePositiveInteger(value("max_parallel")),
    autoMerge: parseBoolean(value("auto_merge")),
  }) as ForgeDockNextConfig;
}

export function ensureForgeDockConfig(cwd: string): { path: string; created: boolean } {
  const path = join(cwd, "forge.yaml");
  if (existsSync(path)) return { path, created: false };
  writeConfigAtomically(path, `# forge.yaml — ForgeDock project configuration\n\n${renderManagedBlock({})}\n`);
  return { path, created: true };
}

export function updateForgeDockConfig(cwd: string, patch: ForgeDockNextConfig): { path: string; config: ForgeDockNextConfig } {
  validatePatch(patch);
  const path = join(cwd, "forge.yaml");
  const current = readForgeDockConfig(cwd);
  const config = compact({ ...current, ...patch });
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "# forge.yaml — ForgeDock project configuration\n";
  const rendered = renderManagedBlock(config);
  const start = existing.indexOf(START);
  const end = existing.indexOf(END);
  let next: string;
  if (start >= 0 || end >= 0) {
    if (start < 0 || end < start) throw new Error("forge.yaml contains an incomplete ForgeDock Next managed block");
    next = `${existing.slice(0, start)}${rendered}${existing.slice(end + END.length)}`;
  } else {
    next = `${existing.trimEnd()}\n\n${rendered}\n`;
  }
  writeConfigAtomically(path, next);
  return { path, config };
}

export function resolveAutoMerge(requested: boolean | undefined, configured: boolean | undefined): boolean {
  return requested ?? configured ?? DEFAULT_AUTO_MERGE;
}

export function splitConfiguredModel(value: string | undefined): { provider: string; model: string } | undefined {
  if (!value) return undefined;
  const slash = value.indexOf("/");
  if (slash < 1 || slash === value.length - 1) return undefined;
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

export function modelWithThinking(model: string | undefined, thinking: ThinkingLevel | undefined): string | undefined {
  if (!model || !thinking) return model;
  return `${model.replace(/:(?:off|minimal|low|medium|high|xhigh|max)$/, "")}:${thinking}`;
}

function managedBlock(raw: string): string | undefined {
  const start = raw.indexOf(START);
  if (start < 0) return undefined;
  const end = raw.indexOf(END, start + START.length);
  if (end < 0) throw new Error("forge.yaml contains an incomplete ForgeDock Next managed block");
  return raw.slice(start + START.length, end);
}

function renderManagedBlock(config: ForgeDockNextConfig): string {
  const hasAgents = config.workerModel !== undefined || config.workerThinking !== undefined
    || config.reviewerModel !== undefined || config.reviewerThinking !== undefined || config.maxReviewSpecialists !== undefined;
  const hasOrchestration = config.maxParallel !== undefined || config.autoMerge !== undefined;
  const lines = [START, "next:", hasAgents ? "  agents:" : "  agents: {}"];
  if (config.workerModel !== undefined) lines.push(`    worker_model: ${JSON.stringify(config.workerModel)}`);
  if (config.workerThinking !== undefined) lines.push(`    worker_thinking: ${JSON.stringify(config.workerThinking)}`);
  if (config.reviewerModel !== undefined) lines.push(`    reviewer_model: ${JSON.stringify(config.reviewerModel)}`);
  if (config.reviewerThinking !== undefined) lines.push(`    reviewer_thinking: ${JSON.stringify(config.reviewerThinking)}`);
  if (config.maxReviewSpecialists !== undefined) lines.push(`    max_review_specialists: ${config.maxReviewSpecialists}`);
  lines.push(hasOrchestration ? "  orchestration:" : "  orchestration: {}");
  if (config.maxParallel !== undefined) lines.push(`    max_parallel: ${config.maxParallel}`);
  if (config.autoMerge !== undefined) lines.push(`    auto_merge: ${config.autoMerge}`);
  lines.push(END);
  return lines.join("\n");
}

function validatePatch(patch: ForgeDockNextConfig): void {
  if (!Object.values(patch).some((value) => value !== undefined)) throw new Error("At least one ForgeDock setting is required");
  for (const model of [patch.workerModel, patch.reviewerModel]) {
    if (model !== undefined && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._@:/-]+$/.test(model)) {
      throw new Error(`Model must use provider/model form: ${model}`);
    }
  }
  for (const thinking of [patch.workerThinking, patch.reviewerThinking]) {
    if (thinking !== undefined && !THINKING_LEVELS.includes(thinking)) throw new Error(`Unsupported thinking level: ${thinking}`);
  }
  if (patch.maxReviewSpecialists !== undefined && (!Number.isInteger(patch.maxReviewSpecialists) || patch.maxReviewSpecialists < 1 || patch.maxReviewSpecialists > 6)) {
    throw new Error("maxReviewSpecialists must be an integer from 1 to 6");
  }
  if (patch.maxParallel !== undefined && (!Number.isInteger(patch.maxParallel) || patch.maxParallel < 1 || patch.maxParallel > 20)) {
    throw new Error("maxParallel must be an integer from 1 to 20");
  }
}

function parseString(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return value.replace(/^['"]|['"]$/g, "").trim() || undefined;
  }
}

function parseThinking(value: string | undefined): ThinkingLevel | undefined {
  const parsed = parseString(value);
  return THINKING_LEVELS.find((level) => level === parsed);
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function writeConfigAtomically(path: string, content: string): void {
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
