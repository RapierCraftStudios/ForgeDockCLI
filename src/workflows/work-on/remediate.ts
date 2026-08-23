// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DurableArtifact } from "../../core/artifacts/schema.js";
import type { RunRepository } from "../../core/ports/repositories.js";
import type { VerificationCommand, VerificationRunner } from "../../core/ports/verification.js";
import { transition, type RunState } from "../../core/state/machine.js";
import {
  isRecoverableAgentExecutionError,
  scopeDiscoveryRoots,
  scopeManifestFor,
  STANDARD_SCOPE_METADATA_ROOTS,
  type AgentEventSink,
  type AgentRuntime,
} from "../../runtime/agent-runtime.js";
import { auditBuilderCriterionCoverage, BuilderSubmissionSchema, criterionCoverageInstructions, deriveBuilderVerificationGate, normalizeBuilderSubmission, type BuilderSubmission } from "./build.js";
import { WorkflowExecutionError, retryableExternalWorkflowError } from "./investigate.js";

export class RemediationAdmissionError extends Error {
  readonly code = "remediation-admission" as const;

  constructor(message: string) {
    super(message);
    this.name = "RemediationAdmissionError";
  }
}

export async function remediateReview(
  input: {
    run: RunState;
    intent: DurableArtifact<"Intent">;
    investigation: DurableArtifact<"Investigation">;
    packet: DurableArtifact<"BuildPacket">;
    buildResult: DurableArtifact<"BuildResult">;
    verdict: DurableArtifact<"ReviewVerdict">;
    reviewCycle?: { current: number; total: number };
    worktree: string;
    provider?: string;
    model?: string;
    signal?: AbortSignal;
    verification?: readonly VerificationCommand[];
    verificationRunner?: VerificationRunner;
  },
  dependencies: { runtime: AgentRuntime; runs: RunRepository; onAgentEvent?: AgentEventSink; verifier?: VerificationRunner },
): Promise<{ run: RunState; submission: BuilderSubmission; sessionRef: string }> {
  if (input.run.state !== "remediating") throw new Error(`Remediation requires remediating state, found ${input.run.state}`);
  const findings = input.verdict.payload.findings.filter((finding) =>
    finding.scopeDisposition !== "rejected"
      && finding.scopeDisposition !== "follow_up"
      && (finding.mustFix ?? finding.blocking));
  if (!findings.length) throw new Error("Remediation requires at least one open controller-accepted mustFix root");
  const verificationGate = input.verification?.length && (input.verificationRunner ?? dependencies.verifier)
    ? deriveBuilderVerificationGate(input.packet, input.verification)
    : undefined;
  const frozenCommands = input.verification ?? [];
  let run = input.run;
  try {
    // Admission is controller-owned and deliberately inside the guarded path:
    // deterministic scope/packet rejection must block, never enter an agent
    // retry loop or leave a failed run that ordinary resume will replay.
    const clusters = clusterMustFixFindings(findings);
    const reviewCycle = input.reviewCycle ?? { current: 1, total: 1 };
    const rootChecklist = remediationRootChecklist(input.packet, findings);
    const result = await dependencies.runtime.run<BuilderSubmission>({
      id: `${run.runId}:remediate:${input.verdict.payload.headSha}:${run.attempt}`,
      role: "remediator",
      description: `ForgeDock remediation · cycle ${reviewCycle.current}/${reviewCycle.total} · ${findings.length} mustFix root(s) in ${clusters.length} cluster(s) · BuildResult ${input.buildResult.createdAt} · ReviewVerdict ${input.verdict.createdAt} · remediation remaining ${Math.max(0, reviewCycle.total - reviewCycle.current)}`,
      observability: {
        phase: "remediation",
        cycle: reviewCycle,
        activeChild: "remediator",
        reviewerRoles: input.verdict.payload.reviewerRoles,
        latestArtifacts: { buildResult: input.buildResult.createdAt, reviewVerdict: input.verdict.createdAt },
        remainingRemediationCycles: Math.max(0, reviewCycle.total - reviewCycle.current),
      },
      objective: `Fix every open controller-accepted mustFix root from review of ${input.verdict.payload.headSha}. Roots are bounded into at most two coherent clusters; no listed criterion violation may be ignored. Resolve each root using this checklist (carry forward unchanged paths when their invariant remains proven):\n${rootChecklist.map((item) => `- ${item}`).join("\n")}\nClusters:\n${JSON.stringify(clusters, null, 2)}`,
      instructions: [
        "Address every root in every supplied cluster, including accepted medium/non-blocking roots. Do not drop a known frozen-criterion violation merely because it is not independently blocking.",
        "Do not address rejected, follow-up, speculative, or unrelated cleanup.",
        ...(input.verification?.length ? [
          `Typed verification feedback is available only for these frozen command IDs: ${input.verification.map((command) => `${command.id}=${command.command} ${command.args.join(" ")}`).join("; ")}.`,
        ] : []),
        "Use the pure compute tool when an accepted criterion requires hashes, canonical JSON, base64url, or an Ed25519 test vector; never invent cryptographic fixture values.",
        "Do not invoke GitHub, commit, push, merge, or alter workflow state.",
        "Use the typed verify tool for implementation feedback when a frozen command is relevant. The controller independently reruns every verification command and owns publication; your check result is feedback, not controller evidence.",
        criterionCoverageInstructions(input.packet),
        `Root resolution evidence is mandatory for every checklist item: ${rootChecklist.join("; ")}. A previously correct path need not be edited; carry it forward with its current symbol and focused test/invariant or explicit frozen controller-check receipt.`,
        "Report the complete current delivery revision: carry forward prior Build Result paths and criterion evidence, then add or revise the paths and criteria changed by this remediation. The controller normalizes omitted in-scope paths to its scoped Git observation, but rejects fabricated reported paths.",
        "The controller re-runs every required verification command and starts a fresh review at the new SHA.",
      ].join("\n"),
      context: [input.intent, input.investigation, input.packet, input.buildResult, input.verdict],
      workspace: {
        cwd: input.worktree,
        mode: "write",
        scope: scopeManifestFor("remediation", {
          affectedFiles: [
            ...input.packet.payload.expectedPaths,
            ...findings.flatMap((finding) => finding.location ? [finding.location] : []),
          ],
          writePaths: input.packet.payload.expectedPaths,
          metadataRoots: [
            ...STANDARD_SCOPE_METADATA_ROOTS,
            ...scopeDiscoveryRoots(input.packet.payload.expectedPaths),
          ],
        }),
      },
      tools: ["read", "grep", "find", "ls", "compute", ...(input.verification?.length && (input.verificationRunner ?? dependencies.verifier) ? ["verify" as const] : []), "edit", "write"],
      ...(input.verification?.length && (input.verificationRunner ?? dependencies.verifier) ? {
        verification: { commands: input.verification, runner: input.verificationRunner ?? dependencies.verifier! },
      } : {}),
      ...(verificationGate !== undefined ? { verificationGate } : {}),
      submissionAudit: (submission: unknown) => auditRemediationSubmission(input.packet, frozenCommands, findings, submission),
      outputSchema: BuilderSubmissionSchema,
      modelPolicy: {
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
      },
    }, {
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(dependencies.onAgentEvent !== undefined ? { onEvent: dependencies.onAgentEvent } : {}),
    });
    const advanced = transition(run, "REMEDIATION_COMPLETED");
    await dependencies.runs.commit(run.version, advanced.state, advanced.record);
    return { run: advanced.state, submission: normalizeBuilderSubmission(input.packet, result.output), sessionRef: result.sessionRef };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (error instanceof RemediationAdmissionError) {
      const blocked = transition(run, "BLOCK", { reason });
      await dependencies.runs.commit(run.version, blocked.state, blocked.record);
      throw new WorkflowExecutionError(reason, blocked.state, { cause: error, recoverable: false });
    }
    const externalRetry = retryableExternalWorkflowError(error, run);
    if (externalRetry) throw externalRetry;
    if (isRecoverableAgentExecutionError(error)) {
      const checkpoint = transition(run, "RESUME_REMEDIATION", { reason });
      await dependencies.runs.commit(run.version, checkpoint.state, checkpoint.record);
      throw new WorkflowExecutionError(reason, checkpoint.state, { cause: error, recoverable: true });
    }
    const failed = transition(run, "FAIL", { reason });
    await dependencies.runs.commit(run.version, failed.state, failed.record);
    throw new WorkflowExecutionError(reason, failed.state, { cause: error });
  }
}

