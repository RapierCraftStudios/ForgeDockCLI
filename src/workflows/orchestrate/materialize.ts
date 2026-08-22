// SPDX-License-Identifier: AGPL-3.0-or-later

import type { IssueSnapshot } from "../../core/ports/forge-host.js";
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
import { investigationReleaseIsSettled, orchestrationIssueIdentityKey, type InvestigationReleaseReceipt } from "../../core/ports/orchestration.js";
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
  closeIssue(repo: string, issue: number, reason: string): Promise<void>;
}

type ExpectedRoute = { targetBranch: string; lane?: "fast" | "feature"; promotionTarget?: string; productionTarget?: string };
type ExpectedRoutes = ReadonlyMap<string, ExpectedRoute> | ReadonlyMap<number, ExpectedRoute>;

export interface MaterializeBatchGroupsInput {
  repo: string;
  groups: readonly IssueBatchGroup[];
  host: BatchMaterializationHost;
  /** Full selected plan used for external dependency remapping. */
  items?: readonly BatchableWorkItem[];
  /** Optional authoritative lane snapshot keyed by normalized repository plus issue. */
  expectedRoutes?: ExpectedRoutes;
  /** Controller admission is a required precondition for mutating hosts. */
  investigationRelease?: InvestigationReleaseReceipt;
  /** Revalidate captured refs immediately before the first external write. */
  revalidateInvestigationRelease?: (receipt: Readonly<InvestigationReleaseReceipt>) => Promise<void>;
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
  if (input.investigationRelease) {
    investigationReleaseIsSettled(input.investigationRelease, input.items
      ? input.items.flatMap((item) => [item.issue, ...(item.memberIssues ?? [])])
      : input.groups.flatMap((group) => group.members.map((member) => member.issue)));
    await input.revalidateInvestigationRelease?.(structuredClone(input.investigationRelease));
  }
  const groups: IssueBatchGroup[] = [];
  const materialized: MaterializedBatchIssue[] = [];
  const createdIssues: Array<{ repo: string; issue: number }> = [];
  try {
    for (const proposed of input.groups) {
      const validated = await revalidateBatchGroup(proposed, input.repo, input.host, input.expectedRoutes);
      const members = validated.members;
      const priority = priorityLabel(members);
      const title = `fix(batch): ${members.length} ${priority.slice(-2)} findings — ${safeTitle(proposed.key)}`.slice(0, 240);
      const summary = `Deliver ${members.map((member) => `#${member.issue}`).join(", ")} as one ${proposed.kind} work unit.`;
      const materializationRepository = members[0]?.repository ?? input.repo;
      const issue = await input.host.materializeBatchIssue({
        repo: materializationRepository,
        title,
        body: renderBatchIssueBody({ ...proposed, members }),
        priorityLabel: priority,
        ...(validated.milestone ? { milestone: validated.milestone } : {}),
      });
      groups.push({ ...proposed, members });
      materialized.push({ groupId: proposed.id, issue: issue.number, title: issue.title, summary });
      createdIssues.push({ repo: materializationRepository, issue: issue.number });
    }

    // Validate the graph with real batch issue IDs before the caller dispatches.
    const allMembers = input.items ? [...input.items] : groups.flatMap((group) => group.members);
    const contracted = contractBatchGroups(allMembers, groups, materialized);
    const claimGraph = materializeClaimDependencies(contracted as ScheduledWorkItem[]);
    validateGraph(claimGraph.items);
    return { groups, materialized, validatedItems: claimGraph.items as BatchableWorkItem[] };
  } catch (error) {
    const cleanup = await Promise.allSettled(createdIssues.map(({ repo, issue }) => input.host.closeIssue(
      repo,
      issue,
      "ForgeDock closed this provisional batch issue because pre-dispatch validation failed; no controller was dispatched.",
    )));
    const failures = cleanup.flatMap((result, index) => result.status === "rejected"
      ? [{ issue: createdIssues[index]!.issue, error: result.reason }]
      : []);
    if (failures.length) {
      const orphaned = failures.map(({ issue }) => `#${issue}`).join(", ");
      throw new AggregateError(
        [
          error,
          ...failures.map(({ issue, error: cleanupError }) => new Error(
            `Failed to close provisional batch issue #${issue}`,
            { cause: cleanupError },
          )),
        ],
        `Batch validation failed and provisional issues ${orphaned} could not be closed; manual cleanup is required`,
      );
    }
    throw error;
  }
}

