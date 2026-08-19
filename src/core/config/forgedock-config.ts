// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const START = "# FORGEDOCK:NEXT-CONFIG:START";
const END = "# FORGEDOCK:NEXT-CONFIG:END";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const DEFAULT_AUTO_MERGE = true;
export const DEFAULT_REVIEW_CI = { failureAction: "ask" as const, maxFixAttempts: 2, deliveryChecks: ["*"] as readonly string[], promotionChecks: ["*"] as readonly string[], deploymentChecks: ["*"] as readonly string[], repairPaths: [] as readonly string[] };
export const DEFAULT_ORCHESTRATION = {
  batchingPolicy: "none" as const,
  maxBatchSize: 8,
  maxSensitiveBatchSize: 3,
  scopeExpansion: "scope-locked" as const,
  maxRemediationCycles: 2,
  maxRemediationDepth: 2,
  maxRemediationChildren: 8,
  maxParallel: 4,
  autoMerge: DEFAULT_AUTO_MERGE,
  dispatchMode: "preview" as const,
};
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type BatchingPolicy = "aggressive" | "conservative" | "none";
export type ScopeExpansion = "scope-locked" | "recursive";
export type OrchestrationDispatchMode = "preview" | "confirm" | "auto";
export type ReviewCiFailureAction = "ask" | "auto-fix";
export interface ForgeDockReviewCiPatch { failureAction?: ReviewCiFailureAction; maxFixAttempts?: number; deliveryChecks?: readonly string[]; promotionChecks?: readonly string[]; deploymentChecks?: readonly string[]; repairPaths?: readonly string[]; }
export interface ForgeDockReviewPatch { ci?: ForgeDockReviewCiPatch; }

export interface ForgeDockOrchestrationPatch {
  batching?: { policy?: BatchingPolicy; maxBatchSize?: number; maxSensitiveBatchSize?: number };
  scopeExpansion?: ScopeExpansion;
  maxRemediationCycles?: number;
  maxRemediationDepth?: number;
  maxRemediationChildren?: number;
  maxParallel?: number;
  autoMerge?: boolean;
  /** Explicit fast-lane target; absent means the repository default branch. */
  fastLaneTarget?: string;
  /** Feature/milestone branches are promoted into this integration lane. */
  featurePromotionTarget?: string;
  /** Protected production/promotion target for this repository. */
  productionTarget?: string;
  /** Default orchestration dispatch policy. */
  dispatchMode?: OrchestrationDispatchMode;
}

export interface ForgeDockNextConfig {
  workerModel?: string;
  workerThinking?: ThinkingLevel;
  reviewerModel?: string;
  reviewerThinking?: ThinkingLevel;
  planningModel?: string;
  planningThinking?: ThinkingLevel;
  maxReviewSpecialists?: number;
  /** Flat resolved fields are used by controllers; YAML is rendered nested. */
  batchingPolicy?: BatchingPolicy;
  maxBatchSize?: number;
  maxSensitiveBatchSize?: number;
  scopeExpansion?: ScopeExpansion;
  maxRemediationCycles?: number;
  maxRemediationDepth?: number;
  maxRemediationChildren?: number;
  maxParallel?: number;
  autoMerge?: boolean;
  /** Explicit fast-lane target; absent means the repository default branch. */
  fastLaneTarget?: string;
  /** Feature/milestone branches are promoted into this integration lane. */
  featurePromotionTarget?: string;
  /** Protected production/promotion target for this repository. */
  productionTarget?: string;
  /** Default orchestration dispatch policy. */
  dispatchMode?: OrchestrationDispatchMode;
  orchestration?: ForgeDockOrchestrationPatch;
  reviewCiFailureAction?: ReviewCiFailureAction;
  reviewCiMaxFixAttempts?: number;
  reviewCiDeliveryChecks?: readonly string[];
  reviewCiPromotionChecks?: readonly string[];
  reviewCiDeploymentChecks?: readonly string[];
  reviewCiRepairPaths?: readonly string[];
  review?: ForgeDockReviewPatch;
}
export interface EffectiveReviewCiConfig { failureAction: ReviewCiFailureAction; maxFixAttempts: number; deliveryChecks: readonly string[]; promotionChecks: readonly string[]; deploymentChecks: readonly string[]; repairPaths: readonly string[]; }

