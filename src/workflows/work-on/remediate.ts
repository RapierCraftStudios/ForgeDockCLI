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
import { BuilderSubmissionSchema, criterionCoverageInstructions, deriveBuilderVerificationGate, normalizeBuilderSubmission, type BuilderSubmission } from "./build.js";
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
  let run = input.run;
  try {
    // Admission is controller-owned and deliberately inside the guarded path:
    // deterministic scope/packet rejection must block, never enter an agent
    // retry loop or leave a failed run that ordinary resume will replay.
    const clusters = clusterMustFixFindings(findings);
    const reviewCycle = input.reviewCycle ?? { current: 1, total: 1 };
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
      objective: `Fix every open controller-accepted mustFix root from review of ${input.verdict.payload.headSha}. Roots are bounded into at most two coherent clusters; no listed criterion violation may be ignored:\n${JSON.stringify(clusters, null, 2)}`,
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
      (finding.matchedAcceptanceCriteria ?? []).map((criterion) => /criterion-[1-9][0-9]*/i.exec(criterion)?.[0] ?? criterion).sort().join("|"),
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
  if (rootSafety(left.findings) !== rootSafety(right.findings)) return false;
  const union = new Set([...left.productionPaths, ...right.productionPaths]);
  return union.size <= 4;
}

function criterionFamily(family: string): string { return family.split("::", 1)[0] ?? family; }

/** Component and invariant are durable root-ledger boundaries. */
function rootSafety(findings: readonly MustFixCluster["findings"][number][]): string {
  const signatures = findings.map((finding) => {
    const structural = finding.normalizedRoot?.split("\n") ?? [];
    const component = structural[1] ?? finding.location?.split(":", 1)[0] ?? "unanchored";
    const invariant = structural[3] ?? finding.impact?.affectedInvariant ?? "unspecified";
    return `${component.toLowerCase()}::${invariant.toLowerCase()}`;
  });
  return [...new Set(signatures)].sort().join("|");
}

function isTestPath(path: string): boolean { return /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[^.]+$/i.test(path); }
