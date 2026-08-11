// SPDX-License-Identifier: AGPL-3.0-or-later

import { Type, type Static, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

const NonEmptyString = Type.String({ minLength: 1 });
const IsoDateTime = Type.String({ format: "date-time" });
const Sha = Type.String({ pattern: "^[0-9a-fA-F]{7,64}$" });
const ForgeHost = Type.String({ pattern: "^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$" });
const Repository = Type.String({ pattern: "^[^/\\s]+/[^/\\s]+$" });
const Locator = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });

/** The durable, normalized subject shape. */
export const SubjectSchema = Type.Object({
  forge: ForgeHost,
  repo: Repository,
  issue: Type.Optional(Locator),
  pr: Type.Optional(Locator),
});

/** The pre-forge-qualified shape used by forgedock.artifact/v2 comments. */
export const LegacySubjectSchema = Type.Object({
  repo: NonEmptyString,
  issue: Type.Optional(Locator),
  pr: Type.Optional(Locator),
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

export const ControllerVerificationGateIdSchema = Type.Union([
  Type.Literal("staging-review"),
  Type.Literal("workflow-lifecycle"),
  Type.Literal("review-aggregation"),
  Type.Literal("publication"),
  Type.Literal("merge-closure"),
]);

export const ControllerVerificationGateSchema = Type.Object({
  id: ControllerVerificationGateIdSchema,
  description: NonEmptyString,
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
  /** Typed controller-owned gates; legacy prose remains readable for old packets. */
  controllerGates: Type.Optional(Type.Array(ControllerVerificationGateSchema)),
  risks: Type.Array(Type.Object({
    risk: NonEmptyString,
    mitigation: NonEmptyString,
  })),
  outOfScope: Type.Array(Type.String()),
});

export const CheckResultSchema = Type.Object({
  command: NonEmptyString,
  planId: Type.Optional(NonEmptyString),
  coveredBy: Type.Optional(Type.Array(NonEmptyString)),
  status: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("skipped")]),
  exitCode: Type.Optional(Type.Integer()),
  durationMs: Type.Integer({ minimum: 0 }),
  outputDigest: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
  failureSignatures: Type.Optional(Type.Array(NonEmptyString)),
  failureClass: Type.Optional(Type.Union([
    Type.Literal("command"),
    Type.Literal("infrastructure"),
    Type.Literal("timeout"),
  ])),
  baselineStatus: Type.Optional(Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("skipped")])),
  baselineFailureSignatures: Type.Optional(Type.Array(NonEmptyString)),
  regression: Type.Optional(Type.Boolean()),
});

export const BuildResultPayloadSchema = Type.Object({
  branch: NonEmptyString,
  targetBranch: Type.Optional(NonEmptyString),
  headSha: Sha,
  baseSha: Type.Optional(Sha),
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
  sourceFindingIds: Type.Optional(Type.Array(NonEmptyString, { minItems: 1 })),
  sourceSessionRefs: Type.Optional(Type.Array(NonEmptyString, { minItems: 1 })),
  reviewerRoles: Type.Optional(Type.Array(NonEmptyString, { minItems: 1 })),
  /** Reviewer-declared semantic relationship to the frozen Build Packet. */
  scopeDisposition: Type.Optional(Type.Union([
    Type.Literal("in_scope"), Type.Literal("follow_up"), Type.Literal("rejected"),
  ])),
  scopeRationale: Type.Optional(NonEmptyString),
  matchedAcceptanceCriteria: Type.Optional(Type.Array(NonEmptyString)),
  matchedPriorFindingIds: Type.Optional(Type.Array(NonEmptyString)),
  introducedByRemediation: Type.Optional(Type.Boolean()),
});

const ReviewerRoleSchema = Type.Union([
  Type.Literal("correctness"), Type.Literal("security"), Type.Literal("data"),
  Type.Literal("api-compatibility"), Type.Literal("frontend"), Type.Literal("infrastructure"), Type.Literal("concurrency"),
]);
const SpecialistReviewerRoleSchema = Type.Union([
  Type.Literal("security"), Type.Literal("data"), Type.Literal("api-compatibility"),
  Type.Literal("frontend"), Type.Literal("infrastructure"), Type.Literal("concurrency"),
]);

