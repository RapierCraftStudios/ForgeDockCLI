// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import type { BuildPacketPayload, InvariantMatrixRow } from "../../core/artifacts/schema.js";

const CAPABILITIES: ReadonlyArray<{
  capability: InvariantMatrixRow["capability"];
  pattern: RegExp;
  dimensions: InvariantMatrixRow["dimensions"];
}> = [
  {
    capability: "redaction-grammar",
    pattern: /redact|credential|secret|password|token|marker|userinfo/i,
    dimensions: [
      { name: "grammar", values: ["key-value", "command-line", "json-assignment", "url-userinfo"] },
      { name: "marker", values: ["plain", "numbered", "variant", "quoted-adjacent"] },
      { name: "delimiter", values: ["end", "whitespace", "punctuation", "suffix"] },
    ],
  },
  {
    capability: "chunk-boundary",
    pattern: /chunk|split|fragment|continuation|stream|osc|c1|esc/i,
    dimensions: [
      { name: "split", values: ["before-assignment", "inside-key", "before-value", "inside-marker", "after-marker"] },
      { name: "channel", values: ["stdout", "stderr", "interleaved"] },
    ],
  },
  {
    capability: "adapter-lifecycle",
    pattern: /adapter|producer|lifecycle|cleanup|recreat|terminal/i,
    dimensions: [
      { name: "lifecycle", values: ["construct", "emit", "refresh", "terminal-cleanup", "recreate"] },
      { name: "owner", values: ["explicit", "default", "interleaved"] },
    ],
  },
  {
    capability: "identity-isolation",
    pattern: /identity|session|nodeid|pisession|collision|isolation|interleav/i,
    dimensions: [
      { name: "identity-field", values: ["run", "work-unit", "task", "node", "session", "producer", "channel"] },
      { name: "interaction", values: ["same-stream", "cross-stream", "terminal-other-stream"] },
    ],
  },
  {
    capability: "terminal-metadata",
    pattern: /terminal|completed|failed|cancelled|metadata|ordering/i,
    dimensions: [
      { name: "terminal", values: ["successful", "failed", "cancelled"] },
      { name: "invariant", values: ["metadata", "ordering", "cleanup", "suppression"] },
    ],
  },
];

/** Derive typed matrices from criterion semantics; no issue number or fixture is special-cased. */
export function deriveSecurityInvariantMatrices(
  packet: Pick<BuildPacketPayload, "acceptanceCriteria" | "risks">,
): InvariantMatrixRow[] {
  const securityContext = packet.risks.some(({ risk, mitigation }) => /security|auth|credential|secret|redact|identity|isolation/i.test(`${risk}\n${mitigation}`));
  if (!securityContext) return [];
  return packet.acceptanceCriteria.flatMap((criterion, index) => CAPABILITIES.flatMap((definition) => {
    if (!definition.pattern.test(criterion)) return [];
    const criterionId = `criterion-${index + 1}`;
    const digest = createHash("sha256").update(`${criterionId}\n${definition.capability}\n${criterion}`).digest("hex").slice(0, 12);
    const id = `matrix-${definition.capability}-${digest}`;
    return [{ id, criterionId, capability: definition.capability, dimensions: definition.dimensions.map((dimension) => ({ ...dimension, values: [...dimension.values] })), testId: `invariant:${id}` }];
  }));
}

/** Deterministically expand a row into named acceptance cases with a hard bound. */
export function expandInvariantMatrix(row: InvariantMatrixRow, maximumCases = 128): Array<{ id: string; values: Record<string, string> }> {
  if (!Number.isSafeInteger(maximumCases) || maximumCases < 1) throw new Error("Invariant matrix maximumCases must be a positive safe integer");
  let cases: Array<Record<string, string>> = [{}];
  for (const dimension of row.dimensions) {
    const nextCaseCount = cases.length * dimension.values.length;
    if (nextCaseCount > maximumCases) throw new Error(`Invariant matrix ${row.id} expands beyond ${maximumCases} cases`);
    cases = cases.flatMap((entry) => dimension.values.map((value) => ({ ...entry, [dimension.name]: value })));
  }
  return cases.map((values, index) => ({ id: `${row.testId}:case-${String(index + 1).padStart(3, "0")}`, values }));
}

/** Return every durable matrix test ID, including the row test and all expanded cases. */
export function invariantMatrixCaseIds(rows: readonly InvariantMatrixRow[]): string[] {
  return rows.flatMap((row) => [row.testId, ...expandInvariantMatrix(row).map(({ id }) => id)]);
}

/** Stable row/test/case identity projection used by evidence contracts. */
export function invariantMatrixIdentities(rows: readonly InvariantMatrixRow[]): {
  rowIds: string[];
  testIds: string[];
  caseIds: string[];
} {
  return {
    rowIds: rows.map(({ id }) => id),
    testIds: rows.map(({ testId }) => testId),
    caseIds: rows.flatMap((row) => expandInvariantMatrix(row).map(({ id }) => id)),
  };
}
