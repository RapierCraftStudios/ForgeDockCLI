// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ScheduledWorkItem } from "./scheduler.js";

export type BatchRiskClass = "routine" | "security" | "auth" | "billing";

export interface BatchableWorkItem extends ScheduledWorkItem {
  title: string;
  summary: string;
  labels: readonly string[];
  affectedFiles: readonly string[];
  sourcePullRequest?: number;
  defectClass?: string;
  riskClass?: BatchRiskClass;
  memberIssues?: readonly number[];
}

export interface IssueBatchGroup {
  id: string;
  kind: "same-file" | "source-pr" | "defect-class" | "leaf-directory";
  key: string;
  riskClass: BatchRiskClass;
  members: BatchableWorkItem[];
}

export interface IssueBatchPlan {
  groups: IssueBatchGroup[];
  ungrouped: BatchableWorkItem[];
  excluded: Array<{ item: BatchableWorkItem; reason: string }>;
}

export interface MaterializedBatchIssue {
  groupId: string;
  issue: number;
  title: string;
  summary: string;
}

const HIGH_BLAST_RADIUS = /(?:^|\/)(?:\.env\.example|docker-compose[^/]*|compose[^/]*|index\.[^/]+|main\.[^/]+)$/i;
const MAX_ROUTINE_MEMBERS = 8;
const MAX_SENSITIVE_MEMBERS = 3;

export function planIssueBatches(items: readonly BatchableWorkItem[]): IssueBatchPlan {
  const remaining = new Map<string, BatchableWorkItem>();
  const excluded: IssueBatchPlan["excluded"] = [];
  for (const item of items) {
    const reason = batchExclusionReason(item);
    if (reason) excluded.push({ item, reason });
    else remaining.set(item.id, item);
  }

  const groups: IssueBatchGroup[] = [];
  const claim = (
    kind: IssueBatchGroup["kind"],
    keyOf: (item: BatchableWorkItem) => string | undefined,
    minimum: number,
  ) => {
    const keyed = new Map<string, BatchableWorkItem[]>();
    for (const item of remaining.values()) {
      const key = keyOf(item);
      if (!key) continue;
      const risk = item.riskClass ?? "routine";
      const compound = `${risk}:${key}`;
      keyed.set(compound, [...(keyed.get(compound) ?? []), item]);
    }
    for (const [compound, candidates] of [...keyed].sort(([left], [right]) => left.localeCompare(right))) {
      candidates.sort((left, right) => left.priority - right.priority || left.issue - right.issue);
      while (candidates.length >= minimum) {
        const riskClass = (candidates[0]?.riskClass ?? "routine") as BatchRiskClass;
        const cap = riskClass === "routine" ? MAX_ROUTINE_MEMBERS : MAX_SENSITIVE_MEMBERS;
        const members = candidates.splice(0, cap);
        if (members.length < minimum) break;
        const key = compound.slice(compound.indexOf(":") + 1);
        const id = `batch:${kind}:${key}:${members.map((member) => member.issue).join("-")}`;
        groups.push({ id, kind, key, riskClass, members });
        for (const member of members) remaining.delete(member.id);
      }
    }
  };

  claim("same-file", (item) => item.affectedFiles[0], 2);
  claim("source-pr", (item) => item.sourcePullRequest ? String(item.sourcePullRequest) : undefined, 2);
  claim("defect-class", (item) => item.defectClass, 2);
  claim("leaf-directory", (item) => leafDirectory(item.affectedFiles[0]), 3);

  return { groups, ungrouped: [...remaining.values()], excluded };
}