export const ReviewPlanSchema = Type.Object({
  riskTier: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical")]),
  specialistBudget: Type.Integer({ minimum: 1, maximum: 6 }),
  selected: Type.Array(Type.Object({
    role: ReviewerRoleSchema,
    score: Type.Integer({ minimum: 0 }),
    reasons: Type.Array(NonEmptyString, { minItems: 1 }),
    scope: Type.Array(NonEmptyString),
    required: Type.Boolean(),
  }), { minItems: 1 }),
  skipped: Type.Array(Type.Object({
    role: SpecialistReviewerRoleSchema,
    score: Type.Integer({ minimum: 0 }),
    reason: Type.Union([Type.Literal("below-threshold"), Type.Literal("panel-budget"), Type.Literal("overlapping-coverage")]),
    evidence: Type.Array(NonEmptyString),
  })),
});

export const ReviewVerdictPayloadSchema = Type.Object({
  headSha: Sha,
  headBranch: Type.Optional(NonEmptyString),
  baseBranch: Type.Optional(NonEmptyString),
  disposition: Type.Union([
    Type.Literal("approve"),
    Type.Literal("request_changes"),
    Type.Literal("blocked"),
  ]),
  reviewerRoles: Type.Array(NonEmptyString, { minItems: 1 }),
  findings: Type.Array(FindingSchema),
  checks: Type.Array(CheckResultSchema),
  reviewPlan: Type.Optional(ReviewPlanSchema),
  scopeAdjudication: Type.Optional(Type.Object({
    sessionRef: NonEmptyString,
    decisions: Type.Array(Type.Object({
      findingId: NonEmptyString,
      disposition: Type.Union([Type.Literal("accept"), Type.Literal("follow_up"), Type.Literal("reject")]),
      rationale: NonEmptyString,
    })),
  })),
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
  /** Invalid outcomes are provisional until the controller proves issue closure. */
  issueClosure: Type.Optional(Type.Object({
    status: Type.Union([Type.Literal("pending"), Type.Literal("completed")]),
    repo: NonEmptyString,
    issue: Type.Integer({ minimum: 1 }),
    verifiedAt: Type.Optional(IsoDateTime),
  })),
  finalSha: Type.Optional(Sha),
  prUrl: Type.Optional(Type.String()),
  childIssues: Type.Array(Type.String()),
  batchParent: Type.Optional(Type.Integer({ minimum: 1 })),
  failureEvidence: Type.Optional(Type.Object({
    branch: NonEmptyString,
    workspacePath: NonEmptyString,
    baseRef: Type.Optional(NonEmptyString),
    targetBranch: Type.Optional(NonEmptyString),
    baseSha: Type.Optional(Sha),
    builderSummary: NonEmptyString,
    changedPaths: Type.Array(NonEmptyString),
    criterionCoverage: Type.Optional(Type.Array(Type.Object({
      criterionId: Type.Optional(Type.String({ pattern: "^criterion-[1-9][0-9]*$" })),
      criterion: NonEmptyString,
      implementation: NonEmptyString,
    }))),
    decisions: Type.Optional(Type.Array(Type.String())),
    residualRisks: Type.Optional(Type.Array(Type.String())),
    repairAttempt: Type.Optional(Type.Integer({ minimum: 1 })),
    checks: Type.Array(CheckResultSchema),
  })),
});

export const VerificationAdjudicationPayloadSchema = Type.Object({
  checkpoint: Type.Literal("verification"),
  decision: Type.Literal("resume"),
  supersedesOutcomeId: NonEmptyString,
  reason: NonEmptyString,
});

