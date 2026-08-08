// SPDX-License-Identifier: AGPL-3.0-or-later

import { contractBatchGroups, type BatchableWorkItem, type IssueBatchGroup } from "./batching.js";
import { validateGraph, type ScheduledWorkItem } from "./scheduler.js";

export type BatchingPolicy = "aggressive" | "conservative" | "none";

export interface BatchingOptions {
  policy: BatchingPolicy;
  maxBatchSize: number;
  maxSensitiveBatchSize: number;
  priorities?: readonly string[];
  milestone?: string;
  noMilestone?: boolean;
  scopeExpansion?: "scope-locked" | "recursive";
  maxRemediationCycles?: number;
}

export interface WorkUnitAssembly {
  selected: BatchableWorkItem[];
  groups: IssueBatchGroup[];
  ungrouped: BatchableWorkItem[];
  excluded: Array<{ item: BatchableWorkItem; reason: string }>;
  policy: BatchingOptions;
}

export const DEFAULT_BATCHING_OPTIONS: BatchingOptions = {
  policy: "aggressive",
  maxBatchSize: 8,
  maxSensitiveBatchSize: 3,
};

/**
 * Build the pre-DAG work-unit proposal. This function is deliberately pure:
 * it reads only the evidence supplied by the caller and never creates issues,
 * acquires leases, or calls GitHub.
 */
