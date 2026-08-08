// SPDX-License-Identifier: AGPL-3.0-or-later

import { Type, type Static, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

const NonEmptyString = Type.String({ minLength: 1 });
const IsoDateTime = Type.String({ format: "date-time" });
const Sha = Type.String({ pattern: "^[0-9a-fA-F]{7,64}$" });

/** The serialized subject shape.  Inputs are accepted through normalizeSubject below. */
export const SubjectSchema = Type.Object({
  forge: Type.Literal("github"),
  repo: NonEmptyString,
  issue: Type.Optional(Type.Integer({ minimum: 1 })),
  pr: Type.Optional(Type.Integer({ minimum: 1 })),
});

export const ProducerSchema = Type.Object({
  role: NonEmptyString,
  runtime: Type.Optional(NonEmptyString),
  provider: Type.Optional(NonEmptyString),
  model: Type.Optional(NonEmptyString),
});

export const IntentPayloadSchema = Type.Object({
  title: NonEmptyString,
  problem: NonEmptyString,
  desiredOutcome: Type.Optional(Type.String()),
  constraints: Type.Array(Type.String()),
  acceptanceHints: Type.Array(Type.String()),
  dependencies: Type.Array(Type.String()),
  sourceUrl: Type.Optional(Type.String()),
  conversation: Type.Optional(Type.Array(Type.Object({
    author: NonEmptyString,
    createdAt: IsoDateTime,
    body: NonEmptyString,
    url: Type.Optional(Type.String()),
  }))),
});

export const InvestigationPayloadSchema = Type.Object({
  outcome: Type.Union([
    Type.Literal("confirmed"),
    Type.Literal("invalid"),
    Type.Literal("decompose"),
  ]),
  confidence: Type.Union([
    Type.Literal("high"),
    Type.Literal("medium"),
    Type.Literal("low"),
  ]),
  summary: NonEmptyString,
  evidence: Type.Array(Type.Object({
    claim: NonEmptyString,
    source: NonEmptyString,
    detail: NonEmptyString,
  }), { minItems: 1 }),
  rootCause: Type.Optional(Type.String()),
  affectedSurfaces: Type.Array(Type.String()),
  risks: Type.Array(Type.String()),
  recommendation: NonEmptyString,
  decomposition: Type.Optional(Type.Array(Type.Object({
    title: NonEmptyString,
    outcome: NonEmptyString,
    dependsOn: Type.Array(Type.String()),
  }), { minItems: 2 })),
});

export const BuildPacketPayloadSchema = Type.Object({
  scope: Type.Array(NonEmptyString, { minItems: 1 }),
  acceptanceCriteria: Type.Array(NonEmptyString, { minItems: 1 }),
  context: Type.Array(Type.Object({
    source: NonEmptyString,
    relevance: NonEmptyString,
  })),
  implementationPlan: Type.Array(NonEmptyString, { minItems: 1 }),
  expectedPaths: Type.Array(NonEmptyString),
  verificationPlan: Type.Array(NonEmptyString, { minItems: 1 }),
  risks: Type.Array(Type.Object({
    risk: NonEmptyString,
    mitigation: NonEmptyString,
  })),
  outOfScope: Type.Array(Type.String()),
});

export const CheckResultSchema = Type.Object({
  command: NonEmptyString,
  status: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("skipped")]),
  exitCode: Type.Optional(Type.Integer()),
  durationMs: Type.Integer({ minimum: 0 }),
  outputDigest: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
  failureSignatures: Type.Optional(Type.Array(NonEmptyString)),
  baselineStatus: Type.Optional(Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("skipped")])),
  baselineFailureSignatures: Type.Optional(Type.Array(NonEmptyString)),
  regression: Type.Optional(Type.Boolean()),
});

export const BuildResultPayloadSchema = Type.Object({
  branch: NonEmptyString,
  headSha: Sha,
  changedPaths: Type.Array(NonEmptyString),
  summary: NonEmptyString,
  acceptanceEvidence: Type.Array(Type.Object({
    criterion: NonEmptyString,
    status: Type.Union([Type.Literal("passed"), Type.Literal("failed")]),
    evidence: NonEmptyString,
  })),
  checks: Type.Array(CheckResultSchema),
  decisions: Type.Array(Type.String()),
  residualRisks: Type.Array(Type.String()),
});

