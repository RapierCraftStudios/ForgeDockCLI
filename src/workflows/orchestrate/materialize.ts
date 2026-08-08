// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ForgeHost, IssueSnapshot } from "../../core/ports/forge-host.js";
import {
  affectedFilesFromIssueBody,
  batchExclusionReason,
  inferBatchRiskClass,
  renderBatchIssueBody,
  type BatchableWorkItem,
  type IssueBatchGroup,
  type MaterializedBatchIssue,
} from "./batching.js";
import { contractBatchGroups } from "./batching.js";
import { materializeClaimDependencies, validateGraph, type ScheduledWorkItem } from "./scheduler.js";

export interface BatchMaterializationHost {
  getIssue(number: number, repo?: string): Promise<IssueSnapshot>;
  materializeBatchIssue(input: {
    repo: string;
    title: string;
    body: string;
    priorityLabel: "priority:P0" | "P0" | "priority:P1" | "P1" | "priority:P2" | "P2" | "priority:P3" | "P3";
    milestone?: string;
  }): Promise<IssueSnapshot>;
}

export interface MaterializeBatchGroupsInput {
  repo: string;
  groups: readonly IssueBatchGroup[];
  host: BatchMaterializationHost;
  /** Full selected plan used for external dependency remapping. */
  items?: readonly BatchableWorkItem[];
  /** Optional authoritative lane snapshot captured while resolving inputs. */
  expectedRoutes?: ReadonlyMap<number, { targetBranch: string; lane?: string }>;
}

export interface MaterializeBatchGroupsResult {
  groups: IssueBatchGroup[];
  materialized: MaterializedBatchIssue[];
  validatedItems: BatchableWorkItem[];
}

/**
 * Re-read proposed members and materialize deterministic batch issues through
 * the ForgeHost port. No agent, TUI client, or direct `gh` invocation belongs
 * in this module.
 */
export async function materializeBatchGroups(
  input: MaterializeBatchGroupsInput,
): Promise<MaterializeBatchGroupsResult> {
  const groups: IssueBatchGroup[] = [];
  const materialized: MaterializedBatchIssue[] = [];
  for (const proposed of input.groups) {
    const validated = await revalidateBatchGroup(proposed, input.repo, input.host, input.expectedRoutes);
    const members = validated.members;
    const priority = priorityLabel(members);
    const title = `fix(batch): ${members.length} ${priority.slice(-2)} findings — ${safeTitle(proposed.key)}`.slice(0, 240);
    const summary = `Deliver ${members.map((member) => `#${member.issue}`).join(", ")} as one ${proposed.kind} work unit.`;
    const issue = await input.host.materializeBatchIssue({
      repo: input.repo,
      title,
      body: renderBatchIssueBody({ ...proposed, members }),
      priorityLabel: priority,
      ...(validated.milestone ? { milestone: validated.milestone } : {}),
    });
    groups.push({ ...proposed, members });
    materialized.push({ groupId: proposed.id, issue: issue.number, title: issue.title, summary });
  }

  // Validate the graph with real batch issue IDs before the caller dispatches.
  const allMembers = input.items ? [...input.items] : groups.flatMap((group) => group.members);
  const contracted = contractBatchGroups(allMembers, groups, materialized);
  const claimGraph = materializeClaimDependencies(contracted as ScheduledWorkItem[]);
  validateGraph(claimGraph.items);
  return { groups, materialized, validatedItems: claimGraph.items as BatchableWorkItem[] };
}