export type OrchestrationConfigSource = "invocation" | "forge.yaml" | "default";

export interface EffectiveOrchestrationConfig {
  batchingPolicy: BatchingPolicy;
  maxBatchSize: number;
  maxSensitiveBatchSize: number;
  scopeExpansion: ScopeExpansion;
  maxRemediationCycles: number;
  maxRemediationDepth: number;
  maxRemediationChildren: number;
  maxParallel: number;
  autoMerge: boolean;
  fastLaneTarget?: string;
  featurePromotionTarget?: string;
  productionTarget?: string;
  dispatchMode: OrchestrationDispatchMode;
}

export function readForgeDockConfig(cwd: string): ForgeDockNextConfig {
  const path = join(cwd, "forge.yaml");
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  const managed = managedBlock(raw);
  if (!managed) return {};
  const value = (key: string) => new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "m").exec(managed)?.[1];
  const parsed = <T>(key: string, parser: (raw: string) => T | undefined): T | undefined => {
    const raw = value(key);
    if (raw === undefined) return undefined;
    const result = parser(raw);
    if (result === undefined) throw new Error(`Invalid ForgeDock setting ${key}: ${raw}`);
    return result;
  };
  const config = compact({
    workerModel: parsed("worker_model", parseString),
    workerThinking: parsed("worker_thinking", parseThinking),
    reviewerModel: parsed("reviewer_model", parseString),
    reviewerThinking: parsed("reviewer_thinking", parseThinking),
    planningModel: parsed("planning_model", parseString),
    planningThinking: parsed("planning_thinking", parseThinking),
    maxReviewSpecialists: parsed("max_review_specialists", parsePositiveInteger),
    batchingPolicy: parsed("policy", parseBatchingPolicy),
    maxBatchSize: parsed("max_batch_size", parsePositiveInteger),
    maxSensitiveBatchSize: parsed("max_sensitive_batch_size", parsePositiveInteger),
    scopeExpansion: parsed("scope_expansion", parseScopeExpansion),
    maxRemediationCycles: parsed("max_remediation_cycles", parsePositiveInteger),
    maxRemediationDepth: parsed("max_remediation_depth", parseNonNegativeInteger),
    maxRemediationChildren: parsed("max_remediation_children", parsePositiveInteger),
    maxParallel: parsed("max_parallel", parsePositiveInteger),
    autoMerge: parsed("auto_merge", parseBoolean),
    fastLaneTarget: parsed("fast_lane_target", parseString),
    featurePromotionTarget: parsed("feature_promotion_target", parseString),
    productionTarget: parsed("production_target", parseString),
    dispatchMode: parsed("dispatch_mode", parseDispatchMode),
    reviewCiFailureAction: parsed("failure_action", parseReviewCiFailureAction),
    reviewCiMaxFixAttempts: parsed("max_fix_attempts", parsePositiveInteger),
    reviewCiDeliveryChecks: parsed("delivery_checks", parseStringArray),
    reviewCiPromotionChecks: parsed("promotion_checks", parseStringArray),
    reviewCiDeploymentChecks: parsed("deployment_checks", parseStringArray),
    reviewCiRepairPaths: parsed("repair_paths", parseStringArray),
  }) as ForgeDockNextConfig;
  validatePatch(config, false);
  return config;
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
  const normalizedPatch = flattenReviewPatch(flattenOrchestrationPatch(patch));
  const config = compact({ ...current, ...normalizedPatch });
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
export function resolveReviewCiConfig(configured: ForgeDockNextConfig = {}): EffectiveReviewCiConfig { const flat = flattenReviewPatch(configured); const result = { failureAction: flat.reviewCiFailureAction ?? DEFAULT_REVIEW_CI.failureAction, maxFixAttempts: flat.reviewCiMaxFixAttempts ?? DEFAULT_REVIEW_CI.maxFixAttempts, deliveryChecks: [...(flat.reviewCiDeliveryChecks ?? DEFAULT_REVIEW_CI.deliveryChecks)], promotionChecks: [...(flat.reviewCiPromotionChecks ?? DEFAULT_REVIEW_CI.promotionChecks)], deploymentChecks: [...(flat.reviewCiDeploymentChecks ?? DEFAULT_REVIEW_CI.deploymentChecks)], repairPaths: [...(flat.reviewCiRepairPaths ?? DEFAULT_REVIEW_CI.repairPaths)] } satisfies EffectiveReviewCiConfig; validateReviewCiPatch({ reviewCiFailureAction: result.failureAction, reviewCiMaxFixAttempts: result.maxFixAttempts, reviewCiDeliveryChecks: result.deliveryChecks, reviewCiPromotionChecks: result.promotionChecks, reviewCiDeploymentChecks: result.deploymentChecks, reviewCiRepairPaths: result.repairPaths }); return result; }