export const FindingSchema = Type.Object({
  id: NonEmptyString,
  severity: Type.Union([
    Type.Literal("critical"),
    Type.Literal("high"),
    Type.Literal("medium"),
    Type.Literal("low"),
  ]),
  confidence: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
  blocking: Type.Boolean(),
  title: NonEmptyString,
  evidence: NonEmptyString,
  location: Type.Optional(NonEmptyString),
  intentRelevance: NonEmptyString,
  remediation: NonEmptyString,
});

export const ReviewVerdictPayloadSchema = Type.Object({
  headSha: Sha,
  disposition: Type.Union([
    Type.Literal("approve"),
    Type.Literal("request_changes"),
    Type.Literal("blocked"),
  ]),
  reviewerRoles: Type.Array(NonEmptyString, { minItems: 1 }),
  findings: Type.Array(FindingSchema),
  checks: Type.Array(CheckResultSchema),
  supersedes: Type.Optional(NonEmptyString),
});

export const OutcomePayloadSchema = Type.Object({
  status: Type.Union([
    Type.Literal("merged"),
    Type.Literal("invalid"),
    Type.Literal("decomposed"),
    Type.Literal("blocked"),
    Type.Literal("failed"),
    Type.Literal("abandoned"),
  ]),
  reason: NonEmptyString,
  finalSha: Type.Optional(Sha),
  prUrl: Type.Optional(Type.String()),
  childIssues: Type.Array(Type.String()),
  batchParent: Type.Optional(Type.Integer({ minimum: 1 })),
  failureEvidence: Type.Optional(Type.Object({
    branch: NonEmptyString,
    workspacePath: NonEmptyString,
    builderSummary: NonEmptyString,
    changedPaths: Type.Array(NonEmptyString),
    checks: Type.Array(CheckResultSchema),
  })),
});

export const ArtifactPayloadSchemas = {
  Intent: IntentPayloadSchema,
  Investigation: InvestigationPayloadSchema,
  BuildPacket: BuildPacketPayloadSchema,
  BuildResult: BuildResultPayloadSchema,
  ReviewVerdict: ReviewVerdictPayloadSchema,
  Outcome: OutcomePayloadSchema,
} as const satisfies Record<string, TSchema>;

export type ArtifactKind = keyof typeof ArtifactPayloadSchemas;
export type CanonicalSubject = Static<typeof SubjectSchema>;
/** Legacy-compatible subject input used by ports and old run fixtures. */
export interface Subject {
  repo: string;
  forge?: string;
  issue?: number;
  pr?: number;
}
export type SubjectInput = Subject;
export type Producer = Static<typeof ProducerSchema>;
export type IntentPayload = Static<typeof IntentPayloadSchema>;
export type InvestigationPayload = Static<typeof InvestigationPayloadSchema>;
export type BuildPacketPayload = Static<typeof BuildPacketPayloadSchema>;
export type BuildResultPayload = Static<typeof BuildResultPayloadSchema>;
export type ReviewVerdictPayload = Static<typeof ReviewVerdictPayloadSchema>;
export type OutcomePayload = Static<typeof OutcomePayloadSchema>;

export interface ArtifactPayloadByKind {
  Intent: IntentPayload;
  Investigation: InvestigationPayload;
  BuildPacket: BuildPacketPayload;
  BuildResult: BuildResultPayload;
  ReviewVerdict: ReviewVerdictPayload;
  Outcome: OutcomePayload;
}

/** Normalize the legacy raw subject form at every ingress boundary. */
export function normalizeSubject(input: unknown): CanonicalSubject {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Subject must be an object");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["forge", "repo", "issue", "pr"].includes(key))) throw new Error("Subject contains unknown fields");
  if (value.forge !== undefined && value.forge !== "github") throw new Error("Unsupported subject forge");
  if (typeof value.repo !== "string") throw new Error("Subject repository is required");
  const repo = value.repo.trim().toLowerCase();
  const parts = repo.split("/");
  if (parts.length !== 2 || parts.some((part) => !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(part))) {
    throw new Error("Subject repository must be a GitHub owner/name identity");
  }
  const result: { forge: "github"; repo: string; issue?: number; pr?: number } = { forge: "github", repo };
  for (const field of ["issue", "pr"] as const) {
    const number = value[field];
    if (number === undefined) continue;
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
      throw new Error(`Subject ${field} must be a positive safe integer`);
    }
    result[field] = number;
  }
  if (result.issue === undefined && result.pr === undefined) throw new Error("Subject must identify an issue or pull request");
  return result;
}

