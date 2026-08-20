// SPDX-License-Identifier: AGPL-3.0-or-later

import { createArtifact, type DurableArtifact } from "../../core/artifacts/schema.js";
import type { RetryClassification } from "../../core/retry.js";
import type { ForgeHost, PullRequestSnapshot } from "../../core/ports/forge-host.js";
import type { GitWorkspace, GitWorkspaceManager } from "../../core/ports/git-workspace.js";
import type { ArtifactRepository, RunRepository } from "../../core/ports/repositories.js";
import { transition, type RunState } from "../../core/state/machine.js";
import { deterministicOutcomeId, WorkflowExecutionError } from "./investigate.js";
import { assertRunTargetsBranch } from "./lane.js";
import { normalizedTargetRouteClaim, persistTargetAdvanceCheckpoint } from "./target-recovery.js";

export function assertParentRemediationPullRequestTarget(input: {
  parentBranch: string;
  pullRequest: PullRequestSnapshot;
  parentPullRequest: number;
}): void {
  if (input.pullRequest.baseBranch !== input.parentBranch) {
    throw new Error(`Parent remediation child PR #${input.pullRequest.number} must target ${input.parentBranch}, not ${input.pullRequest.baseBranch}`);
  }
  if (!Number.isSafeInteger(input.parentPullRequest) || input.parentPullRequest < 1) throw new Error("Parent remediation pull request identity is invalid");
}

export async function publishPullRequest(
  input: {
    run: RunState;
    intent: DurableArtifact<"Intent">;
    packet: DurableArtifact<"BuildPacket">;
    buildResult: DurableArtifact<"BuildResult">;
    workspace: GitWorkspace;
    parentRemediation?: { parentBranch: string; parentPullRequest: number };
  },
  dependencies: { git: GitWorkspaceManager; host: ForgeHost; runs: RunRepository; artifacts?: ArtifactRepository },
): Promise<{ run: RunState; pullRequest: PullRequestSnapshot }> {
  if (input.run.state !== "publishing") throw new Error(`Publication requires publishing state, found ${input.run.state}`);
  let run = input.run;
  try {
    const targetBranch = input.parentRemediation?.parentBranch ?? run.targetBranch;
    if (!targetBranch) throw new Error(`Run ${run.runId} has no frozen target branch`);
    if (!input.parentRemediation) assertWorkspaceFollowsTarget(input.workspace, targetBranch);
    await assertTargetHeadUnchanged(
      dependencies.host,
      run.subject.repo,
      targetBranch,
      input.buildResult.payload.baseSha,
    );
    const workspaceHead = await dependencies.git.head(input.workspace);
    if (workspaceHead !== input.buildResult.payload.headSha) {
      throw new Error(`Publication workspace head ${workspaceHead} does not match verified build ${input.buildResult.payload.headSha}`);
    }
    const issue = run.subject.issue;
    if (!issue) throw new Error("work-on publication requires an issue subject");
    const existing = await dependencies.host.findOpenPullRequest?.(run.subject.repo, input.workspace.branch);
    if (existing && !input.parentRemediation) assertRunTargetsBranch(run, existing.baseBranch);
    await dependencies.git.push(input.workspace);
    const body = renderPullRequestHandoff({
      issue,
      packet: input.packet,
      buildResult: input.buildResult,
    });
    const pullRequest = existing
      ? await refreshPublishedPullRequest(dependencies.host, existing, input.workspace.branch, input.buildResult.payload.headSha)
      : await dependencies.host.createPullRequest({
        repo: run.subject.repo,
        issue,
        headBranch: input.workspace.branch,
        baseBranch: targetBranch,
        title: input.intent.payload.title,
        body,
      });
    if (input.parentRemediation) assertParentRemediationPullRequestTarget({ ...input.parentRemediation, pullRequest });
    else assertRunTargetsBranch(run, pullRequest.baseBranch);
    if (pullRequest.headBranch !== input.workspace.branch) {
      throw new Error(`Published PR branch ${pullRequest.headBranch} does not match delivery branch ${input.workspace.branch}`);
    }
    if (pullRequest.headSha !== input.buildResult.payload.headSha) {
      throw new Error(`Published PR head ${pullRequest.headSha} does not match verified build ${input.buildResult.payload.headSha}`);
    }
    const advanced = transition(run, "PR_PUBLISHED", { headSha: pullRequest.headSha });
    await dependencies.runs.commit(run.version, advanced.state, advanced.record);
    return { run: advanced.state, pullRequest };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (error instanceof TargetBranchAdvancedError) {
      const targetBranch = error.targetBranch;
      // The checkpoint is durable before the state transition. A restart can
      // therefore recover the exact target route even if projection fails.
      const checkpoint = await persistTargetAdvanceCheckpoint({
        run,
        packet: input.packet,
        buildResult: input.buildResult,
        workspace: input.workspace,
        targetBranch,
        observedTargetSha: error.observedBaseSha,
        phase: "target-read",
        ...(dependencies.artifacts ? { artifacts: dependencies.artifacts } : {}),
      });
      const retryDisposition: RetryClassification = {
        disposition: "retryable",
        retryable: true,
        domain: "workflow",
        code: "target-advanced",
        cause: error,
      };
      const next = transition(run, "TARGET_ADVANCE_DETECTED", {
        reason: `${reason}; route=${normalizedTargetRouteClaim(run.subject.repo, targetBranch)}`,
      });
      await dependencies.runs.commit(run.version, next.state, next.record);
      throw new WorkflowExecutionError(reason, next.state, {
        cause: error, retryDisposition,
        ...(checkpoint ? { checkpointId: checkpoint.id } : {}),
      });
    }
    const next = transition(run, "FAIL", { reason });
    await dependencies.runs.commit(run.version, next.state, next.record);
    throw new WorkflowExecutionError(reason, next.state, { cause: error });
  }
}