export function resolveOrchestrationConfig(
  configured: ForgeDockNextConfig = {},
  overrides: Partial<ForgeDockNextConfig> = {},
): EffectiveOrchestrationConfig {
  const merged = flattenOrchestrationPatch({ ...configured, ...overrides });
  const result: EffectiveOrchestrationConfig = {
    batchingPolicy: merged.batchingPolicy ?? DEFAULT_ORCHESTRATION.batchingPolicy,
    maxBatchSize: merged.maxBatchSize ?? DEFAULT_ORCHESTRATION.maxBatchSize,
    maxSensitiveBatchSize: merged.maxSensitiveBatchSize ?? DEFAULT_ORCHESTRATION.maxSensitiveBatchSize,
    scopeExpansion: merged.scopeExpansion ?? DEFAULT_ORCHESTRATION.scopeExpansion,
    maxRemediationCycles: merged.maxRemediationCycles ?? DEFAULT_ORCHESTRATION.maxRemediationCycles,
    maxRemediationDepth: merged.maxRemediationDepth ?? DEFAULT_ORCHESTRATION.maxRemediationDepth,
    maxRemediationChildren: merged.maxRemediationChildren ?? DEFAULT_ORCHESTRATION.maxRemediationChildren,
    maxParallel: merged.maxParallel ?? DEFAULT_ORCHESTRATION.maxParallel,
    autoMerge: merged.autoMerge ?? DEFAULT_ORCHESTRATION.autoMerge,
    ...(merged.fastLaneTarget !== undefined ? { fastLaneTarget: merged.fastLaneTarget } : {}),
    ...(merged.featurePromotionTarget !== undefined ? { featurePromotionTarget: merged.featurePromotionTarget } : {}),
    ...(merged.productionTarget !== undefined ? { productionTarget: merged.productionTarget } : {}),
    dispatchMode: merged.dispatchMode ?? DEFAULT_ORCHESTRATION.dispatchMode,
  };
  validateEffectiveOrchestration(result);
  return result;
}