export interface MustFixCluster {
  id: string;
  family: string;
  rootIds: string[];
  productionPaths: string[];
  findings: DurableArtifact<"ReviewVerdict">["payload"]["findings"];
}

/** Deterministic bounded remediation packets: never silently omit an accepted root. */
export function clusterMustFixFindings(
  findings: DurableArtifact<"ReviewVerdict">["payload"]["findings"],
): MustFixCluster[] {
  const byFamily = new Map<string, typeof findings>();
  for (const finding of findings) {
    const structural = finding.normalizedRoot?.split("\n") ?? [];
    const family = [
      criterionFamilyForFinding(finding),
      structural.length >= 5 ? [structural[0], structural[1], structural[3], structural[4]].join("|") : finding.causalRoot ?? finding.title,
    ].join("::").toLowerCase();
    const existing = byFamily.get(family) ?? [];
    byFamily.set(family, [...existing, finding]);
  }
  const clusters: MustFixCluster[] = [];
  for (const [family, members] of byFamily) {
    for (let offset = 0; offset < members.length; offset += 3) {
      const chunk = members.slice(offset, offset + 3);
      const productionPaths = productionPathsFor(chunk);
      if (productionPaths.length > 4) {
        throw new RemediationAdmissionError(`MustFix cluster ${family} spans ${productionPaths.length} production paths; maximum is 4 and no root may be ignored`);
      }
      clusters.push({
        id: `mustfix-cluster-${clusters.length + 1}`,
        family,
        rootIds: chunk.map((finding) => finding.rootId ?? finding.normalizedRoot ?? finding.id),
        productionPaths,
        findings: chunk,
      });
    }
  }

  // A normalized family intentionally remains strict, but a family can be
  // split by the legacy three-root packet bound. Contract those shards in
  // stable order when they share the frozen criterion and the existing root
  // component/invariant safety boundary. Never merge on path overlap alone.
  const contracted: MustFixCluster[] = [];
  for (const cluster of clusters) {
    const target = contracted.find((candidate) => compatibleCluster(candidate, cluster));
    if (!target) {
      contracted.push({ ...cluster, id: `mustfix-cluster-${contracted.length + 1}` });
      continue;
    }
    target.rootIds.push(...cluster.rootIds);
    target.findings.push(...cluster.findings);
    target.productionPaths = [...new Set([...target.productionPaths, ...cluster.productionPaths])].sort();
  }
  if (contracted.length > 2) {
    throw new RemediationAdmissionError(`Review produced ${contracted.length} mustFix clusters; maximum is 2 and the controller refuses to hide known criterion violations`);
  }
  return contracted;
}