export class TargetBranchAdvancedError extends Error {
  constructor(readonly targetBranch: string, readonly expectedBaseSha: string, readonly observedBaseSha: string) {
    super(`Target branch ${targetBranch} advanced before publication: expected ${expectedBaseSha}, observed ${observedBaseSha}`);
    this.name = "TargetBranchAdvancedError";
  }
}

export async function recordTargetFenceOutcome(
  run: RunState,
  reason: string,
  artifacts: ArtifactRepository,
  pullRequestUrl?: string,
): Promise<void> {
  await artifacts.append(createArtifact({
    kind: "Outcome",
    runId: run.runId,
    subject: run.subject,
    producer: { role: "controller", runtime: "forgedock" },
    payload: {
      status: "blocked",
      reason,
      ...(run.targetBranch ? { targetBranch: run.targetBranch } : {}),
      ...(run.promotionTarget ? { promotionTarget: run.promotionTarget } : {}),
      ...(run.productionTarget ? { productionTarget: run.productionTarget } : {}),
      ...(pullRequestUrl ? { prUrl: pullRequestUrl } : {}),
      childIssues: [],
    },
  }, {
    id: deterministicOutcomeId(run.runId, run.subject, `blocked:target-fence:${reason}`),
  }));
}

/**
 * Fence the target branch immediately before a delivery push. Older durable
 * BuildResults may not carry a base SHA, so those legacy checkpoints retain
 * their existing compatibility behavior; every current controller build has
 * one through GitWorkspace/BuildResult.
 */
export async function assertTargetHeadUnchanged(
  host: ForgeHost,
  repo: string,
  targetBranch: string,
  expectedBaseSha?: string,
): Promise<void> {
  if (expectedBaseSha === undefined) return;
  if (!host.getBranchHead) throw new Error(`Publication requires an authoritative target branch head reader for ${targetBranch}`);
  const observed = await host.getBranchHead(repo, targetBranch);
  if (observed.toLowerCase() !== expectedBaseSha.toLowerCase()) {
    throw new TargetBranchAdvancedError(targetBranch, expectedBaseSha, observed);
  }
}