export function orchestrationConfigSources(
  configured: ForgeDockNextConfig = {},
  overrides: Partial<ForgeDockNextConfig> = {},
): Record<keyof EffectiveOrchestrationConfig, OrchestrationConfigSource> {
  const configuredFlat = flattenOrchestrationPatch(configured);
  const overrideFlat = flattenOrchestrationPatch(overrides);
  const source = (key: keyof EffectiveOrchestrationConfig): OrchestrationConfigSource =>
    overrideFlat[key] !== undefined ? "invocation" : configuredFlat[key] !== undefined ? "forge.yaml" : "default";
  return {
    batchingPolicy: source("batchingPolicy"),
    maxBatchSize: source("maxBatchSize"),
    maxSensitiveBatchSize: source("maxSensitiveBatchSize"),
    scopeExpansion: source("scopeExpansion"),
    maxRemediationCycles: source("maxRemediationCycles"),
    maxRemediationDepth: source("maxRemediationDepth"),
    maxRemediationChildren: source("maxRemediationChildren"),
    maxParallel: source("maxParallel"),
    autoMerge: source("autoMerge"),
    fastLaneTarget: source("fastLaneTarget"),
    featurePromotionTarget: source("featurePromotionTarget"),
    productionTarget: source("productionTarget"),
    dispatchMode: source("dispatchMode"),
  };
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
  config = flattenReviewPatch(config);
  const hasAgents = config.workerModel !== undefined || config.workerThinking !== undefined
    || config.reviewerModel !== undefined || config.reviewerThinking !== undefined
    || config.planningModel !== undefined || config.planningThinking !== undefined
    || config.maxReviewSpecialists !== undefined;
  const hasBatching = config.batchingPolicy !== undefined || config.maxBatchSize !== undefined || config.maxSensitiveBatchSize !== undefined;
  const hasOrchestration = hasBatching || config.scopeExpansion !== undefined || config.maxRemediationCycles !== undefined
    || config.maxRemediationDepth !== undefined || config.maxRemediationChildren !== undefined
    || config.maxParallel !== undefined || config.autoMerge !== undefined || config.fastLaneTarget !== undefined
    || config.featurePromotionTarget !== undefined || config.productionTarget !== undefined || config.dispatchMode !== undefined;
  const lines = [START, "next:", hasAgents ? "  agents:" : "  agents: {}"];
  if (config.workerModel !== undefined) lines.push(`    worker_model: ${JSON.stringify(config.workerModel)}`);
  if (config.workerThinking !== undefined) lines.push(`    worker_thinking: ${JSON.stringify(config.workerThinking)}`);
  if (config.reviewerModel !== undefined) lines.push(`    reviewer_model: ${JSON.stringify(config.reviewerModel)}`);
  if (config.reviewerThinking !== undefined) lines.push(`    reviewer_thinking: ${JSON.stringify(config.reviewerThinking)}`);
  if (config.planningModel !== undefined) lines.push(`    planning_model: ${JSON.stringify(config.planningModel)}`);
  if (config.planningThinking !== undefined) lines.push(`    planning_thinking: ${JSON.stringify(config.planningThinking)}`);
  if (config.maxReviewSpecialists !== undefined) lines.push(`    max_review_specialists: ${config.maxReviewSpecialists}`);
  if (!hasOrchestration) {
    lines.push("  orchestration: {}");
  } else {
    lines.push("  orchestration:");
    if (hasBatching) {
      lines.push("    batching:");
      if (config.batchingPolicy !== undefined) lines.push(`      policy: ${JSON.stringify(config.batchingPolicy)}`);
      if (config.maxBatchSize !== undefined) lines.push(`      max_batch_size: ${config.maxBatchSize}`);
      if (config.maxSensitiveBatchSize !== undefined) lines.push(`      max_sensitive_batch_size: ${config.maxSensitiveBatchSize}`);
    }
    if (config.scopeExpansion !== undefined) lines.push(`    scope_expansion: ${JSON.stringify(config.scopeExpansion)}`);
    if (config.maxRemediationCycles !== undefined) lines.push(`    max_remediation_cycles: ${config.maxRemediationCycles}`);
    if (config.maxRemediationDepth !== undefined) lines.push(`    max_remediation_depth: ${config.maxRemediationDepth}`);
    if (config.maxRemediationChildren !== undefined) lines.push(`    max_remediation_children: ${config.maxRemediationChildren}`);
    if (config.maxParallel !== undefined) lines.push(`    max_parallel: ${config.maxParallel}`);
    if (config.autoMerge !== undefined) lines.push(`    auto_merge: ${config.autoMerge}`);
    if (config.fastLaneTarget !== undefined) lines.push(`    fast_lane_target: ${JSON.stringify(config.fastLaneTarget)}`);
    if (config.featurePromotionTarget !== undefined) lines.push(`    feature_promotion_target: ${JSON.stringify(config.featurePromotionTarget)}`);
    if (config.productionTarget !== undefined) lines.push(`    production_target: ${JSON.stringify(config.productionTarget)}`);
    if (config.dispatchMode !== undefined) lines.push(`    dispatch_mode: ${JSON.stringify(config.dispatchMode)}`);
  }
  const hasReviewCi = config.reviewCiFailureAction !== undefined || config.reviewCiMaxFixAttempts !== undefined || config.reviewCiDeliveryChecks !== undefined || config.reviewCiPromotionChecks !== undefined || config.reviewCiDeploymentChecks !== undefined || config.reviewCiRepairPaths !== undefined;
  if (!hasReviewCi) lines.push("  review: {}"); else { lines.push("  review:", "    ci:"); if (config.reviewCiFailureAction !== undefined) lines.push(`      failure_action: ${JSON.stringify(config.reviewCiFailureAction)}`); if (config.reviewCiMaxFixAttempts !== undefined) lines.push(`      max_fix_attempts: ${config.reviewCiMaxFixAttempts}`); if (config.reviewCiDeliveryChecks !== undefined) lines.push(`      delivery_checks: ${JSON.stringify(config.reviewCiDeliveryChecks)}`); if (config.reviewCiPromotionChecks !== undefined) lines.push(`      promotion_checks: ${JSON.stringify(config.reviewCiPromotionChecks)}`); if (config.reviewCiDeploymentChecks !== undefined) lines.push(`      deployment_checks: ${JSON.stringify(config.reviewCiDeploymentChecks)}`); if (config.reviewCiRepairPaths !== undefined) lines.push(`      repair_paths: ${JSON.stringify(config.reviewCiRepairPaths)}`); }
  lines.push(END);
  return lines.join("\n");
}