export function assembleWorkUnits(
  items: readonly BatchableWorkItem[],
  options: BatchingOptions,
): WorkUnitAssembly {
  const policy = normalizeBatchingOptions(options);
  const seen = new Set<string>();
  const selected: BatchableWorkItem[] = [];
  const excluded: WorkUnitAssembly["excluded"] = [];

  for (const item of items) {
    if (seen.has(item.id)) throw new Error(`Duplicate work item id: ${item.id}`);
    seen.add(item.id);
    const filterReason = filterExclusionReason(item, policy);
    if (filterReason) {
      excluded.push({ item, reason: filterReason });
      continue;
    }
    selected.push(cloneItem(item));
  }

  const orderedFiltered = selected.sort(compareItems);
  // Human/operator state is not a dispatchable work unit. Other non-batchable
  // risks remain selected as singleton work; `excluded` explains why they
  // were not eligible for contraction rather than silently dropping delivery.
  const orderedSelected = orderedFiltered.filter((item) => {
    const reason = singletonReason(item, policy.policy);
    if (reason === "human-or-batch-state") {
      excluded.push({ item, reason });
      return false;
    }
    return true;
  });
  if (policy.policy === "none") {
    return { selected: orderedSelected, groups: [], ungrouped: orderedSelected, excluded, policy };
  }

  const eligible: BatchableWorkItem[] = [];
  const ungrouped: BatchableWorkItem[] = [];
  for (const item of orderedSelected) {
    const reason = singletonReason(item, policy.policy);
    if (reason) {
      ungrouped.push(item);
      excluded.push({ item, reason });
    } else {
      eligible.push(item);
    }
  }

  if (policy.policy === "conservative") {
    const conservative = conservativeGroups(eligible, policy);
    return {
      selected: orderedSelected,
      groups: conservative.groups,
      ungrouped: [...ungrouped, ...conservative.ungrouped].sort(compareItems),
      excluded: [...excluded, ...conservative.excluded],
      policy,
    };
  }

  const groups: IssueBatchGroup[] = [];
  let remaining = eligible;
  for (const kind of ["same-file", "source-pr", "defect-class", "leaf-directory"] as const) {
    const claimed = new Set<string>();
    const keyed = new Map<string, BatchableWorkItem[]>();
    for (const item of remaining) {
      for (const key of groupingKeys(item, kind)) {
        const context = compatibilityKey(item, key);
        if (!context) continue;
        keyed.set(`${context}\u0000${key}`, [...(keyed.get(`${context}\u0000${key}`) ?? []), item]);
      }
    }
    for (const [compound, candidates] of [...keyed.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const [context, key] = compound.split("\u0000");
      if (!context || !key || candidates.length < 2) continue;
      const riskClass = candidates[0]?.riskClass ?? "routine";
      if (riskClass !== "routine" && kind === "leaf-directory") continue;
      const uniqueCandidates = [...new Map(candidates.map((item) => [item.id, item])).values()]
        .filter((item) => !claimed.has(item.id))
        .sort(compareItems);
      const cap = riskClass === "routine" ? policy.maxBatchSize : policy.maxSensitiveBatchSize;
      for (let offset = 0; offset + 1 < uniqueCandidates.length; offset += cap) {
        const members = uniqueCandidates.slice(offset, offset + cap);
        if (members.length < 2) break;
        if (!isConvexGroup(orderedSelected, members)) {
          ungrouped.push(...members);
          for (const member of members) claimed.add(member.id);
          continue;
        }
        const group: IssueBatchGroup = {
          id: `batch:${kind}:${key}:${members.map((member) => member.issue).join("-")}`,
          kind,
          key,
          riskClass,
          members,
        };
        groups.push(group);
        for (const member of members) claimed.add(member.id);
      }
    }
    remaining = remaining.filter((item) => !claimed.has(item.id));
  }

  ungrouped.push(...remaining);
  return {
    selected: orderedSelected,
    groups,
    ungrouped: [...new Map(ungrouped.map((item) => [item.id, item])).values()].sort(compareItems),
    excluded,
    policy,
  };
}

export function normalizeBatchingOptions(options: BatchingOptions): BatchingOptions {
  if (!options || !["aggressive", "conservative", "none"].includes(options.policy)) {
    throw new Error("batching policy must be aggressive, conservative, or none");
  }
  assertPositiveInteger(options.maxBatchSize, "maxBatchSize");
  assertPositiveInteger(options.maxSensitiveBatchSize, "maxSensitiveBatchSize");
  if (options.maxSensitiveBatchSize > options.maxBatchSize) {
    throw new Error("maxSensitiveBatchSize must be less than or equal to maxBatchSize");
  }
  if (options.milestone !== undefined && options.noMilestone) {
    throw new Error("milestone and noMilestone are mutually exclusive");
  }
  const priorities = options.priorities?.map((priority) => normalizePriority(priority));
  return {
    ...options,
    ...(priorities !== undefined ? { priorities } : {}),
  };
}

function conservativeGroups(items: readonly BatchableWorkItem[], options: BatchingOptions): {
  groups: IssueBatchGroup[];
  ungrouped: BatchableWorkItem[];
  excluded: Array<{ item: BatchableWorkItem; reason: string }>;
} {
  const groups: IssueBatchGroup[] = [];
  const excluded: Array<{ item: BatchableWorkItem; reason: string }> = [];
  const ungrouped: BatchableWorkItem[] = [];
  const remaining = new Map(items.map((item) => [item.id, item]));
  const kinds = ["same-file", "source-pr", "defect-class", "leaf-directory"] as const;
  for (const kind of kinds) {
    const keyed = new Map<string, BatchableWorkItem[]>();
    for (const item of remaining.values()) {
      const key = groupingKeys(item, kind)[0];
      if (!key) continue;
      keyed.set(`${item.riskClass ?? "routine"}\u0000${key}`, [...(keyed.get(`${item.riskClass ?? "routine"}\u0000${key}`) ?? []), item]);
    }
    for (const [compound, candidates] of [...keyed.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (candidates.length < 2) continue;
      const [, key] = compound.split("\u0000");
      if (!key) continue;
      candidates.sort(compareItems);
      const cap = (candidates[0]?.riskClass ?? "routine") === "routine" ? options.maxBatchSize : options.maxSensitiveBatchSize;
      const members = candidates.slice(0, cap);
      if (members.length < 2 || !isConvexGroup(items, members)) continue;
      const group: IssueBatchGroup = {
        id: `batch:${kind}:${key}:${members.map((member) => member.issue).join("-")}`,
        kind, key, riskClass: members[0]?.riskClass ?? "routine", members,
      };
      groups.push(group);
      members.forEach((member) => remaining.delete(member.id));
    }
  }
  // Conservative is intentionally the old review-finding/P2/P3 behavior.
  for (const item of remaining.values()) {
    if (item.labels.includes("review-finding") && ["P2", "P3"].includes(priorityOf(item))) ungrouped.push(item);
    else excluded.push({ item, reason: "conservative-review-finding-only" });
  }
  return { groups, ungrouped, excluded };
}

function singletonReason(item: BatchableWorkItem, policy: BatchingPolicy): string | undefined {
  if (item.memberIssues?.length && item.memberIssues.some((issue) => issue !== item.issue)) return "already-batched";
  if (item.labels.some((label) => ["needs-human", "blocked", "operator-only", "batch"].includes(label))) return "human-or-batch-state";
  const risk = item.riskClass ?? "routine";
  if (risk === "billing") return "billing";
  if (item.affectedFiles.some((file) => /(?:^|\/)migrations?\//i.test(file) || /(?:^|\/)(?:\.env(?:\.[^/]+)?|docker-compose[^/]*|compose[^/]*|index\.[^/]+|main\.[^/]+)$/i.test(file))) {
    return "high-blast-radius";
  }
  if (!item.affectedFiles.length && !item.claims.some((claim) => claim.trim())) return "no-trustworthy-scope";
  if (policy === "conservative" && (!item.labels.includes("review-finding") || !["P2", "P3"].includes(priorityOf(item)))) {
    return "conservative-review-finding-only";
  }
  return undefined;
}

function groupingKeys(item: BatchableWorkItem, kind: IssueBatchGroup["kind"]): string[] {
  switch (kind) {
    case "same-file": return [...new Set(item.affectedFiles.map(normalizePath).filter(Boolean))];
    case "source-pr": return item.sourcePullRequest ? [String(item.sourcePullRequest)] : [];
    case "defect-class": return item.defectClass?.trim() ? [item.defectClass.trim()] : [];
    case "leaf-directory": return [...new Set(item.affectedFiles.map(leafDirectory).filter((value): value is string => Boolean(value)))];
  }
}

function compatibilityKey(item: BatchableWorkItem, groupingKey: string): string | undefined {
  const repository = item.repository ?? item.repo;
  const targetBranch = item.targetBranch ?? item.lane?.targetBranch;
  const urgency = item.urgencyTier ?? (priorityOf(item) === "unknown" ? undefined : ["P0", "P1"].includes(priorityOf(item)) ? "urgent" : "normal");
  const risk = item.riskClass ?? "routine";
  if (!repository || !targetBranch || !urgency || risk === "billing") return undefined;
  if ((risk === "security" || risk === "auth") && groupingKey === "") return undefined;
  const milestone = milestoneValue(item.milestone);
  return [repository, targetBranch, urgency, risk, milestone ?? "none"].join("\u0001");
}

function isConvexGroup(allItems: readonly BatchableWorkItem[], members: readonly BatchableWorkItem[]): boolean {
  const memberIds = new Set(members.map((member) => member.id));
  const memberIssues = new Set(members.map((member) => `issue-${member.issue}`));
  for (const member of members) {
    for (const dependency of member.dependencies) {
      if (memberIds.has(dependency)) continue;
      const outside = allItems.find((item) => item.id === dependency);
      if (!outside) return false;
      if (outside.dependencies.some((candidate) => memberIds.has(candidate) || memberIssues.has(candidate))) return false;
    }
  }
  // Run the same contraction validator used after materialization against a
  // deterministic virtual issue. This catches cycles introduced by edges not
  // visible in the simple local convexity test.
  try {
    const virtual = contractBatchGroups(allItems, [{
      id: "virtual-group", kind: "same-file", key: "virtual", riskClass: members[0]?.riskClass ?? "routine", members: [...members],
    }], [{ groupId: "virtual-group", issue: 9_000_000_001, title: "virtual", summary: "virtual" }]);
    validateGraph(virtual as ScheduledWorkItem[]);
    return true;
  } catch {
    return false;
  }
}

function filterExclusionReason(item: BatchableWorkItem, options: BatchingOptions): string | undefined {
  if (options.priorities?.length && !options.priorities.includes(priorityOf(item))) return "priority-filter";
  const milestone = milestoneValue(item.milestone);
  if (options.milestone !== undefined && milestone !== options.milestone) return "milestone-filter";
  if (options.noMilestone && milestone !== undefined) return "no-milestone-filter";
  return undefined;
}

function cloneItem(item: BatchableWorkItem): BatchableWorkItem {
  return {
    ...item,
    dependencies: [...item.dependencies],
    claims: [...item.claims],
    labels: [...item.labels],
    affectedFiles: [...item.affectedFiles],
    ...(item.memberIssues ? { memberIssues: [...item.memberIssues] } : {}),
  };
}

function compareItems(left: BatchableWorkItem, right: BatchableWorkItem): number {
  return left.priority - right.priority || left.issue - right.issue || left.id.localeCompare(right.id);
}

function priorityOf(item: BatchableWorkItem): string {
  const label = item.labels.find((value) => /^(?:priority:)?P[0-3]$/i.test(value));
  if (label) return label.slice(-2).toUpperCase();
  return Number.isInteger(item.priority) && item.priority >= 0 && item.priority <= 3 ? `P${item.priority}` : "unknown";
}

function normalizePriority(value: string): string {
  const normalized = value.replace(/^priority:/i, "").toUpperCase();
  if (!["P0", "P1", "P2", "P3"].includes(normalized)) throw new Error(`Unsupported priority filter: ${value}`);
  return normalized;
}

function milestoneValue(value: BatchableWorkItem["milestone"]): string | undefined {
  return typeof value === "string" ? value : value?.title;
}

function leafDirectory(file: string): string | undefined {
  const normalized = normalizePath(file);
  const slash = normalized.lastIndexOf("/");
  return slash > 0 ? normalized.slice(0, slash) : undefined;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
}