export const RemediationBlockedPayloadSchema = Type.Object({
  checkpointKey: NonEmptyString,
  checkpointSequence: Type.Integer({ minimum: 1 }),
  status: Type.Union([
    Type.Literal("awaiting-dispatch"), Type.Literal("children-running"),
    Type.Literal("ready-to-resume"), Type.Literal("terminal"),
  ]),
  parentRunId: NonEmptyString,
  parentIssue: Type.Integer({ minimum: 1 }),
  pullRequest: Type.Integer({ minimum: 1 }),
  headSha: Sha,
  headBranch: NonEmptyString,
  baseBranch: NonEmptyString,
  packetArtifactId: NonEmptyString,
  verdictArtifactId: NonEmptyString,
  reason: Type.Union([Type.Literal("scope-violation"), Type.Literal("remediation-budget")]),
  findings: Type.Array(Type.Object({
    id: NonEmptyString,
    severity: Type.Union([Type.Literal("critical"), Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
    title: NonEmptyString,
    evidence: NonEmptyString,
    location: Type.Optional(NonEmptyString),
    remediation: NonEmptyString,
    acceptanceCriterion: Type.Optional(NonEmptyString),
  })),
  childIssues: Type.Array(Type.Integer({ minimum: 1 })),
  childRunIds: Type.Array(NonEmptyString),
  approvedPaths: Type.Array(NonEmptyString),
  childOutcomeIds: Type.Array(NonEmptyString),
  childFinalShas: Type.Optional(Type.Array(Sha)),
  remediationDepth: Type.Integer({ minimum: 0 }),
  maxRemediationDepth: Type.Integer({ minimum: 0 }),
  maxRemediationChildren: Type.Optional(Type.Integer({ minimum: 1 })),
});

export const ArtifactPayloadSchemas = {
  Intent: IntentPayloadSchema,
  Investigation: InvestigationPayloadSchema,
  BuildPacket: BuildPacketPayloadSchema,
  BuildResult: BuildResultPayloadSchema,
  ReviewVerdict: ReviewVerdictPayloadSchema,
  Outcome: OutcomePayloadSchema,
  VerificationAdjudication: VerificationAdjudicationPayloadSchema,
  RemediationBlocked: RemediationBlockedPayloadSchema,
} as const satisfies Record<string, TSchema>;

export type ArtifactKind = keyof typeof ArtifactPayloadSchemas;
/** Inputs remain forge-optional so old GitHub callers can be upgraded at the boundary. */
export type Subject = Omit<Static<typeof SubjectSchema>, "forge"> & { forge?: string };
export type SubjectInput = Subject;
export type LegacySubject = Static<typeof LegacySubjectSchema>;
export type Producer = Static<typeof ProducerSchema>;
export type IntentPayload = Static<typeof IntentPayloadSchema>;
export type InvestigationPayload = Static<typeof InvestigationPayloadSchema>;
export type BuildPacketPayload = Static<typeof BuildPacketPayloadSchema>;
export type ControllerVerificationGate = Static<typeof ControllerVerificationGateSchema>;
export type BuildResultPayload = Static<typeof BuildResultPayloadSchema>;
export type ReviewVerdictPayload = Static<typeof ReviewVerdictPayloadSchema>;
export type OutcomePayload = Static<typeof OutcomePayloadSchema>;
export type VerificationAdjudicationPayload = Static<typeof VerificationAdjudicationPayloadSchema>;
export type RemediationBlockedPayload = Static<typeof RemediationBlockedPayloadSchema>;

export interface ArtifactPayloadByKind {
  Intent: IntentPayload;
  Investigation: InvestigationPayload;
  BuildPacket: BuildPacketPayload;
  BuildResult: BuildResultPayload;
  ReviewVerdict: ReviewVerdictPayload;
  Outcome: OutcomePayload;
  VerificationAdjudication: VerificationAdjudicationPayload;
  RemediationBlocked: RemediationBlockedPayload;
}

export type DurableArtifact<K extends ArtifactKind = ArtifactKind> = K extends ArtifactKind ? {
  schema: "forgedock.artifact/v2";
  kind: K;
  id: string;
  runId: string;
  subject: Subject;
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

const DEFAULT_FORGE = "github.com";

/** Normalize and validate the one subject identity used by every adapter. */
export function normalizeSubject(input: SubjectInput): Subject {
  if (!input || typeof input !== "object") throw new Error("Subject must be an object");
  if (typeof input.repo !== "string") throw new Error("Subject repository is required");
  const repo = input.repo.trim().toLowerCase();
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error("Subject repository must have owner/name shape");

  const forgeValue = input.forge === undefined ? DEFAULT_FORGE : input.forge;
  if (typeof forgeValue !== "string") throw new Error("Subject forge is required");
  const forge = forgeValue.trim().toLowerCase().replace(/\.+$/u, "");
  if (!forge || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(forge)) throw new Error("Subject forge must be a valid host");

  const issue = validateLocator(input.issue, "issue");
  const pr = validateLocator(input.pr, "pull request");
  if (issue === undefined && pr === undefined) throw new Error("Subject requires an issue or pull request locator");
  return {
    forge,
    repo,
    ...(issue !== undefined ? { issue } : {}),
    ...(pr !== undefined ? { pr } : {}),
  };
}

/** Canonical key used for indexes and deterministic identity comparisons. */
export function subjectIdentityKey(input: SubjectInput): string {
  const subject = normalizeSubject(input);
  return `${subject.forge}|${subject.repo}|i:${subject.issue ?? ""}|p:${subject.pr ?? ""}`;
}

/** Subjects overlap when forge/repository match and at least one locator matches. */
export function subjectsMatch(left: SubjectInput, right: SubjectInput): boolean {
  const a = normalizeSubject(left);
  const b = normalizeSubject(right);
  if (a.forge !== b.forge || a.repo !== b.repo) return false;
  return (a.issue !== undefined && b.issue === a.issue) || (a.pr !== undefined && b.pr === a.pr);
}

/** Migrate a legacy v2 subject. Historical artifacts were emitted only by GitHub. */
export function migrateLegacySubject(input: unknown): Subject {
  if (!input || typeof input !== "object") throw new Error("Invalid legacy artifact subject");
  const candidate = input as Record<string, unknown>;
  if ("forge" in candidate && candidate.forge !== undefined) return normalizeSubject(candidate as SubjectInput);
  return normalizeSubject({
    repo: candidate.repo as string,
    forge: DEFAULT_FORGE,
    ...(candidate.issue !== undefined ? { issue: candidate.issue as number } : {}),
    ...(candidate.pr !== undefined ? { pr: candidate.pr as number } : {}),
  });
}

/** Validate a stored artifact, migrating only its subject representation in memory. */
export function migrateArtifact(value: unknown): DurableArtifact {
  if (!value || typeof value !== "object") throw new Error("Artifact must be an object");
  const candidate = value as Record<string, unknown>;
  const migrated = { ...candidate, subject: migrateLegacySubject(candidate.subject) };
  assertArtifact(migrated);
  return migrated;
}

/** Explicit alias for callers performing storage/artifact migration. */
export const canonicalizeArtifact = migrateArtifact;

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
  if (!Check(SubjectSchema, candidate.subject)) throw validationError("subject", SubjectSchema, candidate.subject);
  const subject = candidate.subject as Subject;
  const canonicalSubject = normalizeSubject(subject);
  if (subject.forge !== canonicalSubject.forge || subject.repo !== canonicalSubject.repo
    || subject.issue !== canonicalSubject.issue || subject.pr !== canonicalSubject.pr) {
    throw new Error("Artifact subject must be canonical");
  }
  if (!Check(ProducerSchema, candidate.producer)) throw validationError("producer", ProducerSchema, candidate.producer);
  if (typeof candidate.createdAt !== "string" || Number.isNaN(Date.parse(candidate.createdAt))) {
    throw new Error("Artifact createdAt must be an ISO timestamp");
  }
  const payloadSchema = ArtifactPayloadSchemas[candidate.kind];
  if (!Check(payloadSchema, candidate.payload)) throw validationError("payload", payloadSchema, candidate.payload);
}

function validateLocator(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`Subject ${label} must be a positive safe integer`);
  return value as number;
}

function validationError(label: string, schema: TSchema, value: unknown): Error {
  const details = [...Errors(schema, value)].slice(0, 5).map((error) => error.message);
  return new Error(`Invalid artifact ${label}: ${details.join("; ")}`);
}