function productionPathsFor(findings: readonly MustFixCluster["findings"][number][]): string[] {
  return [...new Set(findings.flatMap((finding) => finding.location ? findingPaths(finding.location) : [])
    .filter((path): path is string => Boolean(path) && !isTestPath(path!)))].sort();
}

function findingPaths(location: string): string[] {
  return [...location.replaceAll("\\", "/").matchAll(/(?:^|[\s`(])([A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)+|[A-Za-z0-9_.@+-]+\.[A-Za-z0-9_.@+-]+)(?=[:#\s`),]|$)/g)]
    .map((match) => match[1])
    .filter((path): path is string => Boolean(path));
}

function compatibleCluster(left: MustFixCluster, right: MustFixCluster): boolean {
  if (criterionFamily(left.family) !== criterionFamily(right.family)) return false;
  const union = new Set([...left.productionPaths, ...right.productionPaths]);
  if (union.size > 4) return false;
  // Packet packing does not alias root identities. Preserve the root-ledger
  // component boundary: compatible shards must share at least one admitted
  // production path. This permits a connected controller/view-model packet
  // while keeping unrelated same-criterion components separate.
  return left.productionPaths.some((path) => right.productionPaths.includes(path));
}

function criterionFamilyForFinding(finding: MustFixCluster["findings"][number]): string {
  const criterionText = (finding.matchedAcceptanceCriteria ?? []).join(" ");
  const source = `${criterionText}\n${finding.normalizedRoot ?? ""}`;
  const match = /criterion[- ]([1-9][0-9]*)/i.exec(source);
  return match ? `criterion-${match[1]}` : `unclassified:${finding.causalRoot ?? finding.title}`;
}

function criterionFamily(family: string): string { return family.split("::", 1)[0] ?? family; }

function isTestPath(path: string): boolean { return /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[^.]+$/i.test(path); }

/**
 * The review root ledger is stricter than ordinary criterion coverage.  A
 * remediator may retain a correct implementation, but it must prove each
 * accepted root against the frozen criterion and a current implementation
 * anchor; prose or a changed-path claim cannot discharge a root.
 */
