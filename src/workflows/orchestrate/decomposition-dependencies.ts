// SPDX-License-Identifier: AGPL-3.0-or-later

export interface DecompositionDependencyNodeIdentity {
  id: string;
  issue: number;
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