function validatePatch(patch: ForgeDockNextConfig, requireValue = true): void {
  patch = flattenReviewPatch(patch);
  if (requireValue && !Object.values(patch).some((value) => value !== undefined)) throw new Error("At least one ForgeDock setting is required");
  for (const model of [patch.workerModel, patch.reviewerModel, patch.planningModel]) {
    if (model !== undefined && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._@:/-]+$/.test(model)) {
      throw new Error(`Model must use provider/model form: ${model}`);
    }
  }
  for (const thinking of [patch.workerThinking, patch.reviewerThinking, patch.planningThinking]) {
    if (thinking !== undefined && !THINKING_LEVELS.includes(thinking)) throw new Error(`Unsupported thinking level: ${thinking}`);
  }
  if (patch.maxReviewSpecialists !== undefined && (!Number.isInteger(patch.maxReviewSpecialists) || patch.maxReviewSpecialists < 1 || patch.maxReviewSpecialists > 6)) {
    throw new Error("maxReviewSpecialists must be an integer from 1 to 6");
  }
  if (patch.maxParallel !== undefined && (!Number.isInteger(patch.maxParallel) || patch.maxParallel < 1 || patch.maxParallel > 20)) {
    throw new Error("maxParallel must be an integer from 1 to 20");
  }
  if (patch.fastLaneTarget !== undefined && !isSafeBranchName(patch.fastLaneTarget)) {
    throw new Error(`fastLaneTarget must be a safe Git branch name: ${patch.fastLaneTarget}`);
  }
  if (patch.featurePromotionTarget !== undefined && !isSafeBranchName(patch.featurePromotionTarget)) {
    throw new Error(`featurePromotionTarget must be a safe Git branch name: ${patch.featurePromotionTarget}`);
  }
  if (patch.productionTarget !== undefined && !isSafeBranchName(patch.productionTarget)) {
    throw new Error(`productionTarget must be a safe Git branch name: ${patch.productionTarget}`);
  }
  if (patch.dispatchMode !== undefined && !["preview", "confirm", "auto"].includes(patch.dispatchMode)) throw new Error("dispatchMode must be preview, confirm, or auto");
  validateReviewCiPatch(patch);
  if (patch.batchingPolicy !== undefined && !["aggressive", "conservative", "none"].includes(patch.batchingPolicy)) throw new Error("batchingPolicy must be aggressive, conservative, or none");
  if (patch.scopeExpansion !== undefined && !["scope-locked", "recursive"].includes(patch.scopeExpansion)) throw new Error("scopeExpansion must be scope-locked or recursive");
  for (const [name, value] of [["maxBatchSize", patch.maxBatchSize], ["maxSensitiveBatchSize", patch.maxSensitiveBatchSize], ["maxRemediationCycles", patch.maxRemediationCycles], ["maxRemediationChildren", patch.maxRemediationChildren]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 100)) throw new Error(`${name} must be a positive integer from 1 to 100`);
  }
  if (patch.maxRemediationDepth !== undefined && (!Number.isSafeInteger(patch.maxRemediationDepth) || patch.maxRemediationDepth < 0 || patch.maxRemediationDepth > 100)) {
    throw new Error("maxRemediationDepth must be an integer from 0 to 100");
  }
  if (patch.maxSensitiveBatchSize !== undefined && patch.maxBatchSize !== undefined && patch.maxSensitiveBatchSize > patch.maxBatchSize) throw new Error("maxSensitiveBatchSize must be less than or equal to maxBatchSize");
  const nested = patch.orchestration;
  if (nested?.batching?.maxBatchSize !== undefined && (!Number.isSafeInteger(nested.batching.maxBatchSize) || nested.batching.maxBatchSize < 1 || nested.batching.maxBatchSize > 100)) throw new Error("orchestration.batching.maxBatchSize must be a positive integer");
  if (nested?.batching?.maxSensitiveBatchSize !== undefined && (!Number.isSafeInteger(nested.batching.maxSensitiveBatchSize) || nested.batching.maxSensitiveBatchSize < 1 || nested.batching.maxSensitiveBatchSize > 100)) throw new Error("orchestration.batching.maxSensitiveBatchSize must be a positive integer");
  if (nested?.batching?.maxSensitiveBatchSize !== undefined && nested.batching.maxBatchSize !== undefined && nested.batching.maxSensitiveBatchSize > nested.batching.maxBatchSize) {
    throw new Error("orchestration.batching.maxSensitiveBatchSize must be less than or equal to maxBatchSize");
  }
  if (nested?.maxRemediationCycles !== undefined && (!Number.isSafeInteger(nested.maxRemediationCycles) || nested.maxRemediationCycles < 1 || nested.maxRemediationCycles > 100)) throw new Error("maxRemediationCycles must be a positive integer");
  if (nested?.maxRemediationDepth !== undefined && (!Number.isSafeInteger(nested.maxRemediationDepth) || nested.maxRemediationDepth < 0 || nested.maxRemediationDepth > 100)) throw new Error("maxRemediationDepth must be an integer from 0 to 100");
  if (nested?.maxRemediationChildren !== undefined && (!Number.isSafeInteger(nested.maxRemediationChildren) || nested.maxRemediationChildren < 1 || nested.maxRemediationChildren > 100)) throw new Error("maxRemediationChildren must be a positive integer");
  if (nested?.maxParallel !== undefined && (!Number.isSafeInteger(nested.maxParallel) || nested.maxParallel < 1 || nested.maxParallel > 20)) throw new Error("maxParallel must be an integer from 1 to 20");
  if (nested?.fastLaneTarget !== undefined && !isSafeBranchName(nested.fastLaneTarget)) throw new Error(`orchestration.fastLaneTarget must be a safe Git branch name: ${nested.fastLaneTarget}`);
  if (nested?.featurePromotionTarget !== undefined && !isSafeBranchName(nested.featurePromotionTarget)) throw new Error(`orchestration.featurePromotionTarget must be a safe Git branch name: ${nested.featurePromotionTarget}`);
  if (nested?.productionTarget !== undefined && !isSafeBranchName(nested.productionTarget)) throw new Error(`orchestration.productionTarget must be a safe Git branch name: ${nested.productionTarget}`);
  if (nested?.dispatchMode !== undefined && !["preview", "confirm", "auto"].includes(nested.dispatchMode)) throw new Error("orchestration.dispatchMode must be preview, confirm, or auto");
}
function flattenReviewPatch(patch: ForgeDockNextConfig): ForgeDockNextConfig { const nested = patch.review?.ci; if (!nested) return { ...patch }; const result: ForgeDockNextConfig = { ...patch }; delete result.review; if (result.reviewCiFailureAction === undefined && nested.failureAction !== undefined) result.reviewCiFailureAction = nested.failureAction; if (result.reviewCiMaxFixAttempts === undefined && nested.maxFixAttempts !== undefined) result.reviewCiMaxFixAttempts = nested.maxFixAttempts; if (result.reviewCiDeliveryChecks === undefined && nested.deliveryChecks !== undefined) result.reviewCiDeliveryChecks = [...nested.deliveryChecks]; if (result.reviewCiPromotionChecks === undefined && nested.promotionChecks !== undefined) result.reviewCiPromotionChecks = [...nested.promotionChecks]; if (result.reviewCiDeploymentChecks === undefined && nested.deploymentChecks !== undefined) result.reviewCiDeploymentChecks = [...nested.deploymentChecks]; if (result.reviewCiRepairPaths === undefined && nested.repairPaths !== undefined) result.reviewCiRepairPaths = [...nested.repairPaths]; return result; }
function validateReviewCiPatch(patch: ForgeDockNextConfig): void { if (patch.reviewCiFailureAction !== undefined && !["ask", "auto-fix"].includes(patch.reviewCiFailureAction)) throw new Error("review.ci.failureAction must be ask or auto-fix"); if (patch.reviewCiMaxFixAttempts !== undefined && (!Number.isSafeInteger(patch.reviewCiMaxFixAttempts) || patch.reviewCiMaxFixAttempts < 1 || patch.reviewCiMaxFixAttempts > 5)) throw new Error("review.ci.maxFixAttempts must be an integer from 1 to 5"); for (const [name, selectors] of [["deliveryChecks", patch.reviewCiDeliveryChecks], ["promotionChecks", patch.reviewCiPromotionChecks], ["deploymentChecks", patch.reviewCiDeploymentChecks]] as const) if (selectors !== undefined && (!selectors.length || selectors.length > 100 || selectors.some((value) => !value.trim() || value.length > 200 || /[\r\n]/.test(value)))) throw new Error(`review.ci.${name} must contain 1 to 100 non-empty check selectors`); if (patch.reviewCiRepairPaths !== undefined && (patch.reviewCiRepairPaths.length > 200 || patch.reviewCiRepairPaths.some((value) => !isSafeRepositoryPath(value)))) throw new Error("review.ci.repairPaths must contain safe repository-relative paths"); }
function isSafeRepositoryPath(value: string): boolean { return Boolean(value) && value.length <= 500 && !value.includes("\\") && !value.startsWith("/") && !/^[A-Za-z]:/.test(value) && value.split("/").every((segment) => Boolean(segment) && segment !== "." && segment !== ".."); }

