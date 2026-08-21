// SPDX-License-Identifier: AGPL-3.0-or-later

import { normalizeOrchestrationRepository } from "../../core/ports/orchestration.js";

export interface DecompositionDependencyNodeIdentity {
  id: string;
  issue: number;
  memberIssues?: readonly number[];
}

/**
 * Stable identity for a decomposition child. Standalone/root work keeps its
 * historical `issue-<number>` identity; only replacement children carry the
 * repository that owns them.
 */
export function decompositionChildNodeId(repository: string, issue: number): string {
  const normalizedRepository = normalizeOrchestrationRepository(repository);
  if (!normalizedRepository) throw new Error("Decomposition child repository must not be empty");
  if (!Number.isSafeInteger(issue) || issue < 1) throw new Error(`Invalid decomposition child issue: ${issue}`);
  return `issue-${encodeURIComponent(normalizedRepository)}-${issue}`;
}

/**
 * Mutable route state must use the same repository-qualified identity as the
 * materialized child node, while retaining a distinct key for legacy roots.
 */
export function decompositionIssueRouteKey(repository: string, issue: number): string {
  const normalizedRepository = normalizeOrchestrationRepository(repository);
  if (!normalizedRepository) throw new Error("Issue route repository must not be empty");
  if (!Number.isSafeInteger(issue) || issue < 1) throw new Error(`Invalid issue route issue: ${issue}`);
  return `${normalizedRepository}#${issue}`;
}

export interface ParsedDecompositionNodeId {
  issue: number;
  repository?: string;
}

/** Accept both pre-qualified root IDs and repository-qualified child IDs. */
export function parseDecompositionNodeId(id: string): ParsedDecompositionNodeId {
  const legacy = /^issue-(\d+)$/.exec(id);
  if (legacy) return { issue: Number(legacy[1]) };
  if (!id.startsWith("issue-")) throw new Error(`Invalid issue dependency id: ${id}`);
  const separator = id.lastIndexOf("-");
  const encodedRepository = id.slice("issue-".length, separator);
  const issueText = id.slice(separator + 1);
  const issue = Number(issueText);
  if (!encodedRepository || !/^\d+$/.test(issueText) || !Number.isSafeInteger(issue) || issue < 1) {
    throw new Error(`Invalid issue dependency id: ${id}`);
  }
  let repository: string;
  try {
    repository = decodeURIComponent(encodedRepository);
  } catch {
    throw new Error(`Invalid issue dependency id: ${id}`);
  }
  const normalizedRepository = normalizeOrchestrationRepository(repository);
  if (!normalizedRepository || normalizedRepository !== repository || encodeURIComponent(repository) !== encodedRepository) {
    throw new Error(`Invalid issue dependency id: ${id}`);
  }
  return { repository, issue };
}

export function issueNumberFromDecompositionNodeId(id: string): number {
  return parseDecompositionNodeId(id).issue;
}

export function dependencyIssueNumbersFromBody(body: string): number[] {
  const section = /(?:^|\n)#{2,6}\s+(?:dependencies|prerequisites|blocked by)\s*\n([\s\S]*?)(?=\n#{2,6}\s|$)/i.exec(body)?.[1];
  if (!section) return [];
  return [...new Set([...section.matchAll(/(?<![A-Za-z0-9])#(\d+)\b/g)]
    .map((match) => Number(match[1]))
    .filter((issue) => Number.isSafeInteger(issue) && issue > 0))].sort((left, right) => left - right);
}

export function mapDecompositionDependencies(
  childIssue: number,
  body: string,
  nodes: readonly DecompositionDependencyNodeIdentity[],
): string[] {
  const issueToNode = new Map<number, string>();
  for (const node of nodes) {
    for (const issue of new Set([node.issue, ...(node.memberIssues ?? [])])) {
      const existing = issueToNode.get(issue);
      if (existing !== undefined && existing !== node.id) {
        throw new Error(`Cannot map decomposition prerequisite #${issue}: it is represented by both ${existing} and ${node.id}`);
      }
      issueToNode.set(issue, node.id);
    }
  }

  const dependencies = dependencyIssueNumbersFromBody(body);
  const missing = dependencies.filter((issue) => !issueToNode.has(issue));
  if (missing.length) {
    throw new Error(
      `Decomposition child #${childIssue} has prerequisites outside the frozen orchestration DAG: ${missing.map((issue) => `#${issue}`).join(", ")}`,
    );
  }
  const childNode = issueToNode.get(childIssue);
  const mapped = [...new Set(dependencies.map((issue) => issueToNode.get(issue)!))];
  if (childNode !== undefined && mapped.includes(childNode)) {
    throw new Error(`Decomposition child #${childIssue} cannot depend on itself`);
  }
  return mapped;
}