/** Stable, collision-free identity for a canonical subject. */
export function subjectIdentityKey(input: SubjectInput | CanonicalSubject): string {
  const subject = normalizeSubject(input);
  return JSON.stringify([subject.forge, subject.repo, subject.issue ?? null, subject.pr ?? null]);
}

/** Backwards-friendly name for callers that persist a subject index. */
export const subjectKey = subjectIdentityKey;

function isCanonicalSubject(value: unknown): value is CanonicalSubject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const subject = value as Record<string, unknown>;
  if (Object.keys(subject).some((key) => !["forge", "repo", "issue", "pr"].includes(key))) return false;
  const validIssue = subject.issue === undefined || (typeof subject.issue === "number" && Number.isSafeInteger(subject.issue) && subject.issue > 0);
  const validPr = subject.pr === undefined || (typeof subject.pr === "number" && Number.isSafeInteger(subject.pr) && subject.pr > 0);
  const hasTarget = subject.issue !== undefined || subject.pr !== undefined;
  return subject.forge === "github"
    && typeof subject.repo === "string"
    && subject.repo === subject.repo.trim().toLowerCase()
    && subject.repo.split("/").length === 2
    && subject.repo.split("/").every((part) => /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(part))
    && hasTarget && validIssue && validPr;
}

export function normalizeArtifact(value: unknown): DurableArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Artifact must be an object");
  const candidate = value as Record<string, unknown>;
  const normalized = { ...candidate, subject: normalizeSubject(candidate.subject) };
  assertArtifact(normalized);
  return normalized;
}

export type DurableArtifact<K extends ArtifactKind = ArtifactKind> = K extends ArtifactKind ? {
  schema: "forgedock.artifact/v2";
  kind: K;
  id: string;
  runId: string;
  subject: CanonicalSubject;
  createdAt: string;
  producer: Producer;
  payload: ArtifactPayloadByKind[K];
} : never;

export type ArtifactInput<K extends ArtifactKind> = K extends ArtifactKind ? {
  kind: K;
  runId: string;
  subject: SubjectInput;
  producer: Producer;
  payload: ArtifactPayloadByKind[K];
} : never;

export function createArtifact<K extends ArtifactKind>(
  input: ArtifactInput<K>,
  options: { id?: string; createdAt?: string } = {},
): DurableArtifact<K> {
  const artifact = {
    schema: "forgedock.artifact/v2",
    kind: input.kind,
    id: options.id ?? `art_${crypto.randomUUID()}`,
    runId: input.runId,
    subject: normalizeSubject(input.subject),
    createdAt: options.createdAt ?? new Date().toISOString(),
    producer: input.producer,
    payload: input.payload,
  } as DurableArtifact<K>;
  assertArtifact(artifact);
  return artifact;
}

export function assertArtifact(value: unknown): asserts value is DurableArtifact {
  if (!value || typeof value !== "object") throw new Error("Artifact must be an object");
  const candidate = value as Partial<DurableArtifact>;
  if (candidate.schema !== "forgedock.artifact/v2") throw new Error("Unsupported artifact schema");
  if (!candidate.kind || !(candidate.kind in ArtifactPayloadSchemas)) throw new Error("Unknown artifact kind");
  if (typeof candidate.id !== "string" || !candidate.id) throw new Error("Artifact id is required");
  if (typeof candidate.runId !== "string" || !candidate.runId) throw new Error("Artifact runId is required");
  if (!isCanonicalSubject(candidate.subject) || !Check(SubjectSchema, candidate.subject)) {
    throw validationError("subject", SubjectSchema, candidate.subject);
  }
  if (!Check(ProducerSchema, candidate.producer)) throw validationError("producer", ProducerSchema, candidate.producer);
  if (typeof candidate.createdAt !== "string" || Number.isNaN(Date.parse(candidate.createdAt))) {
    throw new Error("Artifact createdAt must be an ISO timestamp");
  }
  const payloadSchema = ArtifactPayloadSchemas[candidate.kind];
  if (!Check(payloadSchema, candidate.payload)) throw validationError("payload", payloadSchema, candidate.payload);
}

function validationError(label: string, schema: TSchema, value: unknown): Error {
  const details = [...Errors(schema, value)].slice(0, 5).map((error) => error.message);
  return new Error(`Invalid artifact ${label}: ${details.join("; ")}`);
}