/** Validate only; useful for dry-run confirmation and tests that assert zero writes. */
export async function revalidateBatchGroup(
  proposed: IssueBatchGroup,
  repo: string,
  host: BatchMaterializationHost,
  expectedRoutes?: ReadonlyMap<number, { targetBranch: string; lane?: string }>,
): Promise<{ members: BatchableWorkItem[]; milestone?: string }> {
  const members: BatchableWorkItem[] = [];
  let milestone: string | undefined;
  let milestoneSeen = false;
  for (const planned of proposed.members) {
    const expectedRoute = expectedRoutes?.get(planned.issue);
    if (expectedRoute && (planned.targetBranch !== expectedRoute.targetBranch || planned.lane?.kind !== undefined && planned.lane.kind !== expectedRoute.lane)) {
      throw new Error(`Cannot batch #${planned.issue}: lane evidence changed since assembly`);
    }
    const observed = await host.getIssue(planned.issue, repo);
    if (observed.state !== "OPEN") throw new Error(`Cannot batch #${planned.issue}: issue is ${observed.state.toLowerCase()}`);
    const observedMilestone = observed.milestone?.title;
    if (milestoneSeen && observedMilestone !== milestone) {
      throw new Error(`Cannot batch #${planned.issue}: members belong to different milestone lanes`);
    }
    milestoneSeen = true;
    milestone = observedMilestone;
    const affectedFiles = affectedFilesFromIssueBody(observed.body);
    const observedLabels = observed.labels ?? [];
    assertAuthoritativeEvidence(planned, observed.labels !== undefined ? observedLabels : undefined, affectedFiles, observedMilestone);
    const riskClass = inferBatchRiskClass(observed.title, observed.body, observedLabels);
    const candidate: BatchableWorkItem = {
      ...planned,
      repository: repo,
      title: observed.title,
      summary: observed.body.slice(0, 4_000),
      labels: observedLabels,
      affectedFiles,
      claims: [...new Set([...planned.claims, ...affectedFiles])],
      riskClass,
      sourceIssueUrl: observed.url,
      ...(observedMilestone ? { milestone: observedMilestone } : {}),
    };
    const exclusion = batchExclusionReason(candidate, { allowOrdinary: true });
    if (exclusion) throw new Error(`Cannot batch #${planned.issue}: authoritative GitHub evidence now reports ${exclusion}`);
    assertGroupKey(proposed, candidate, observed);
    members.push(candidate);
  }
  if (members.length < 2) throw new Error(`Batch group ${proposed.id} must contain at least two members`);
  return { members, ...(milestone ? { milestone } : {}) };
}

function assertAuthoritativeEvidence(
  planned: BatchableWorkItem,
  observedLabels: readonly string[] | undefined,
  observedFiles: readonly string[],
  observedMilestone: string | undefined,
): void {
  const normalize = (values: readonly string[]) => [...new Set(values.map((value) => value.replaceAll("\\", "/").trim()).filter(Boolean))].sort();
  if (normalize(planned.affectedFiles).join("\u0000") !== normalize(observedFiles).join("\u0000")) {
    throw new Error(`Cannot batch #${planned.issue}: authoritative affected files changed since assembly`);
  }
  if (observedLabels !== undefined && normalize(planned.labels).join("\u0000") !== normalize(observedLabels).join("\u0000")) {
    throw new Error(`Cannot batch #${planned.issue}: authoritative labels changed since assembly`);
  }
  const plannedMilestone = typeof planned.milestone === "string" ? planned.milestone : planned.milestone?.title;
  if (plannedMilestone !== observedMilestone) {
    throw new Error(`Cannot batch #${planned.issue}: authoritative milestone changed since assembly`);
  }
}

function assertGroupKey(group: IssueBatchGroup, candidate: BatchableWorkItem, observed: IssueSnapshot): void {
  const normalizedFiles = candidate.affectedFiles.map((file) => file.replaceAll("\\", "/"));
  if (group.kind === "same-file" && !normalizedFiles.includes(group.key)) {
    throw new Error(`Cannot batch #${candidate.issue}: authoritative affected files do not match ${group.key}`);
  }
  if (group.kind === "source-pr" && !new RegExp(`^\\*\\*Source\\*\\*: PR #${escapeRegExp(group.key)}\\b`, "m").test(observed.body)) {
    throw new Error(`Cannot batch #${candidate.issue}: authoritative Source PR does not match #${group.key}`);
  }
  if (group.kind === "defect-class" && !observed.body.includes(`<!-- FORGE:CLASS: ${group.key} -->`)) {
    throw new Error(`Cannot batch #${candidate.issue}: authoritative FORGE:CLASS does not match ${group.key}`);
  }
  if (group.kind === "leaf-directory") {
    const directory = normalizedFiles[0]?.slice(0, normalizedFiles[0].lastIndexOf("/"));
    if (directory !== group.key) throw new Error(`Cannot batch #${candidate.issue}: authoritative affected-file directory does not match ${group.key}`);
  }
  if (candidate.riskClass !== group.riskClass) {
    throw new Error(`Cannot batch #${candidate.issue}: authoritative risk class ${candidate.riskClass} does not match planned class ${group.riskClass}`);
  }
}

function priorityLabel(items: readonly BatchableWorkItem[]): "priority:P0" | "P0" | "priority:P1" | "P1" | "priority:P2" | "P2" | "priority:P3" | "P3" {
  for (const priority of ["P0", "P1", "P2", "P3"] as const) {
    if (items.some((item) => item.labels.some((label) => new RegExp(`^(?:priority:)?${priority}$`, "i").test(label))
      || item.priority === Number(priority.slice(1)))) return `priority:${priority}` as `priority:${typeof priority}`;
  }
  return "priority:P3";
}

function safeTitle(value: string): string {
  return value.replace(/<!--[\s\S]*?-->/g, "").replace(/[\r\n]+/g, " ").trim().slice(0, 120) || "compatible-work";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