export function batchExclusionReason(item: BatchableWorkItem): string | undefined {
  if (item.memberIssues?.length && item.memberIssues.length > 1) return "already-batched";
  if (!item.labels.includes("review-finding")) return "not-review-finding";
  const priority = priorityFromLabels(item.labels);
  if (priority !== "P2" && priority !== "P3") return "urgency";
  if (item.labels.some((label) => ["needs-human", "blocked", "operator-only", "batch"].includes(label))) return "human-or-batch-state";
  if (!item.affectedFiles.length) return "no-affected-file";
  const risk = item.riskClass ?? "routine";
  if (risk === "billing") return "billing";
  if (item.affectedFiles.some((file) => /\/migrations?\//i.test(file) || HIGH_BLAST_RADIUS.test(file))) return "high-blast-radius";
  return undefined;
}

export function contractBatchGroups(
  items: readonly BatchableWorkItem[],
  groups: readonly IssueBatchGroup[],
  materialized: readonly MaterializedBatchIssue[],
): BatchableWorkItem[] {
  const byGroup = new Map(materialized.map((batch) => [batch.groupId, batch]));
  const memberToBatch = new Map<string, string>();
  const replacements: BatchableWorkItem[] = [];

  for (const group of groups) {
    const issue = byGroup.get(group.id);
    if (!issue) throw new Error(`Batch group ${group.id} was not materialized`);
    const memberIds = new Set(group.members.map((member) => member.id));
    const dependencies = unique(group.members.flatMap((member) => member.dependencies).filter((dependency) => !memberIds.has(dependency)));
    const claims = unique(group.members.flatMap((member) => member.claims));
    const labels = unique(group.members.flatMap((member) => member.labels));
    const affectedFiles = unique(group.members.flatMap((member) => member.affectedFiles));
    const memberIssues = group.members.flatMap((member) => member.memberIssues?.length ? [...member.memberIssues] : [member.issue]);
    const id = `issue-${issue.issue}`;
    for (const member of group.members) memberToBatch.set(member.id, id);
    replacements.push({
      id,
      issue: issue.issue,
      title: issue.title,
      summary: issue.summary,
      priority: Math.min(...group.members.map((member) => member.priority)),
      dependencies,
      claims,
      labels,
      affectedFiles,
      riskClass: group.riskClass,
      memberIssues: uniqueNumbers(memberIssues),
    });
  }

  const groupedIds = new Set(memberToBatch.keys());
  const retained = items.filter((item) => !groupedIds.has(item.id)).map((item) => ({
    ...item,
    dependencies: unique(item.dependencies.map((dependency) => memberToBatch.get(dependency) ?? dependency)),
  }));
  const contracted = [...retained, ...replacements].map((item) => ({
    ...item,
    dependencies: unique(item.dependencies.map((dependency) => memberToBatch.get(dependency) ?? dependency)).filter((dependency) => dependency !== item.id),
  }));
  return contracted.sort((left, right) => left.priority - right.priority || left.issue - right.issue);
}

export function renderBatchIssueBody(group: IssueBatchGroup): string {
  const members = group.members.flatMap((member) => member.memberIssues?.length ? [...member.memberIssues] : [member.issue]);
  return [
    "## Problem",
    "",
    `Deliver ${members.length} compatible P2/P3 review findings as one verified work unit to reduce repeated investigation, build, verification, and review overhead.`,
    "",
    "## Member Findings",
    "",
    "<!-- FORGE:BATCH_MEMBERS -->",
    ...group.members.flatMap((member) => [
      `- [ ] #${member.issue}: ${escapeText(member.title, 500)}`,
      `  - Scope: ${escapeText(member.summary)}`,
      `  - Affected files: ${member.affectedFiles.map((file) => `\`${escapeCode(file)}\``).join(", ") || "not declared"}`,
    ]),
    "<!-- /FORGE:BATCH_MEMBERS -->",
    "",
    "## Affected Surface",
    "",
    `- Grouping: ${group.kind}`,
    `- Key: \`${escapeCode(group.key)}\``,
    `- Risk class: ${group.riskClass}`,
    "",
    "## Acceptance Criteria",
    "",
    "- [ ] Every member finding is addressed or rejected with evidence.",
    "- [ ] The combined change passes the frozen verification policy and independent review.",
    "- [ ] Successful completion records the batch Outcome on every member and closes every member issue.",
    "",
    `<!-- FORGEDOCK:BATCH ${batchMarker(members)} -->`,
  ].join("\n");
}

export function affectedFilesFromIssueBody(body: string): string[] {
  const section = /^#{2,3}\s+(?:Affected Files|Deliverables|Files to change)\s*$([\s\S]*?)(?=^#{1,3}\s+|(?![\s\S]))/im.exec(body)?.[1] ?? "";
  const backticked = [...section.matchAll(/`([^`\r\n]+)`/g)].map((match) => match[1]!.trim());
  return unique(backticked.filter((path) => /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.@+-]+)+$/.test(path)));
}

export function inferBatchRiskClass(title: string, body: string, labels: readonly string[]): BatchRiskClass {
  const text = `${title}\n${body}\n${labels.join(" ")}`;
  if (/\bbilling|credit|pricing|stripe|charge|refund\b/i.test(text)) return "billing";
  if (/\bauth(?:entication|orization)?\b|\bauth[zn]_\w+|oauth|permission|session|jwt|login/i.test(text)) return "auth";
  if (/security|inject|xss|csrf|ssrf|bypass|credential|secret|token|password|traversal|deserializ|\brce\b|privilege/i.test(text)) return "security";
  return "routine";
}

export function parseBatchMemberIssues(body: string): number[] {
  const section = /<!-- FORGE:BATCH_MEMBERS -->([\s\S]*?)<!-- \/FORGE:BATCH_MEMBERS -->/.exec(body)?.[1] ?? "";
  return uniqueNumbers([...section.matchAll(/^\s*- \[[ xX]\] #(\d+)\b/gm)].map((match) => Number(match[1])))
    .filter((number) => Number.isSafeInteger(number) && number > 0)
    .slice(0, MAX_ROUTINE_MEMBERS);
}

export function batchMarker(members: readonly number[]): string {
  return uniqueNumbers(members).sort((left, right) => left - right).join("-");
}

function priorityFromLabels(labels: readonly string[]): string | undefined {
  return labels.find((label) => /^priority:P[0-3]$/.test(label))?.slice(-2)
    ?? labels.find((label) => /^P[0-3]$/.test(label));
}

function leafDirectory(file: string | undefined): string | undefined {
  if (!file) return undefined;
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
  const slash = normalized.lastIndexOf("/");
  return slash > 0 ? normalized.slice(0, slash) : undefined;
}

function escapeCode(value: string): string {
  return value.replaceAll("`", "").replace(/[\r\n]/g, " ").slice(0, 500);
}

function escapeText(value: string, limit = 4_000): string {
  return value.replace(/<!--[\s\S]*?-->/g, "").replace(/[\r\n]+/g, " ").trim().slice(0, limit);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)];
}