/** Validate only; useful for dry-run confirmation and tests that assert zero writes. */
export async function revalidateBatchGroup(
  proposed: IssueBatchGroup,
  repo: string,
  host: BatchMaterializationHost,
  expectedRoutes?: ExpectedRoutes,
): Promise<{ members: BatchableWorkItem[]; milestone?: string }> {
  const members: BatchableWorkItem[] = [];
  let milestone: string | undefined;
  let milestoneSeen = false;
  for (const planned of proposed.members) {
    const plannedRepository = planned.repository ?? repo;
    const expectedRoute = expectedRouteFor(expectedRoutes, plannedRepository, planned.issue, repo);
    if (expectedRoute && (planned.targetBranch !== expectedRoute.targetBranch
      || planned.lane !== undefined && planned.lane !== expectedRoute.lane
      || planned.promotionTarget !== expectedRoute.promotionTarget
      || planned.productionTarget !== expectedRoute.productionTarget)) {
      throw new Error(`Cannot batch #${planned.issue}: lane evidence changed since assembly`);
    }
    const observed = await host.getIssue(planned.issue, plannedRepository);
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
      repository: plannedRepository,
      title: observed.title,
      summary: observed.body.slice(0, 4_000),
      labels: observedLabels,
      affectedFiles,
      claims: [...new Set([...planned.claims, ...affectedFiles])],
      riskClass,
      ...(planned.targetBranch !== undefined ? { targetBranch: planned.targetBranch } : {}),
      ...(planned.lane !== undefined ? { lane: planned.lane } : {}),
      ...(planned.promotionTarget !== undefined ? { promotionTarget: planned.promotionTarget } : {}),
      ...(planned.productionTarget !== undefined ? { productionTarget: planned.productionTarget } : {}),
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

function expectedRouteFor(
  routes: ExpectedRoutes | undefined,
  repository: string,
  issue: number,
  legacyRepository: string,
): ExpectedRoute | undefined {
  if (!routes) return undefined;
  const qualified = (routes as ReadonlyMap<string, ExpectedRoute>).get(orchestrationIssueIdentityKey({ repository, issue }));
  if (qualified) return qualified;
  // The numeric branch is retained only for the legacy TUI adapter, whose
  // caller is root-repository-only. Never apply it to a foreign scheduled
  // repository, where it could alias an equal issue number.
  if (repository.trim().toLowerCase() !== legacyRepository.trim().toLowerCase()) return undefined;
  return (routes as ReadonlyMap<number, ExpectedRoute>).get(issue);
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
  if (group.kind === "source-pr" && !new RegExp(`^\\*\\*Source(?::\\*\\*|\\*\\*:)\\s*PR #${escapeRegExp(group.key)}\\b`, "m").test(observed.body)) {
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
  let sanitized = value;
  let previous: string;
  do {
    previous = sanitized;
    sanitized = stripHtmlComments(sanitized)
      .replaceAll("--!>", "")
      .replaceAll("-->", "");
  } while (sanitized !== previous);
  return sanitized.replace(/[\r\n]+/g, " ").trim().slice(0, 120) || "compatible-work";
}

function stripHtmlComments(value: string): string {
  let result = "";
  let cursor = 0;
  while (cursor < value.length) {
    const opener = value.indexOf("<!--", cursor);
    if (opener === -1) {
      result += value.slice(cursor);
      break;
    }
    result += value.slice(cursor, opener);
    let close = value.indexOf("-->", opener + 4);
    let closeLength = 3;
    const alternateClose = value.indexOf("--!>", opener + 4);
    if (alternateClose !== -1 && (close === -1 || alternateClose < close)) {
      close = alternateClose;
      closeLength = 4;
    }
    if (close === -1) break;
    cursor = close + closeLength;
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
