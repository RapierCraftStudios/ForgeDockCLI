// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DurableArtifact } from "../../core/artifacts/schema.js";
import type { ForgeHost, PullRequestSnapshot } from "../../core/ports/forge-host.js";
import type { GitWorkspace, GitWorkspaceManager } from "../../core/ports/git-workspace.js";
import type { RunRepository } from "../../core/ports/repositories.js";
import { transition, type RunState } from "../../core/state/machine.js";
import { WorkflowExecutionError } from "./investigate.js";
import { assertRunTargetsBranch } from "./lane.js";

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
  dependencies: { git: GitWorkspaceManager; host: ForgeHost; runs: RunRepository },
): Promise<{ run: RunState; pullRequest: PullRequestSnapshot }> {
  if (input.run.state !== "publishing") throw new Error(`Publication requires publishing state, found ${input.run.state}`);
  let run = input.run;
  try {
    const targetBranch = input.parentRemediation?.parentBranch ?? run.targetBranch;
    if (!targetBranch) throw new Error(`Run ${run.runId} has no frozen target branch`);
    if (!input.parentRemediation) assertWorkspaceFollowsTarget(input.workspace, targetBranch);
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
    const failed = transition(run, "FAIL", { reason });
    await dependencies.runs.commit(run.version, failed.state, failed.record);
    throw new WorkflowExecutionError(reason, failed.state, { cause: error });
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