export function auditRemediationSubmission(
  packet: DurableArtifact<"BuildPacket">,
  commands: readonly VerificationCommand[],
  findings: readonly MustFixCluster["findings"][number][],
  submission: unknown,
): { code: string; criterionId?: string; message: string }[] {
  const diagnostics = [...auditBuilderCriterionCoverage(packet, commands, submission)];
  if (!submission || typeof submission !== "object") {
    return [...diagnostics, ...findings.map((finding) => ({
      code: "missing-remediation-root",
      message: `root ${rootIdentity(finding)} is unaddressed: submit criterion, production path, symbol, and focused test/invariant or frozen controller-check evidence.`,
    }))];
  }
  const coverage = Array.isArray((submission as Partial<BuilderSubmission>).criterionCoverage)
    ? (submission as Partial<BuilderSubmission>).criterionCoverage!
    : [];
  for (const finding of findings) {
    const root = rootIdentity(finding);
    const criterionId = criterionIdForFinding(packet, finding);
    const criterion = criterionId === undefined ? undefined : packet.payload.acceptanceCriteria[Number(criterionId.slice("criterion-".length)) - 1];
    if (criterionId === undefined || criterion === undefined) {
      diagnostics.push({ code: "root-missing-frozen-criterion", message: `root ${root} is unaddressed: it does not map to a frozen acceptance criterion (matched criteria: ${(finding.matchedAcceptanceCriteria ?? []).join(" | ") || "none"}).` });
      continue;
    }
    const item = coverage.find((entry) => entry && typeof entry === "object" && (entry as { criterionId?: unknown }).criterionId === criterionId) as BuilderSubmission["criterionCoverage"][number] | undefined;
    if (!item) {
      diagnostics.push({ code: "root-missing-criterion-coverage", criterionId, message: `root ${root} is unaddressed: missing ${criterionId} coverage for frozen criterion ${JSON.stringify(criterion)}.` });
      continue;
    }
    if (item.criterion !== criterion) {
      diagnostics.push({ code: "root-criterion-mismatch", criterionId, message: `root ${root} is unaddressed: ${criterionId} must match frozen criterion ${JSON.stringify(criterion)} exactly.` });
    }
    const anchors = item.anchors;
    const rootPaths = finding.location ? findingPaths(finding.location).filter((path) => !isTestPath(path)) : [];
    if (!anchors) {
      diagnostics.push({ code: "root-missing-anchors", criterionId, message: `root ${root} is unaddressed for ${criterionId}: missing current production path, symbol, and focused test/invariant or explicit frozen controller-check receipt.` });
      continue;
    }
    const missingPaths = rootPaths.filter((path) => !anchors.paths.includes(path));
    if (!rootPaths.length) {
      diagnostics.push({ code: "root-missing-production-path", criterionId, message: `root ${root} is unaddressed for ${criterionId}: review finding has no parseable production path to carry forward or fix.` });
    } else if (missingPaths.length) {
      diagnostics.push({ code: "root-missing-production-path", criterionId, message: `root ${root} is unaddressed for ${criterionId}: anchor current production path(s) ${missingPaths.join(", ")} (unchanged paths are valid; editing is not required).` });
    }
    if (!anchors.symbols.length) {
      diagnostics.push({ code: "root-missing-symbol-invariant", criterionId, message: `root ${root} is unaddressed for ${criterionId}: anchor the current production symbol or invariant.` });
    }
    const knownCommands = new Set(commands.map(({ id }) => id));
    const controllerReceipt = (anchors.verificationCommandIds ?? []).filter((id) => knownCommands.has(id));
    if (!anchors.testIds?.length && !controllerReceipt.length) {
      diagnostics.push({ code: "root-missing-focused-evidence", criterionId, message: `root ${root} is unaddressed for ${criterionId}: provide a focused test/invariant ID or an explicit frozen controller-check receipt.` });
    }
  }
  return diagnostics;
}

function rootIdentity(finding: MustFixCluster["findings"][number]): string {
  return finding.rootId ?? finding.normalizedRoot ?? finding.id;
}

function criterionIdForFinding(
  packet: DurableArtifact<"BuildPacket">,
  finding: MustFixCluster["findings"][number],
): string | undefined {
  const matched = finding.matchedAcceptanceCriteria ?? [];
  const exact = packet.payload.acceptanceCriteria.findIndex((criterion) => matched.includes(criterion));
  if (exact >= 0) return `criterion-${exact + 1}`;
  const normalized = finding.normalizedRoot?.match(/^criterion-([1-9][0-9]*)\\b/i)?.[1];
  if (normalized !== undefined && Number(normalized) <= packet.payload.acceptanceCriteria.length) return `criterion-${Number(normalized)}`;
  return undefined;
}

function remediationRootChecklist(
  packet: DurableArtifact<"BuildPacket">,
  findings: readonly MustFixCluster["findings"][number][],
): string[] {
  return findings.map((finding) => {
    const root = rootIdentity(finding);
    const criterionId = criterionIdForFinding(packet, finding) ?? "missing-frozen-criterion";
    const paths = finding.location ? findingPaths(finding.location).filter((path) => !isTestPath(path)) : [];
    return `${root} => ${criterionId}; production path(s)=${paths.join(", ") || "missing"}; prove with current symbol/invariant + focused test or frozen controller-check`;
  });
}