function flattenOrchestrationPatch(patch: ForgeDockNextConfig): ForgeDockNextConfig {
  const nested = patch.orchestration;
  if (!nested) return { ...patch };
  const result: ForgeDockNextConfig = { ...patch };
  delete result.orchestration;
  if (result.batchingPolicy === undefined && nested.batching?.policy !== undefined) result.batchingPolicy = nested.batching.policy;
  if (result.maxBatchSize === undefined && nested.batching?.maxBatchSize !== undefined) result.maxBatchSize = nested.batching.maxBatchSize;
  if (result.maxSensitiveBatchSize === undefined && nested.batching?.maxSensitiveBatchSize !== undefined) result.maxSensitiveBatchSize = nested.batching.maxSensitiveBatchSize;
  if (result.scopeExpansion === undefined && nested.scopeExpansion !== undefined) result.scopeExpansion = nested.scopeExpansion;
  if (result.maxRemediationCycles === undefined && nested.maxRemediationCycles !== undefined) result.maxRemediationCycles = nested.maxRemediationCycles;
  if (result.maxRemediationDepth === undefined && nested.maxRemediationDepth !== undefined) result.maxRemediationDepth = nested.maxRemediationDepth;
  if (result.maxRemediationChildren === undefined && nested.maxRemediationChildren !== undefined) result.maxRemediationChildren = nested.maxRemediationChildren;
  if (result.maxParallel === undefined && nested.maxParallel !== undefined) result.maxParallel = nested.maxParallel;
  if (result.autoMerge === undefined && nested.autoMerge !== undefined) result.autoMerge = nested.autoMerge;
  if (result.fastLaneTarget === undefined && nested.fastLaneTarget !== undefined) result.fastLaneTarget = nested.fastLaneTarget;
  if (result.featurePromotionTarget === undefined && nested.featurePromotionTarget !== undefined) result.featurePromotionTarget = nested.featurePromotionTarget;
  if (result.productionTarget === undefined && nested.productionTarget !== undefined) result.productionTarget = nested.productionTarget;
  if (result.dispatchMode === undefined && nested.dispatchMode !== undefined) result.dispatchMode = nested.dispatchMode;
  return result;
}

