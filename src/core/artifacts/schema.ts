// SPDX-License-Identifier: AGPL-3.0-or-later

import { Type, type Static, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

const NonEmptyString = Type.String({ minLength: 1 });
const IsoDateTime = Type.String({ format: "date-time" });
const Sha = Type.String({ pattern: "^[0-9a-fA-F]{7,64}$" });

export const SubjectSchema = Type.Object({
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

export const BatchMemberContractPayloadSchema = Type.Object({
  issue: Type.Integer({ minimum: 1 }),
  repository: Type.Optional(NonEmptyString),
  title: NonEmptyString,
  acceptanceCriteria: Type.Array(NonEmptyString, { minItems: 1 }),
  affectedFiles: Type.Array(NonEmptyString, { minItems: 1 }),
  claims: Type.Array(NonEmptyString, { minItems: 1 }),
  riskClass: Type.Union([Type.Literal("routine"), Type.Literal("security"), Type.Literal("auth"), Type.Literal("billing")]),
  /** Explicit compatibility evidence required when security/auth members are batched. */
  causalFamily: Type.Optional(NonEmptyString),
  riskCapabilities: Type.Optional(Type.Array(NonEmptyString, { minItems: 1 })),
  primaryDomain: Type.Optional(NonEmptyString),
  sharedSymbols: Type.Optional(Type.Array(NonEmptyString, { minItems: 1 })),
  sourceIssueUrl: Type.Optional(Type.String()),
});

export const IntentPayloadSchema = Type.Object({
  title: NonEmptyString,
  problem: NonEmptyString,
  desiredOutcome: Type.Optional(Type.String()),
  constraints: Type.Array(Type.String()),
  acceptanceHints: Type.Array(Type.String()),
  dependencies: Type.Array(Type.String()),
  batchMemberContracts: Type.Optional(Type.Array(BatchMemberContractPayloadSchema)),
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

export const CriterionIdSchema = Type.String({ pattern: "^criterion-[1-9][0-9]*$" });

export const VerificationRequirementSchema = Type.Object({
  kind: Type.Union([Type.Literal("command"), Type.Literal("controller-gate")]),
  id: NonEmptyString,
  criterionIds: Type.Array(CriterionIdSchema, { minItems: 1 }),
  rationale: NonEmptyString,
});

export const EvidencePathRoleSchema = Type.Union([
  Type.Literal("implementation"), Type.Literal("source"), Type.Literal("test"),
  Type.Literal("invariant"), Type.Literal("artifact"), Type.Literal("generated"),
  Type.Literal("fixture"), Type.Literal("unchanged-boundary"),
]);
export type EvidencePathRole = Static<typeof EvidencePathRoleSchema>;

/** A controller-declared, criterion-scoped path which may be read as evidence.
 * It does not expand the packet's write scope. */
export const EvidencePathDeclarationSchema = Type.Object({
  path: NonEmptyString,
  criterionIds: Type.Array(CriterionIdSchema, { minItems: 1 }),
  role: EvidencePathRoleSchema,
});
export type EvidencePathDeclaration = Static<typeof EvidencePathDeclarationSchema>;

export const VerificationEvidenceDiagnosticSchema = Type.Object({
  code: NonEmptyString,
  criterionId: Type.Optional(CriterionIdSchema),
  message: NonEmptyString,
  details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type VerificationEvidenceDiagnostic = Static<typeof VerificationEvidenceDiagnosticSchema>;

export const VerificationEvidenceCriterionSchema = Type.Object({
  criterionId: CriterionIdSchema,
  requiredCommandIds: Type.Array(NonEmptyString),
  semanticCommandIds: Type.Array(NonEmptyString),
  controllerGateIds: Type.Array(NonEmptyString),
  allowedWritePaths: Type.Array(NonEmptyString),
  allowedEvidencePaths: Type.Array(NonEmptyString),
  invariantRowIds: Type.Array(NonEmptyString),
  invariantTestIds: Type.Array(NonEmptyString),
  invariantCaseIds: Type.Array(NonEmptyString),
});
export type VerificationEvidenceCriterion = Static<typeof VerificationEvidenceCriterionSchema>;

export const VerificationEvidenceContractSchema = Type.Object({
  version: Type.Literal("forgedock.evidence/v1"),
  criteria: Type.Array(VerificationEvidenceCriterionSchema, { minItems: 1 }),
});
export type VerificationEvidenceContract = Static<typeof VerificationEvidenceContractSchema>;

export const InvariantMatrixRowSchema = Type.Object({
  id: NonEmptyString,
  criterionId: CriterionIdSchema,
  capability: Type.Union([
    Type.Literal("redaction-grammar"), Type.Literal("chunk-boundary"),
    Type.Literal("adapter-lifecycle"), Type.Literal("identity-isolation"),
    Type.Literal("terminal-metadata"),
  ]),
  dimensions: Type.Array(Type.Object({ name: NonEmptyString, values: Type.Array(NonEmptyString, { minItems: 1 }) }), { minItems: 1 }),
  testId: NonEmptyString,
});
export type InvariantMatrixRow = Static<typeof InvariantMatrixRowSchema>;

const PacketDigest = Type.String({ pattern: "^[0-9a-fA-F]{64}$" });

/** Controller-only proof for the no-hints, evidence-backed architecture lane. */
export const InvestigationScopeReceiptSchema = Type.Object({
  version: Type.Literal("forgedock.investigation-scope/v1"),
  runId: NonEmptyString,
  subject: SubjectSchema,
  intentId: NonEmptyString,
  intentDigest: PacketDigest,
  investigationId: NonEmptyString,
  investigationDigest: PacketDigest,
  baseSha: Sha,
  proposalDigest: PacketDigest,
  decisionDigest: PacketDigest,
  componentRoots: Type.Array(NonEmptyString, { minItems: 1, maxItems: 8 }),
  approvedPaths: Type.Array(NonEmptyString, { minItems: 1, maxItems: 32 }),
  newPaths: Type.Array(NonEmptyString, { maxItems: 4 }),
  evidencePaths: Type.Array(NonEmptyString, { minItems: 1, maxItems: 32 }),
  evidenceDigests: Type.Array(Type.Object({ path: NonEmptyString, digest: PacketDigest, bytes: Type.Integer({ minimum: 0 }) }), { minItems: 1, maxItems: 32 }),
  evidenceBytes: Type.Integer({ minimum: 0 }),
  relationReads: Type.Integer({ minimum: 0 }),
  limits: Type.Object({
    maxComponentRoots: Type.Integer({ minimum: 1 }),
    maxTotalPaths: Type.Integer({ minimum: 1 }),
    maxNewPaths: Type.Integer({ minimum: 0 }),
    maxRelationReads: Type.Integer({ minimum: 1 }),
    maxEvidenceBytes: Type.Integer({ minimum: 1 }),
  }),
  relationCheckpointId: NonEmptyString,
  relationCheckpointDigest: PacketDigest,
});
export type InvestigationScopeReceipt = Static<typeof InvestigationScopeReceiptSchema>;

export const BuildContextPackageSchema = Type.Object({
  /** Controller-produced, advisory context; absent on retained legacy packets. */
  version: Type.Literal("forgedock.context-package/v1"),
  baseSha: Sha,
  investigationDigest: PacketDigest,
  packageDigest: PacketDigest,
  entries: Type.Array(Type.Object({
    path: NonEmptyString,
    contentDigest: PacketDigest,
    bytes: Type.Integer({ minimum: 0 }),
    criterionIds: Type.Array(CriterionIdSchema, { minItems: 1 }),
    locators: Type.Array(NonEmptyString, { maxItems: 8 }),
    testEntrypoints: Type.Array(NonEmptyString, { maxItems: 8 }),
    excerpt: Type.String({ maxLength: 1_200 }),
  }), { minItems: 1, maxItems: 32 }),
});
export type BuildContextPackage = Static<typeof BuildContextPackageSchema>;

export const BuildComplexitySignalSchema = Type.Object({
  /** Advisory signal only; it never blocks a packet or chooses decomposition. */
  version: Type.Literal("forgedock.complexity-signal/v1"),
  level: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
  score: Type.Integer({ minimum: 0 }),
  criterionCount: Type.Integer({ minimum: 0 }),
  pathCount: Type.Integer({ minimum: 0 }),
  relationCount: Type.Integer({ minimum: 0 }),
  riskCount: Type.Integer({ minimum: 0 }),
  dimensions: Type.Array(NonEmptyString, { maxItems: 8 }),
});
export type BuildComplexitySignal = Static<typeof BuildComplexitySignalSchema>;

export const BuildPacketPayloadSchema = Type.Object({
  scope: Type.Array(NonEmptyString, { minItems: 1 }),
  acceptanceCriteria: Type.Array(NonEmptyString, { minItems: 1 }),
  context: Type.Array(Type.Object({
    source: NonEmptyString,
    relevance: NonEmptyString,
  })),
  /** Additive controller-produced read-only context, bound to the frozen base. */
  contextPackage: Type.Optional(BuildContextPackageSchema),
  /** Additive advisory complexity/risk signal; not a decomposition gate. */
  complexitySignal: Type.Optional(BuildComplexitySignalSchema),
  implementationPlan: Type.Array(NonEmptyString, { minItems: 1 }),
  expectedPaths: Type.Array(NonEmptyString),
  verificationPlan: Type.Array(NonEmptyString, { minItems: 1 }),
  /** Typed controller-owned gates; legacy prose remains readable for old packets. */
  controllerGates: Type.Optional(Type.Array(ControllerVerificationGateSchema)),
  /** Additive typed verification references for new packets. */
  verificationRequirements: Type.Optional(Type.Array(VerificationRequirementSchema, { minItems: 1 })),
  /** Controller-derived deterministic security-sensitive acceptance matrices. */
  invariantMatrices: Type.Optional(Type.Array(InvariantMatrixRowSchema, { minItems: 1 })),
  /** Bounded, criterion-scoped read-only evidence paths; never expands write scope. */
  evidencePaths: Type.Optional(Type.Array(EvidencePathDeclarationSchema)),
  /** Additive controller-owned evidence contract; absent on legacy packets. */
  evidenceContract: Type.Optional(VerificationEvidenceContractSchema),
  /** Controller-owned policy identity; absent on packets frozen before policy versioning. */
  verificationPolicyVersion: Type.Optional(NonEmptyString),
  /** Exact targets bound to packet-selected commands; absent on legacy packets. */
  verificationCommandTargets: Type.Optional(Type.Array(Type.Object({
    id: NonEmptyString,
    targets: Type.Array(NonEmptyString),
    /** Source/read-only targets used to derive compiled targets; never write authority. */
    sourceTargets: Type.Optional(Type.Array(NonEmptyString)),
    targetDigest: Type.Optional(PacketDigest),
  }))),
  /** Additive executable identity used to reject same-ID catalog drift on resume. */
  verificationCommandIdentities: Type.Optional(Type.Array(Type.Object({
    id: NonEmptyString,
    command: NonEmptyString,
    args: Type.Array(Type.String()),
    evidenceCapability: Type.Optional(NonEmptyString),
    targeting: Type.Optional(NonEmptyString),
    identityDigest: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  }))),
  /** Optional controller proof for evidence-backed, no-issue-hint architecture packets. */
  investigationScopeReceipt: Type.Optional(InvestigationScopeReceiptSchema),
  /** Optional controller-owned relation closure; absent packets remain legacy/conservative. */
  relationGraph: Type.Optional(Type.Object({
    version: Type.Literal("forgedock.relation-graph/v1"),
    baseSha: Sha,
    graphDigest: PacketDigest,
    configDigest: PacketDigest,
    closureDigest: PacketDigest,
    commandPlanDigest: PacketDigest,
    evidenceContractDigest: PacketDigest,
    /** Exact durable checkpoint identity bound to this packet. */
    checkpointId: NonEmptyString,
    checkpointDigest: PacketDigest,
    writablePaths: Type.Array(NonEmptyString),
    evidencePaths: Type.Array(NonEmptyString),
    invariantIds: Type.Array(NonEmptyString),
    commandIds: Type.Array(NonEmptyString),
  })),
  risks: Type.Array(Type.Object({
    risk: NonEmptyString,
    mitigation: NonEmptyString,
  })),
  outOfScope: Type.Array(Type.String()),
});

export const CheckResultSchema = Type.Object({
  command: NonEmptyString,
  /** Additive stable identity; old durable check evidence remains decodable. */
  commandId: Type.Optional(NonEmptyString),
  policyVersion: Type.Optional(NonEmptyString),
  commandTargets: Type.Optional(Type.Array(NonEmptyString)),
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

export const CriterionEvidenceAnchorsSchema = Type.Object({
  /** Repository paths containing the implementation or regression evidence. */
  paths: Type.Array(NonEmptyString, { minItems: 1 }),
  /** Stable exported/local symbol names at those paths. */
  symbols: Type.Array(NonEmptyString, { minItems: 1 }),
  /** Stable test names, case IDs, or typed invariant-matrix row IDs. */
  testIds: Type.Optional(Type.Array(NonEmptyString, { minItems: 1 })),
  /** Frozen command IDs when executable evidence is applicable. */
  verificationCommandIds: Type.Optional(Type.Array(NonEmptyString, { minItems: 1 })),
});
export type CriterionEvidenceAnchors = Static<typeof CriterionEvidenceAnchorsSchema>;

export const BuildResultPayloadSchema = Type.Object({
  branch: NonEmptyString,
  targetBranch: Type.Optional(NonEmptyString),
  promotionTarget: Type.Optional(NonEmptyString),
  productionTarget: Type.Optional(NonEmptyString),
  headSha: Sha,
  baseSha: Type.Optional(Sha),
  changedPaths: Type.Array(NonEmptyString),
  summary: NonEmptyString,
  acceptanceEvidence: Type.Array(Type.Object({
    criterionId: Type.Optional(CriterionIdSchema),
    criterion: NonEmptyString,
    status: Type.Union([Type.Literal("passed"), Type.Literal("failed")]),
    evidence: NonEmptyString,
    /** Additive semantic anchors; legacy prose-only evidence remains decodable. */
    anchors: Type.Optional(CriterionEvidenceAnchorsSchema),
  })),
  checks: Type.Array(CheckResultSchema),
  decisions: Type.Array(Type.String()),
  residualRisks: Type.Array(Type.String()),
});

export const VerificationCheckpointPayloadSchema = Type.Object({
  checkpoint: Type.Literal("verified-commit"),
  branch: NonEmptyString,
  targetBranch: NonEmptyString,
  promotionTarget: Type.Optional(NonEmptyString),
  productionTarget: Type.Optional(NonEmptyString),
  baseSha: Sha,
  parentHeadSha: Sha,
  changedPaths: Type.Array(NonEmptyString, { minItems: 1 }),
  /** Exact uncommitted delta sealed immediately before the retained commit. */
  pendingChangedPaths: Type.Array(NonEmptyString, { minItems: 1 }),
  verifiedContentDigest: Sha,
  commitMessage: NonEmptyString,
  summary: NonEmptyString,
  acceptanceEvidence: Type.Array(Type.Object({
    criterionId: Type.Optional(CriterionIdSchema),
    criterion: NonEmptyString,
    status: Type.Literal("passed"),
    evidence: NonEmptyString,
    anchors: Type.Optional(CriterionEvidenceAnchorsSchema),
  })),
  checks: Type.Array(CheckResultSchema, { minItems: 1 }),
  /** Frozen semantic command targets retained for crash recovery. */
  verificationCommandTargets: Type.Optional(Type.Array(Type.Object({
    id: NonEmptyString,
    targets: Type.Array(NonEmptyString),
    targetDigest: Type.Optional(PacketDigest),
  }))),
  verificationCommandPlanDigest: Type.Optional(PacketDigest),
  decisions: Type.Array(Type.String()),
  residualRisks: Type.Array(Type.String()),
});

/**
 * Controller-verifiable impact evidence for a review finding. This remains
 * optional on durable findings so older verdicts can be decoded, but the
 * current reviewer prompt asks every new finding to provide it. Impact-gated
 * projection fails closed when the declaration is absent or incomplete.
 */
export const FindingImpactSchema = Type.Object({
  category: Type.Union([
    Type.Literal("correctness"),
    Type.Literal("security"),
    Type.Literal("data-integrity"),
    Type.Literal("availability"),
    Type.Literal("performance"),
    Type.Literal("compatibility"),
    Type.Literal("operability"),
    Type.Literal("test-gap"),
    Type.Literal("advisory"),
  ]),
  /** Concrete trigger or input sequence that exposes the concern. */
  trigger: NonEmptyString,
  /** Invariant, acceptance criterion, or boundary that the trigger violates. */
  affectedInvariant: NonEmptyString,
  /** Observable consequence if the trigger occurs. */
  consequence: NonEmptyString,
});
export type FindingImpact = Static<typeof FindingImpactSchema>;

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
  /** Controller-accepted remediation obligation, independent of final blocking policy. */
  mustFix: Type.Optional(Type.Boolean()),
  /** Durable controller-owned structural root identity. */
  rootId: Type.Optional(NonEmptyString),
  title: NonEmptyString,
  /** Stable reviewer-proposed failure-mode label used only after controller normalization. */
  causalRoot: Type.Optional(NonEmptyString),
  /** Stable controller-normalized root identity used for projection adoption. */
  normalizedRoot: Type.Optional(NonEmptyString),
  evidence: NonEmptyString,
  location: Type.Optional(NonEmptyString),
  intentRelevance: NonEmptyString,
  remediation: NonEmptyString,
  /** Structured impact declaration added by the current reviewer contract. */
  impact: Type.Optional(FindingImpactSchema),
  /** Controller-verifiable anchor proposed by a reviewer; prose alone is never an anchor. */
  evidenceAnchor: Type.Optional(Type.Object({
    kind: Type.Union([
      Type.Literal("repository-location"),
      Type.Literal("delivery-authority"),
      Type.Literal("deterministic-check"),
    ]),
    reference: NonEmptyString,
  })),
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
  introductionDisposition: Type.Optional(Type.Union([
    Type.Literal("introduced"), Type.Literal("newly-discovered-preexisting"), Type.Literal("continuation"),
  ])),
  /** Causal proof required before the controller accepts remediation introduction. */
  introductionEvidence: Type.Optional(Type.Object({
    priorReproducer: NonEmptyString,
    currentReproducer: NonEmptyString,
    causalSymbols: Type.Array(NonEmptyString, { minItems: 1 }),
    hunkReferences: Type.Array(NonEmptyString, { minItems: 1 }),
    authorityReferences: Type.Optional(Type.Array(NonEmptyString)),
  })),
});

const ReviewerRoleSchema = Type.Union([
  Type.Literal("correctness"), Type.Literal("security"), Type.Literal("data"),
  Type.Literal("api-compatibility"), Type.Literal("frontend"), Type.Literal("infrastructure"), Type.Literal("concurrency"),
]);
const SpecialistReviewerRoleSchema = Type.Union([
  Type.Literal("security"), Type.Literal("data"), Type.Literal("api-compatibility"),
  Type.Literal("frontend"), Type.Literal("infrastructure"), Type.Literal("concurrency"),
]);

const ReviewCapabilityIdSchema = Type.Union([
  Type.Literal("acceptance-correctness"), Type.Literal("security"), Type.Literal("data-integrity"),
  Type.Literal("api-compatibility"), Type.Literal("frontend"), Type.Literal("release"), Type.Literal("concurrency"),
]);
const ReviewCapabilitySchema = Type.Object({
  id: ReviewCapabilityIdSchema,
  score: Type.Integer({ minimum: 0 }),
  reasons: Type.Array(NonEmptyString, { minItems: 1 }),
  scope: Type.Array(NonEmptyString),
  required: Type.Boolean(),
});

export const ReviewPlanSchema = Type.Object({
  /** Current identity fields remain optional so legacy durable verdicts decode. */
  planId: Type.Optional(NonEmptyString),
  schemaVersion: Type.Optional(Type.Union([Type.Literal(2), Type.Literal(3), Type.Literal(4)])),
  context: Type.Optional(Type.Object({
    runId: NonEmptyString,
    repo: NonEmptyString,
    issue: Type.Optional(Type.Integer({ minimum: 1 })),
    pullRequest: Type.Integer({ minimum: 0 }),
    packetId: NonEmptyString,
    packetDigest: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    deliveryRunId: NonEmptyString,
    buildResultBranch: NonEmptyString,
    targetBranch: NonEmptyString,
    baseSha: Type.Optional(Sha),
    /** Exact revision and closure lineage for this immutable execution plan. */
    reviewedHeadSha: Type.Optional(Sha),
    phase: Type.Optional(Type.Union([Type.Literal("initial"), Type.Literal("closure")])),
    parentPlanId: Type.Optional(NonEmptyString),
    parentVerdictId: Type.Optional(NonEmptyString),
    deltaPaths: Type.Optional(Type.Array(NonEmptyString)),
    openRootIds: Type.Optional(Type.Array(NonEmptyString)),
  })),
  generation: Type.Optional(Type.Integer({ minimum: 1 })),
  frozen: Type.Optional(Type.Literal(true)),
  riskTier: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical")]),
  budget: Type.Optional(Type.Object({
    maxSpecialistExecutionGroups: Type.Integer({ minimum: 1, maximum: 6 }),
    maxLogicalReviewerSessions: Type.Integer({ minimum: 1, maximum: 64 }),
    maxParallelSessions: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
    maxTurnsPerExecutionGroup: Type.Optional(Type.Integer({ minimum: 1, maximum: 24 })),
    maxToolCallsPerExecutionGroup: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
    maxAttemptsPerExecutionGroup: Type.Literal(2),
    maxReviewerAttempts: Type.Integer({ minimum: 1, maximum: 128 }),
    maxScopeAdjudicationAttempts: Type.Integer({ minimum: 1, maximum: 2 }),
    maxModelCalls: Type.Optional(Type.Integer({ minimum: 1, maximum: 130 })),
  })),
  capabilities: Type.Optional(Type.Array(ReviewCapabilitySchema, { minItems: 1 })),
  executionGroups: Type.Optional(Type.Array(Type.Object({
    id: NonEmptyString,
    role: ReviewerRoleSchema,
    capabilities: Type.Array(ReviewCapabilityIdSchema, { minItems: 1 }),
    score: Type.Integer({ minimum: 0 }),
    reasons: Type.Array(NonEmptyString, { minItems: 1 }),
    scope: Type.Array(NonEmptyString),
    required: Type.Boolean(),
  }), { minItems: 1 })),
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
    reason: Type.Union([
      Type.Literal("below-threshold"), Type.Literal("panel-budget"),
      Type.Literal("overlapping-coverage"), Type.Literal("grouped-coverage"),
    ]),
    evidence: Type.Array(NonEmptyString),
  })),
});

const ReviewFindingProjectionEntrySchema = Type.Object({
  findingId: NonEmptyString,
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("materialized"),
    Type.Literal("adopted"),
    Type.Literal("projection-drift"),
    Type.Literal("suppressed"),
  ]),
  marker: Type.Optional(NonEmptyString),
  issueNumber: Type.Optional(Type.Integer({ minimum: 1 })),
  issueUrl: Type.Optional(Type.String()),
  mismatches: Type.Optional(Type.Array(NonEmptyString)),
});

/**
 * Durable checkpoint for the non-atomic review-finding -> GitHub projection.
 * The plan contains the complete consolidated findings so a restart can
 * reconcile GitHub without invoking another reviewer/model wave.
 */
export const ReviewFindingProjectionPayloadSchema = Type.Object({
  checkpoint: Type.Literal("review-finding-publication"),
  status: Type.Union([Type.Literal("planned"), Type.Literal("completed")]),
  pullRequest: Type.Integer({ minimum: 1 }),
  headSha: Sha,
  headBranch: NonEmptyString,
  baseBranch: NonEmptyString,
  /** Durable host CAS generation; optional only for legacy projection decode. */
  publicationFence: Type.Optional(Type.Object({
    repo: NonEmptyString,
    pullRequest: Type.Integer({ minimum: 1 }),
    generation: Type.Integer({ minimum: 1 }),
    runId: NonEmptyString,
    headSha: Sha,
    headBranch: NonEmptyString,
    baseBranch: NonEmptyString,
  })),
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
  findingProjection: Type.Object({
    policy: Type.Union([
      Type.Literal("all"),
      Type.Literal("approved-only"),
      Type.Literal("none"),
      Type.Literal("impact-gated"),
      Type.Literal("shadow-impact-gated"),
    ]),
    candidateFindingIds: Type.Array(NonEmptyString),
    materializedFindingIds: Type.Array(NonEmptyString),
    suppressed: Type.Array(Type.Object({
      findingId: NonEmptyString,
      reason: NonEmptyString,
    })),
  }),
  projections: Type.Array(ReviewFindingProjectionEntrySchema),
  supersedes: Type.Optional(NonEmptyString),
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
  warnings: Type.Optional(Type.Array(NonEmptyString)),
  reviewPlan: Type.Optional(ReviewPlanSchema),
  scopeAdjudication: Type.Optional(Type.Object({
    sessionRef: NonEmptyString,
    decisions: Type.Array(Type.Object({
      findingId: NonEmptyString,
      disposition: Type.Union([Type.Literal("accept"), Type.Literal("follow_up"), Type.Literal("reject")]),
      rationale: NonEmptyString,
    })),
  })),
  /**
   * Records the controller's projection decision separately from the review
   * verdict. This makes shadow/canary comparisons durable without changing
   * the independent reviewer evidence or legacy verdict shape.
   */
  findingProjection: Type.Optional(Type.Object({
    policy: Type.Union([
      Type.Literal("all"),
      Type.Literal("approved-only"),
      Type.Literal("none"),
      Type.Literal("impact-gated"),
      Type.Literal("shadow-impact-gated"),
    ]),
    candidateFindingIds: Type.Array(NonEmptyString),
    materializedFindingIds: Type.Array(NonEmptyString),
    suppressed: Type.Array(Type.Object({
      findingId: NonEmptyString,
      reason: NonEmptyString,
    })),
    projections: Type.Optional(Type.Array(ReviewFindingProjectionEntrySchema)),
  })),
  supersedes: Type.Optional(NonEmptyString),
});

export const OutcomePayloadSchema = Type.Object({
  status: Type.Union([
    Type.Literal("merged"),
    Type.Literal("invalid"),
    Type.Literal("decomposed"),
    /** Nonterminal verification repair checkpoint; never a terminal Outcome. */
    Type.Literal("repairing"),
    Type.Literal("blocked"),
    Type.Literal("failed"),
    Type.Literal("abandoned"),
  ]),
  reason: NonEmptyString,
  targetBranch: Type.Optional(NonEmptyString),
  promotionTarget: Type.Optional(NonEmptyString),
  productionTarget: Type.Optional(NonEmptyString),
  /** Invalid outcomes are provisional until the controller proves issue closure. */
  issueClosure: Type.Optional(Type.Object({
    status: Type.Union([Type.Literal("pending"), Type.Literal("completed")]),
    repo: NonEmptyString,
    issue: Type.Integer({ minimum: 1 }),
    verifiedAt: Type.Optional(IsoDateTime),
  })),
  finalSha: Type.Optional(Sha),
  /** Recoverable merge-admission evidence retained when GitHub checks are not ready. */
  mergeGate: Type.Optional(Type.Object({
    /** Additive repository identity; older checkpoints may omit it. */
    repo: Type.Optional(NonEmptyString),
    pullRequest: Type.Integer({ minimum: 1 }),
    headSha: Sha,
    baseBranch: NonEmptyString,
    mergeable: Type.Boolean(),
    mergeability: Type.Optional(Type.Union([
      Type.Literal("mergeable"), Type.Literal("conflicting"), Type.Literal("unknown"), Type.Literal("unavailable"),
    ])),
    mergeabilityReason: Type.Optional(Type.String({ maxLength: 500 })),
    /** Optional only for additive decoding; missing provenance is non-authoritative. */
    requiredChecksProvenance: Type.Optional(Type.Union([
      Type.Literal("github-required"), Type.Literal("github-none"), Type.Literal("unavailable"),
    ])),
    /** Optional for legacy decode; absence cannot authorize a current merge. */
    requiredChecksHeadSha: Type.Optional(Sha),
    observedAt: IsoDateTime,
    requiredChecks: Type.Array(Type.Object({
      name: NonEmptyString,
      state: Type.Union([
        Type.Literal("pending"), Type.Literal("passed"), Type.Literal("failed"),
        Type.Literal("cancelled"), Type.Literal("unavailable"),
      ]),
      detailsUrl: Type.Optional(Type.String()),
    })),
  })),
  prUrl: Type.Optional(Type.String()),
  childIssues: Type.Array(Type.String()),
  /** Batch members intentionally left open because closure-protected labels were present. */
  preservedChildIssues: Type.Optional(Type.Array(Type.String())),
  batchParent: Type.Optional(Type.Integer({ minimum: 1 })),
  /** Terminal target-recovery failures supersede the resumable checkpoint. */
  targetRecovery: Type.Optional(Type.Object({
    checkpointId: NonEmptyString,
    phase: NonEmptyString,
    cause: Type.String({ minLength: 1, maxLength: 4096 }),
    attempt: Type.Object({ number: Type.Integer({ minimum: 1 }), max: Type.Integer({ minimum: 1 }) }),
  })),
  /** Terminal artifact lineage; prevents a stale checkpoint from masking failure. */
  supersedes: Type.Optional(NonEmptyString),
  failureEvidence: Type.Optional(Type.Object({
    branch: NonEmptyString,
    workspacePath: NonEmptyString,
    baseRef: Type.Optional(NonEmptyString),
    targetBranch: Type.Optional(NonEmptyString),
    promotionTarget: Type.Optional(NonEmptyString),
    productionTarget: Type.Optional(NonEmptyString),
    baseSha: Type.Optional(Sha),
    builderSummary: NonEmptyString,
    failureKind: Type.Optional(Type.Union([
      Type.Literal("builder-semantic-evidence"), Type.Literal("builder-report"),
      Type.Literal("packet-contract"), Type.Literal("required-check"), Type.Literal("scope"), Type.Literal("verification-mutation"),
    ])),
    changedPaths: Type.Array(NonEmptyString),
    criterionCoverage: Type.Optional(Type.Array(Type.Object({
      criterionId: Type.Optional(CriterionIdSchema),
      criterion: NonEmptyString,
      implementation: NonEmptyString,
      anchors: Type.Optional(CriterionEvidenceAnchorsSchema),
    }))),
    decisions: Type.Optional(Type.Array(Type.String())),
    residualRisks: Type.Optional(Type.Array(Type.String())),
    repairAttempt: Type.Optional(Type.Integer({ minimum: 1 })),
    checks: Type.Array(CheckResultSchema),
    /** Structured controller diagnostics for additive evidence-contract failures. */
    diagnostics: Type.Optional(Type.Array(VerificationEvidenceDiagnosticSchema)),
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

export const FindingRootLedgerPayloadSchema = Type.Object({
  checkpoint: Type.Literal("finding-root-ledger"),
  pullRequest: Type.Integer({ minimum: 1 }),
  headSha: Sha,
  epoch: Type.Integer({ minimum: 1 }),
  /** All known roots are retained; an omitted root is never implicitly closed. */
  roots: Type.Array(Type.Object({
    rootId: NonEmptyString,
    structuralKey: NonEmptyString,
    aliases: Type.Array(NonEmptyString, { minItems: 1 }),
    criterionIds: Type.Array(CriterionIdSchema, { minItems: 1 }),
    component: NonEmptyString,
    symbols: Type.Array(NonEmptyString, { minItems: 1 }),
    invariantFamily: NonEmptyString,
    failureFamily: NonEmptyString,
    triggerFamily: NonEmptyString,
    state: Type.Union([
      Type.Literal("open"), Type.Literal("fix-attempted"), Type.Literal("fixed"),
      Type.Literal("regressed"), Type.Literal("follow-up"), Type.Literal("rejected"),
    ]),
    firstSeenHeadSha: Sha,
    lastSeenHeadSha: Sha,
    epochsOpen: Type.Integer({ minimum: 0 }),
    findingIds: Type.Array(NonEmptyString, { minItems: 1 }),
    ownerRoles: Type.Array(NonEmptyString, { minItems: 1 }),
    representative: FindingSchema,
  })),
  supersedes: Type.Optional(NonEmptyString),
});

const Digest = Type.String({ pattern: "^[0-9a-fA-F]{64}$" });
const BoundedString = Type.String({ minLength: 1, maxLength: 4096 });

/** Durable authority for a bounded, adapter-produced relation graph. */
export const RelationGraphCheckpointPayloadSchema = Type.Object({
  checkpoint: Type.Literal("relation-graph"),
  version: Type.Literal("forgedock.relation-graph/v1"),
  baseSha: Sha,
  graphDigest: Digest,
  configDigest: Digest,
  closureDigest: Digest,
  commandPlanDigest: Digest,
  evidenceContractDigest: Digest,
  adapterIds: Type.Array(BoundedString, { minItems: 1, maxItems: 32 }),
  seeds: Type.Array(Type.Object({
    path: BoundedString,
    provenance: Type.Union([Type.Literal("issue"), Type.Literal("controller"), Type.Literal("config")]),
    contentDigest: Type.Optional(Digest),
  }), { maxItems: 4096 }),
  nodes: Type.Array(Type.Object({
    id: BoundedString,
    kind: Type.Union([
      Type.Literal("file"), Type.Literal("symbol"), Type.Literal("interface"), Type.Literal("config"),
      Type.Literal("generated"), Type.Literal("test"), Type.Literal("invariant"), Type.Literal("command"),
    ]),
    identity: BoundedString,
    digest: Type.Optional(Digest),
  }), { maxItems: 100_000 }),
  edges: Type.Array(Type.Object({
    id: BoundedString,
    sourceId: BoundedString,
    targetId: BoundedString,
    kind: Type.Union([
      Type.Literal("import"), Type.Literal("call"), Type.Literal("implements"), Type.Literal("reads-config"),
      Type.Literal("generated-by"), Type.Literal("serializes"), Type.Literal("deserializes"), Type.Literal("test-covers"),
      Type.Literal("asserts"), Type.Literal("invariant"), Type.Literal("command-target"),
    ]),
    adapterId: BoundedString,
    provenance: Type.Union([Type.Literal("controller"), Type.Literal("repository"), Type.Literal("config")]),
    sourcePath: Type.Optional(BoundedString),
    targetPath: Type.Optional(BoundedString),
    evidenceDigest: Digest,
  }), { maxItems: 200_000 }),
  writablePaths: Type.Array(BoundedString, { maxItems: 4096 }),
  evidencePaths: Type.Array(BoundedString, { maxItems: 4096 }),
  invariantIds: Type.Array(BoundedString, { maxItems: 4096 }),
  commandIds: Type.Array(BoundedString, { maxItems: 4096 }),
  limits: Type.Object({
    maxNodes: Type.Integer({ minimum: 1 }), maxEdges: Type.Integer({ minimum: 1 }),
    maxDepth: Type.Integer({ minimum: 1 }), maxFiles: Type.Integer({ minimum: 1 }),
    maxBytes: Type.Integer({ minimum: 1 }), maxCollateralPaths: Type.Integer({ minimum: 0 }),
  }),
  /** Identity fields are optional only for decoding pre-certification checkpoints. */
  checkpointId: Type.Optional(NonEmptyString),
  checkpointDigest: Type.Optional(Digest),
  createdAt: IsoDateTime,
});

/** Durable authority for a target integration/advance attempt. */
export const TargetAdvanceCheckpointPayloadSchema = Type.Object({
  checkpoint: Type.Literal("target-advance"),
  version: Type.Literal("forgedock.target-advance/v1"),
  repository: BoundedString,
  targetBranch: BoundedString,
  routeClaimKey: BoundedString,
  claimId: Type.Optional(BoundedString),
  packetArtifactId: BoundedString,
  sourceBuildResultId: BoundedString,
  sourceVerdictId: Type.Optional(BoundedString),
  sourceBaseSha: Sha,
  sourceHeadSha: Sha,
  observedTargetSha: Sha,
  phase: Type.Union([Type.Literal("target-read"), Type.Literal("integrated"), Type.Literal("verified"), Type.Literal("fenced"), Type.Literal("pushed"), Type.Literal("reviewed")]),
  expectedPaths: Type.Array(BoundedString, { maxItems: 4096 }),
  verifiedContentDigest: Digest,
  verificationPlanId: BoundedString,
  attempt: Type.Object({ number: Type.Integer({ minimum: 1, maximum: 3 }), max: Type.Integer({ minimum: 1, maximum: 3 }) }),
  workspace: Type.Object({ path: BoundedString, branch: BoundedString, baseRef: BoundedString }),
  integrationHeadSha: Type.Optional(Sha), mergeHeadSha: Type.Optional(Sha),
  freshVerificationCheckpointId: Type.Optional(BoundedString), freshBuildResultId: Type.Optional(BoundedString),
  pullRequest: Type.Optional(Type.Integer({ minimum: 1 })), pushedHeadSha: Type.Optional(Sha),
  /** Identity of the immediately preceding checkpoint update. */
  supersedes: Type.Optional(BoundedString),
  createdAt: IsoDateTime, updatedAt: IsoDateTime,
});

/** Durable, nonterminal retry intent. It never authorizes dispatch by itself. */
export const RetryCheckpointPayloadSchema = Type.Object({
  checkpoint: Type.Literal("retry"),
  version: Type.Literal("forgedock.retry/v1"),
  domain: Type.Union([Type.Literal("github"), Type.Literal("provider"), Type.Literal("workflow"), Type.Literal("lease"), Type.Literal("transport")]),
  code: BoundedString, phase: BoundedString, operationKey: BoundedString, semanticKey: BoundedString,
  nodeId: Type.Optional(BoundedString), attemptId: Type.Optional(BoundedString), sessionRef: Type.Optional(BoundedString),
  artifactIds: Type.Array(BoundedString, { maxItems: 4096 }),
  attempt: Type.Object({ number: Type.Integer({ minimum: 1 }), max: Type.Integer({ minimum: 1 }), firstAt: IsoDateTime, nextAt: IsoDateTime, deadlineAt: Type.Optional(IsoDateTime) }),
  retryAfterMs: Type.Optional(Type.Integer({ minimum: 0 })),
  supersedes: Type.Optional(BoundedString),
  reconciliation: Type.Union([Type.Literal("pending"), Type.Literal("proven-absent"), Type.Literal("proven-present"), Type.Literal("completed")]),
  status: Type.Union([Type.Literal("waiting"), Type.Literal("due"), Type.Literal("cancelled"), Type.Literal("exhausted")]),
  cause: Type.Object({ class: BoundedString, status: Type.Optional(Type.Integer({ minimum: 100, maximum: 599 })), message: Type.String({ minLength: 1, maxLength: 4096 }) }),
  createdAt: IsoDateTime, updatedAt: IsoDateTime,
});


export const ArtifactPayloadSchemas = {
  Intent: IntentPayloadSchema,
  Investigation: InvestigationPayloadSchema,
  BuildPacket: BuildPacketPayloadSchema,
  VerificationCheckpoint: VerificationCheckpointPayloadSchema,
  BuildResult: BuildResultPayloadSchema,
  ReviewVerdict: ReviewVerdictPayloadSchema,
  ReviewFindingProjection: ReviewFindingProjectionPayloadSchema,
  FindingRootLedger: FindingRootLedgerPayloadSchema,
  Outcome: OutcomePayloadSchema,
  VerificationAdjudication: VerificationAdjudicationPayloadSchema,
  RemediationBlocked: RemediationBlockedPayloadSchema,
  RelationGraphCheckpoint: RelationGraphCheckpointPayloadSchema,
  TargetAdvanceCheckpoint: TargetAdvanceCheckpointPayloadSchema,
  RetryCheckpoint: RetryCheckpointPayloadSchema,
} as const satisfies Record<string, TSchema>;

export type ArtifactKind = keyof typeof ArtifactPayloadSchemas;
export type ArtifactPayloadByKind = {
  [K in ArtifactKind]: Static<(typeof ArtifactPayloadSchemas)[K]>;
};
export type Subject = Static<typeof SubjectSchema>;
export type Producer = Static<typeof ProducerSchema>;
export type BatchMemberContractPayload = Static<typeof BatchMemberContractPayloadSchema>;
export type IntentPayload = ArtifactPayloadByKind["Intent"];
export type InvestigationPayload = ArtifactPayloadByKind["Investigation"];
export type BuildPacketPayload = ArtifactPayloadByKind["BuildPacket"];
export type VerificationCheckpointPayload = ArtifactPayloadByKind["VerificationCheckpoint"];
export type ControllerVerificationGate = Static<typeof ControllerVerificationGateSchema>;
export type VerificationRequirement = Static<typeof VerificationRequirementSchema>;
export type BuildResultPayload = ArtifactPayloadByKind["BuildResult"];
export type ReviewVerdictPayload = ArtifactPayloadByKind["ReviewVerdict"];
export type ReviewFindingProjectionPayload = ArtifactPayloadByKind["ReviewFindingProjection"];
export type FindingRootLedgerPayload = ArtifactPayloadByKind["FindingRootLedger"];
export type OutcomePayload = ArtifactPayloadByKind["Outcome"];
export type VerificationAdjudicationPayload = ArtifactPayloadByKind["VerificationAdjudication"];
export type RemediationBlockedPayload = ArtifactPayloadByKind["RemediationBlocked"];
export type RelationGraphCheckpointPayload = ArtifactPayloadByKind["RelationGraphCheckpoint"];
export type TargetAdvanceCheckpointPayload = ArtifactPayloadByKind["TargetAdvanceCheckpoint"];
export type RetryCheckpointPayload = ArtifactPayloadByKind["RetryCheckpoint"];

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
  subject: Subject;
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
    subject: input.subject,
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
