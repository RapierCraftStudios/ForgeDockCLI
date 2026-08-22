// SPDX-License-Identifier: AGPL-3.0-or-later

import { normalizeOrchestrationRepository, orchestrationIssueIdentityKey } from "../../core/ports/orchestration.js";

export interface DecompositionDependencyNodeIdentity {
  id: string;
  issue: number;
  repository: string;
  memberIssues?: readonly number[];
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
  childRepository: string,
): string[] {
  const effectiveChildRepository = normalizeOrchestrationRepository(childRepository);
  const issueToNode = new Map<string, string>();
  const identityKey = (repository: string, issue: number) =>
    orchestrationIssueIdentityKey({ repository, issue });
  for (const node of nodes) {
    const effectiveRepository = normalizeOrchestrationRepository(node.repository);
    for (const issue of new Set([node.issue, ...(node.memberIssues ?? [])])) {
      const key = identityKey(effectiveRepository, issue);
      const existing = issueToNode.get(key);
      if (existing !== undefined && existing !== node.id) {
        throw new Error(`Cannot map decomposition prerequisite #${issue} in ${effectiveRepository}: it is represented by both ${existing} and ${node.id}`);
      }
      issueToNode.set(key, node.id);
    }
  }

  const dependencies = dependencyIssueNumbersFromBody(body);
  const missing = dependencies.filter((issue) => !issueToNode.has(identityKey(effectiveChildRepository, issue)));
  if (missing.length) {
    throw new Error(
      `Decomposition child #${childIssue} in ${effectiveChildRepository} has prerequisites outside the frozen orchestration DAG: ${missing.map((issue) => `#${issue}`).join(", ")}`,
    );
  }
  const childNode = issueToNode.get(identityKey(effectiveChildRepository, childIssue));
  const mapped = [...new Set(dependencies.map((issue) => issueToNode.get(identityKey(effectiveChildRepository, issue))!))];
  if (childNode !== undefined && mapped.includes(childNode)) {
    throw new Error(`Decomposition child #${childIssue} in ${effectiveChildRepository} cannot depend on itself`);
  }
  return mapped;
}