async function refreshPublishedPullRequest(
  host: ForgeHost,
  existing: PullRequestSnapshot,
  branch: string,
  expectedHeadSha: string,
): Promise<PullRequestSnapshot> {
  const refreshed = await host.getPullRequest(existing.repo, existing.number);
  if (refreshed.headSha.toLowerCase() === expectedHeadSha.toLowerCase()) return refreshed;
  // A successful push can reach the ref before the PR projection catches up.
  // The branch ref is the direct source of truth for the exact published head.
  const branchHead = host.getBranchHead ? await host.getBranchHead(existing.repo, branch) : undefined;
  return branchHead?.toLowerCase() === expectedHeadSha.toLowerCase()
    ? { ...refreshed, headSha: branchHead }
    : refreshed;
}

function assertWorkspaceFollowsTarget(workspace: GitWorkspace, targetBranch: string): void {
  if (workspace.baseRef !== targetBranch && workspace.baseRef !== `origin/${targetBranch}`) {
    throw new Error(`Workspace ${workspace.branch} follows ${workspace.baseRef}, not frozen target ${targetBranch}`);
  }
}

const MAX_HANDOFF_BODY_CHARS = 60_000;
const MAX_LIST_ITEMS = 8;

export function renderPullRequestHandoff(input: {
  issue: number;
  packet: DurableArtifact<"BuildPacket">;
  buildResult: DurableArtifact<"BuildResult">;
}): string {
  const { packet, buildResult } = input;
  const lines = [
    `Closes #${input.issue}`,
    "",
    "## ForgeDock verified handoff",
    "",
    `- Run: \`${packet.runId}\``,
    `- Build Packet: \`${packet.id}\` (durable artifact on the linked issue)`,
    `- Build Result: \`${buildResult.id}\` (durable artifact on the linked issue)`,
    `- Verified head: \`${buildResult.payload.headSha}\``,
    "",
    "### Summary",
    boundedText(buildResult.payload.summary, 2_000),
    "",
    "### Changed paths",
    ...boundedList(buildResult.payload.changedPaths, (path) => `- \`${boundedText(path, 500)}\``),
    "",
    "### Acceptance evidence",
    ...boundedList(buildResult.payload.acceptanceEvidence, (item) =>
      `- **${boundedText(item.status, 20)}** — ${boundedText(item.criterion, 500)}: ${boundedText(item.evidence, 1_000)}`),
    "",
    "### Verification",
    ...boundedList(buildResult.payload.checks, (check) =>
      `- **${boundedText(check.status, 20)}** — \`${boundedText(check.command, 1_000)}\`${check.summary ? ` — ${boundedText(check.summary, 1_000)}` : ""}`),
    "",
    "### Residual risks",
    ...(buildResult.payload.residualRisks.length
      ? boundedList(buildResult.payload.residualRisks, (risk) => `- ${boundedText(risk, 1_000)}`)
      : ["- None reported."]),
    "",
    `<!-- FORGEDOCK:HANDOFF run=${packet.runId} packet=${packet.id} build=${buildResult.id} sha=${buildResult.payload.headSha} -->`,
  ];
  const body = lines.join("\n");
  if (body.length > MAX_HANDOFF_BODY_CHARS) {
    throw new Error(`Compact pull request handoff exceeded ${MAX_HANDOFF_BODY_CHARS} characters`);
  }
  return body;
}

function boundedList<T>(items: readonly T[], render: (item: T) => string): string[] {
  const visible = items.slice(0, MAX_LIST_ITEMS).map(render);
  if (items.length > visible.length) visible.push(`- … ${items.length - visible.length} additional item(s); see the durable issue artifact.`);
  return visible.length ? visible : ["- None."];
}

function boundedText(value: string, maximum: number): string {
  const normalized = value.replaceAll("\u0000", "").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
}