function validateEffectiveOrchestration(config: EffectiveOrchestrationConfig): void {
  if (!["aggressive", "conservative", "none"].includes(config.batchingPolicy)) throw new Error("Invalid effective batching policy");
  if (!["scope-locked", "recursive"].includes(config.scopeExpansion)) throw new Error("Invalid effective scope expansion");
  if (!Number.isSafeInteger(config.maxBatchSize) || config.maxBatchSize < 1) throw new Error("Invalid effective maxBatchSize");
  if (!Number.isSafeInteger(config.maxSensitiveBatchSize) || config.maxSensitiveBatchSize < 1 || config.maxSensitiveBatchSize > config.maxBatchSize) throw new Error("Invalid effective sensitive batch cap");
  if (!Number.isSafeInteger(config.maxRemediationCycles) || config.maxRemediationCycles < 1) throw new Error("Invalid effective remediation cycle limit");
  if (!Number.isSafeInteger(config.maxRemediationDepth) || config.maxRemediationDepth < 0) throw new Error("Invalid effective remediation depth");
  if (!Number.isSafeInteger(config.maxRemediationChildren) || config.maxRemediationChildren < 1) throw new Error("Invalid effective remediation child limit");
  if (!Number.isSafeInteger(config.maxParallel) || config.maxParallel < 1) throw new Error("Invalid effective maxParallel");
  if (config.fastLaneTarget !== undefined && !isSafeBranchName(config.fastLaneTarget)) throw new Error(`Invalid effective fastLaneTarget: ${config.fastLaneTarget}`);
  if (config.featurePromotionTarget !== undefined && !isSafeBranchName(config.featurePromotionTarget)) throw new Error(`Invalid effective featurePromotionTarget: ${config.featurePromotionTarget}`);
  if (config.productionTarget !== undefined && !isSafeBranchName(config.productionTarget)) throw new Error(`Invalid effective productionTarget: ${config.productionTarget}`);
  if (!["preview", "confirm", "auto"].includes(config.dispatchMode)) throw new Error(`Invalid effective dispatchMode: ${config.dispatchMode}`);
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

function parseBatchingPolicy(value: string | undefined): BatchingPolicy | undefined {
  const parsed = parseString(value);
  return parsed === "aggressive" || parsed === "conservative" || parsed === "none" ? parsed : undefined;
}

function parseScopeExpansion(value: string | undefined): ScopeExpansion | undefined {
  const parsed = parseString(value);
  return parsed === "scope-locked" || parsed === "recursive" ? parsed : undefined;
}

function parseDispatchMode(value: string | undefined): OrchestrationDispatchMode | undefined {
  const parsed = parseString(value);
  return parsed === "preview" || parsed === "confirm" || parsed === "auto" ? parsed : undefined;
}
function parseReviewCiFailureAction(value: string | undefined): ReviewCiFailureAction | undefined { const parsed = parseString(value); return parsed === "ask" || parsed === "auto-fix" ? parsed : undefined; }
function parseStringArray(value: string | undefined): readonly string[] | undefined { if (value === undefined) return undefined; try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? parsed : undefined; } catch { return undefined; } }

function parsePositiveInteger(value: string | undefined): number | undefined {
  const parsed = parseNonNegativeInteger(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function parseNonNegativeInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function isSafeBranchName(value: string): boolean {
  return /^[A-Za-z0-9._/-]+$/u.test(value) && !value.includes("..") && !value.startsWith("/") && !value.endsWith("/") && !value.includes("//");
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
