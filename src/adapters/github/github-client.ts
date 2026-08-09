// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { findArtifacts, renderArtifactComment } from "../../core/artifacts/codec.js";
import type { ArtifactKind, DurableArtifact, Subject } from "../../core/artifacts/schema.js";
import type { RunState, RunStateName } from "../../core/state/machine.js";
import type { BranchSnapshot, DecompositionChild, ForgeHost, IssueSnapshot, PullRequestSnapshot, ReviewFindingInput } from "../../core/ports/forge-host.js";
import type { ArtifactRepository } from "../../core/ports/repositories.js";
import { parseBatchContract } from "../../workflows/orchestrate/batching.js";

export function repositoryFromRemote(remote: string): string | undefined {
  const match = /github\.com[/:]([^/\s:]+)\/([^/\s]+?)(?:\.git)?$/i.exec(remote.trim().replace(/\/+$/, ""));
  return match ? `${match[1]}/${match[2]}` : undefined;
}

const WORKFLOW_LABELS = [
  { name: "workflow:investigating", color: "1D76DB", description: "ForgeDock investigation is active" },
  { name: "workflow:ready-to-build", color: "0E8A16", description: "ForgeDock investigation is complete and build is ready" },
  { name: "workflow:building", color: "FBCA04", description: "ForgeDock build or verification is active" },
  { name: "workflow:in-review", color: "5319E7", description: "ForgeDock pull-request review is active" },
  { name: "workflow:awaiting-merge", color: "D4C5F9", description: "ForgeDock review passed and awaits a human merge" },
  { name: "workflow:merged", color: "0E8A16", description: "ForgeDock delivery completed and merged" },
  { name: "workflow:invalid", color: "B60205", description: "ForgeDock investigation found the issue invalid" },
  { name: "workflow:decomposed", color: "C2E0C6", description: "ForgeDock split the issue into smaller delivery units" },
  { name: "workflow:engine-error", color: "B60205", description: "ForgeDock runtime or tool failure requires recovery" },
  { name: "needs-human", color: "D93F0B", description: "ForgeDock requires a human decision or intervention" },
] as const;

const WORKFLOW_LABEL_NAMES = WORKFLOW_LABELS.map((label) => label.name);

const REVIEW_FINDING_LABELS = [
  { name: "review-finding", color: "D93F0B", description: "Defect or improvement found during independent PR review" },
  { name: "needs-validation", color: "FBCA04", description: "Review finding awaiting validation" },
  { name: "priority:P0", color: "B60205", description: "Critical priority" },
  { name: "priority:P1", color: "D93F0B", description: "High priority" },
  { name: "priority:P2", color: "FBCA04", description: "Medium priority" },
  { name: "priority:P3", color: "0E8A16", description: "Low priority" },
] as const;

export function workflowLabelForState(state: RunStateName): string | undefined {
  if (state === "investigating") return "workflow:investigating";
  if (state === "preparing") return "workflow:ready-to-build";
  if (state === "building" || state === "verifying" || state === "publishing" || state === "remediating") return "workflow:building";
  if (state === "reviewing") return "workflow:in-review";
  if (state === "merging") return "workflow:awaiting-merge";
  if (state === "closing" || state === "completed") return "workflow:merged";
  if (state === "invalid") return "workflow:invalid";
  if (state === "decomposed") return "workflow:decomposed";
  if (state === "blocked") return "needs-human";
  if (state === "failed") return "workflow:engine-error";
  return undefined;
}

export interface GitHubIssueComment {
  author: string;
  createdAt: string;
  body: string;
  url?: string;
  containsArtifact: boolean;
}

export interface GitHubIssue {
  repo: string;
  number: number;
  title: string;
  body: string;
  url: string;
  state: "OPEN" | "CLOSED";
  labels: string[];
  milestone?: { number: number; title: string };
  comments: GitHubIssueComment[];
}

export interface BatchIssueInput {
  repo: string;
  title: string;
  body: string;
  priorityLabel: "priority:P0" | "P0" | "priority:P1" | "P1" | "priority:P2" | "P2" | "priority:P3" | "P3";
  milestone?: string;
}

export class GitHubClient implements ForgeHost {
  private readonly initializedLabelRepos = new Map<string, Promise<void>>();
  private readonly initializedReviewFindingRepos = new Map<string, Promise<void>>();

  constructor(readonly cwd = process.cwd()) {}

  async resolveRepository(): Promise<string> {
    return (await this.getRepository()).repo;
  }

  async getRepository(repo?: string): Promise<{ repo: string; defaultBranch: string }> {
    // gh defaults to the first remote, which can be `upstream` in a staging
    // worktree. ForgeDock targets the checkout's origin, not the source fork.
    const originRepo = repo ?? await this.resolveOriginRepository();
    const result = await this.gh(["repo", "view", ...(originRepo ? [originRepo] : []), "--json", "nameWithOwner,defaultBranchRef"]);
    const parsed = JSON.parse(result) as { nameWithOwner?: string; defaultBranchRef?: { name?: string } };
    if (!parsed.nameWithOwner || !parsed.defaultBranchRef?.name) throw new Error("Unable to resolve GitHub repository and default branch");
    return { repo: parsed.nameWithOwner, defaultBranch: parsed.defaultBranchRef.name };
  }

  async listOpenIssueNumbersForMilestone(title: string, repo?: string): Promise<number[]> {
    const resolvedRepo = repo ?? await this.resolveRepository();
    const result = await this.gh([
      "issue", "list", "--repo", resolvedRepo, "--state", "open",
      "--milestone", title, "--limit", "1000", "--json", "number,milestone",
    ]);
    const issues = JSON.parse(result) as Array<{ number?: number; milestone?: { title?: string } | null }>;
    return issues
      .filter((issue) => issue.milestone?.title === title && Number.isSafeInteger(issue.number))
      .map((issue) => issue.number!)
      .sort((left, right) => left - right);
  }

  async getIssue(number: number, repo?: string): Promise<GitHubIssue> {
    const resolvedRepo = repo ?? await this.resolveRepository();
    const result = await this.gh([
      "issue", "view", String(number), "--repo", resolvedRepo,
      "--json", "number,title,body,url,state,labels,milestone",
    ]);
    const issue = JSON.parse(result) as Omit<GitHubIssue, "repo" | "labels" | "comments" | "milestone"> & {
      labels?: Array<{ name?: string }>;
      milestone?: { number: number; title: string } | null;
    };
    const comments = await this.listIssueCommentSnapshots({ repo: resolvedRepo, issue: number });
    const { milestone, ...snapshot } = issue;
    return {
      ...snapshot,
      body: issue.body ?? "",
      labels: issue.labels?.flatMap((label) => label.name ? [label.name] : []) ?? [],
      ...(milestone ? { milestone } : {}),
      comments,
      repo: resolvedRepo,
    };
  }

  async listIssueComments(subject: Subject): Promise<string[]> {
    return (await this.listIssueCommentSnapshots(subject)).map((comment) => comment.body);
  }

  async listIssueCommentSnapshots(subject: Subject): Promise<GitHubIssueComment[]> {
    const number = subject.pr ?? subject.issue;
    if (!number) throw new Error("GitHub artifacts require an issue or pull request number");
    const result = await this.gh(["api", `repos/${subject.repo}/issues/${number}/comments?per_page=100`, "--paginate", "--slurp"]);
    const pages = JSON.parse(result) as Array<Array<{ body?: string; created_at?: string; html_url?: string; user?: { login?: string } }>>;
    return pages.flat().map((comment) => {
      const body = comment.body ?? "";
      return {
        author: comment.user?.login ?? "unknown",
        createdAt: comment.created_at ?? new Date(0).toISOString(),
        body,
        ...(comment.html_url ? { url: comment.html_url } : {}),
        containsArtifact: findArtifacts(body).length > 0,
      };
    });
  }

  async postIssueComment(subject: Subject, body: string): Promise<void> {
    const number = subject.pr ?? subject.issue;
    if (!number) throw new Error("GitHub artifacts require an issue or pull request number");
    await this.gh(
      ["api", `repos/${subject.repo}/issues/${number}/comments`, "--method", "POST", "--input", "-"],
      JSON.stringify({ body }),
    );
  }

  async publishPullRequestComment(input: { repo: string; pullRequest: number; marker: string; body: string }): Promise<void> {
    if (!input.body.includes(input.marker)) throw new Error("Reviewer comment body is missing its idempotency marker");
    const subject = { repo: input.repo, pr: input.pullRequest };
    const comments = await this.listIssueComments(subject);
    if (!comments.some((comment) => comment.includes(input.marker))) {
      await this.postIssueComment(subject, input.body);
    }
  }

  async publishIssueComment(input: { repo: string; issue: number; marker: string; body: string }): Promise<void> {
    if (!input.body.includes(input.marker)) throw new Error("Issue comment is missing its idempotency marker");
    const comments = await this.listIssueComments({ repo: input.repo, issue: input.issue });
    if (!comments.some((comment) => comment.includes(input.marker))) {
      await this.postIssueComment({ repo: input.repo, issue: input.issue }, input.body);
    }
  }

  async materializeReviewFinding(input: {
    repo: string;
    sourceIssue?: number;
    pullRequest: PullRequestSnapshot;
    runId: string;
    reviewedHeadSha: string;
    reviewerRoles: readonly string[];
    finding: ReviewFindingInput;
  }): Promise<IssueSnapshot> {
    await this.ensureReviewFindingLabels(input.repo);
    const marker = reviewFindingMarker(input.repo, input.pullRequest.number, input.finding);
    const legacyMarker = legacyReviewFindingMarker(input.repo, input.pullRequest.number, input.finding);
    const existing = (await this.listAllIssues(input.repo)).find((issue) => issue.body.includes(marker)
      || (marker !== legacyMarker && issue.body.includes(legacyMarker)));
    if (existing) return existing;

    const priority = reviewFindingPriority(input.finding.severity);
    const title = boundedGitHubText(`fix: ${input.finding.title} (review finding — PR #${input.pullRequest.number})`, 240).replace(/[\r\n]+/g, " ");
    const affectedFile = reviewFindingPath(input.finding.location);
    const sensitive = /security|auth|billing|payment|stripe|credential|secret|token/i.test(`${affectedFile ?? ""} ${input.finding.title}`);
    const body = [
      "## Problem",
      "",
      boundedGitHubText(input.finding.title, 1_000),
      "",
      `**Source:** PR #${input.pullRequest.number} — ${boundedGitHubText(input.pullRequest.title, 500)}`,
      ...(input.sourceIssue ? [`**Delivery issue:** #${input.sourceIssue}`] : []),
      `**Reviewed SHA:** \`${input.reviewedHeadSha}\``,
      `**Run:** \`${boundedGitHubCode(input.runId)}\``,
      `**Reviewers:** ${input.reviewerRoles.map((role) => `\`${boundedGitHubCode(role)}\``).join(", ")}`,
      ...(input.finding.sourceFindingIds?.length ? [`**Source findings:** ${input.finding.sourceFindingIds.map((id) => `\`${boundedGitHubCode(id)}\``).join(", ")}`] : []),
      ...(input.finding.sourceSessionRefs?.length ? [`**Reviewer sessions:** ${input.finding.sourceSessionRefs.map((ref) => `\`${boundedGitHubCode(ref)}\``).join(", ")}`] : []),
      `**Confidence:** ${input.finding.confidence.toUpperCase()}`,
      `**Severity:** ${input.finding.severity.toUpperCase()}`,
      `**Controller disposition:** ${input.finding.blocking ? "blocking" : "non-blocking"}`,
      ...(input.finding.scopeDisposition ? [`**Scope disposition:** ${input.finding.scopeDisposition}`] : []),
      ...(input.finding.scopeRationale ? [`**Scope rationale:** ${boundedGitHubText(input.finding.scopeRationale, 3_000)}`] : []),
      ...(input.finding.matchedAcceptanceCriteria?.length
        ? [`**Matched acceptance criteria:** ${input.finding.matchedAcceptanceCriteria.map((criterion) => boundedGitHubText(criterion, 1_000)).join("; ")}`]
        : []),
      "",
      "## Affected Files",
      "",
      affectedFile ? `- \`${boundedGitHubCode(affectedFile)}\`${input.finding.location ? ` — ${boundedGitHubText(input.finding.location, 1_000)}` : ""}` : "- Location not reported; validate during investigation.",
      "",
      "## Evidence",
      "",
      boundedGitHubText(input.finding.evidence, 8_000),
      "",
      "## Intent Relevance",
      "",
      boundedGitHubText(input.finding.intentRelevance, 4_000),
      "",
      "## Required Remediation",
      "",
      boundedGitHubText(input.finding.remediation, 4_000),
      "",
      "## Acceptance Criteria",
      "",
      "- [ ] Validate the finding against the reviewed SHA and current target branch.",
      "- [ ] Implement or explicitly reject the finding with concrete evidence.",
      "- [ ] Add focused regression coverage when applicable.",
      ...(priority === "priority:P3" && !sensitive ? ["", "<!-- FORGE:BATCHABLE -->"] : []),
      "",
      marker,
    ].join("\n");

    const metadata = JSON.parse(await this.gh(["api", `repos/${input.repo}/issues/${input.pullRequest.number}`])) as {
      milestone?: { title?: string } | null;
    };
    const args = [
      "issue", "create", "--repo", input.repo, "--title", title, "--body-file", "-",
      "--label", "review-finding", "--label", "needs-validation", "--label", priority,
    ];
    if (metadata.milestone?.title) args.push("--milestone", metadata.milestone.title);
    const url = (await this.gh(args, body)).trim();
    const number = Number(url.split("/").at(-1));
    if (!url || !Number.isSafeInteger(number) || number < 1) throw new Error("GitHub did not return a review-finding issue number");
    return { repo: input.repo, number, title, body, url, state: "OPEN" };
  }

  async reconcileReviewFindings(input: {
    repo: string;
    pullRequest: PullRequestSnapshot;
    runId: string;
    activeFindings: readonly ReviewFindingInput[];
  }): Promise<readonly number[]> {
    const stale = reviewFindingReconciliationCandidates(await this.listAllIssues(input.repo), input);
    for (const issue of stale) {
      await this.gh([
        "issue", "close", String(issue.number), "--repo", input.repo, "--reason", "completed",
        "--comment", `Superseded by the authoritative Review Verdict for PR #${input.pullRequest.number} at ${input.pullRequest.headSha}; this finding is no longer active.`,
      ]);
    }
    return stale.map((issue) => issue.number);
  }

  private async ensureReviewFindingLabels(repo: string): Promise<void> {
    let initialization = this.initializedReviewFindingRepos.get(repo);
    if (!initialization) {
      initialization = Promise.all(REVIEW_FINDING_LABELS.map((label) => this.gh([
        "label", "create", label.name, "--repo", repo, "--color", label.color,
        "--description", label.description, "--force",
      ]))).then(() => undefined);
      this.initializedReviewFindingRepos.set(repo, initialization);
      initialization.catch(() => this.initializedReviewFindingRepos.delete(repo));
    }
    await initialization;
  }

  async projectRunState(state: RunState): Promise<void> {
    const issue = state.subject.issue;
    if (!issue) return;
    await this.ensureWorkflowLabels(state.subject.repo);
    const target = workflowLabelForState(state.state);
    const labelResult = await this.gh(["issue", "view", String(issue), "--repo", state.subject.repo, "--json", "labels"]);
    const current = (JSON.parse(labelResult) as { labels?: Array<{ name?: string }> }).labels?.flatMap((label) => label.name ? [label.name] : []) ?? [];
    const remove = current.filter((label) => WORKFLOW_LABEL_NAMES.includes(label as (typeof WORKFLOW_LABEL_NAMES)[number]) && label !== target);
    const args = ["issue", "edit", String(issue), "--repo", state.subject.repo];
    if (target && !current.includes(target)) args.push("--add-label", target);
    if (remove.length) args.push("--remove-label", remove.join(","));
    if ((target && !current.includes(target)) || remove.length) await this.gh(args);
  }

  async ensureWorkflowLabels(repo: string): Promise<void> {
    let initialization = this.initializedLabelRepos.get(repo);
    if (!initialization) {
      initialization = Promise.all(WORKFLOW_LABELS.map((label) => this.gh([
        "label", "create", label.name, "--repo", repo, "--color", label.color,
        "--description", label.description, "--force",
      ]))).then(() => undefined);
      this.initializedLabelRepos.set(repo, initialization);
      initialization.catch(() => this.initializedLabelRepos.delete(repo));
    }
    await initialization;
  }

  async materializeDecomposition(input: {
    repo: string;
    parentIssue: number;
    children: DecompositionChild[];
  }): Promise<IssueSnapshot[]> {
    const ordered = orderDecompositionChildren(input.children);
    const parent = await this.getIssue(input.parentIssue, input.repo);
    const inheritedLabels = parent.labels.filter((label) => !label.startsWith("workflow:") && label !== "needs-human");
    const existing = await this.listAllIssues(input.repo);
    const byMarker = new Map(existing.flatMap((issue) => {
      const match = /<!-- FORGEDOCK:DECOMPOSITION ([a-f0-9]{64}) -->/.exec(issue.body);
      return match?.[1] ? [[match[1], issue] as const] : [];
    }));
    const materialized = new Map<string, IssueSnapshot>();

    for (const child of ordered) {
      const marker = decompositionMarker(input.repo, input.parentIssue, child.title);
      let issue = byMarker.get(marker);
      if (!issue) {
        const dependencyLines = child.dependsOn.length
          ? child.dependsOn.map((dependency) => {
            const resolved = materialized.get(dependency);
            return resolved ? `- #${resolved.number} — ${resolved.title}` : `- ${dependency}`;
          })
          : ["- None"];
        const body = [
          "## Problem",
          `Parent issue #${input.parentIssue} was decomposed because this outcome requires an independent implementation and review boundary.`,
          "",
          "## Intended outcome",
          child.outcome,
          "",
          "## Affected files",
          "To be confirmed by investigation.",
          "",
          "## Dependencies",
          ...dependencyLines,
          "",
          "## Acceptance criteria",
          `- [ ] ${child.outcome}`,
          `- [ ] Delivery is independently verified and reviewed against parent #${input.parentIssue}.`,
          "",
          "## Parent",
          `- #${input.parentIssue} — ${parent.title}`,
          "",
          `<!-- FORGEDOCK:DECOMPOSITION ${marker} -->`,
        ].join("\n");
        const args = ["issue", "create", "--repo", input.repo, "--title", child.title, "--body-file", "-"];
        for (const label of inheritedLabels) args.push("--label", label);
        const url = (await this.gh(args, body)).trim();
        const number = Number(url.split("/").at(-1));
        if (!Number.isSafeInteger(number) || number < 1) throw new Error(`GitHub did not return a child issue number for '${child.title}'`);
        issue = { repo: input.repo, number, title: child.title, body, url, state: "OPEN" };
        byMarker.set(marker, issue);
      }
      materialized.set(child.title, issue);
    }

    return input.children.map((child) => {
      const issue = materialized.get(child.title);
      if (!issue) throw new Error(`Decomposition child was not materialized: ${child.title}`);
      return issue;
    });
  }

  async materializeRemediationChildren(input: {
    repo: string;
    parentRunId: string;
    parentIssue: number;
    parentPullRequest: number;
    headSha: string;
    headBranch: string;
    baseBranch: string;
    checkpointKey: string;
    remediationDepth: number;
    findings: readonly {
      id: string;
      title: string;
      evidence: string;
      location: string;
      remediation: string;
      acceptanceCriterion: string;
    }[];
  }): Promise<IssueSnapshot[]> {
    if (!input.findings.length) return [];
    const existing = await this.listAllIssues(input.repo);
    const byMarker = new Map(existing.flatMap((issue) => {
      const match = /<!-- FORGEDOCK:REMEDIATION_CHILD ([a-f0-9]{64}) -->/.exec(issue.body);
      return match?.[1] ? [[match[1], issue] as const] : [];
    }));
    const created: IssueSnapshot[] = [];
    for (const finding of input.findings) {
      const marker = remediationChildMarker(input.repo, input.parentRunId, input.parentIssue, input.parentPullRequest, input.headSha, finding.id);
      const existingIssue = byMarker.get(marker);
      if (existingIssue) {
        created.push(existingIssue);
        continue;
      }
      const title = boundedGitHubText(`fix: ${finding.title} (remediation for #${input.parentIssue})`, 240).replace(/[\r\n]+/g, " ");
      const body = [
        "## Problem", "", boundedGitHubText(finding.title, 1_000), "",
        `**Parent issue:** #${input.parentIssue}`,
        `**Parent PR:** #${input.parentPullRequest}`,
        `**Parent delivery branch:** \`${boundedGitHubCode(input.headBranch)}\``,
        `**Original target branch:** \`${boundedGitHubCode(input.baseBranch)}\``,
        `**Parent head SHA:** \`${boundedGitHubCode(input.headSha)}\``,
        `**Parent run:** \`${boundedGitHubCode(input.parentRunId)}\``,
        `**Checkpoint:** \`${boundedGitHubCode(input.checkpointKey)}\``,
        `**Remediation depth:** ${input.remediationDepth}`,
        `**Finding ID:** \`${boundedGitHubCode(finding.id)}\``,
        "", "## Evidence", "", boundedGitHubText(finding.evidence, 6_000),
        "", "## Location", "", `- \`${boundedGitHubCode(finding.location)}\``,
        "", "## Acceptance Criteria", "", `- [ ] ${boundedGitHubText(finding.acceptanceCriterion, 2_000)}`,
        "", "## Required Remediation", "", boundedGitHubText(finding.remediation, 4_000),
        "", marker,
      ].join("\n");
      const url = (await this.gh(["issue", "create", "--repo", input.repo, "--title", title, "--body-file", "-"], body)).trim();
      const number = Number(url.split("/").at(-1));
      if (!url || !Number.isSafeInteger(number) || number < 1) throw new Error("GitHub did not return a remediation issue number");
      const issue: IssueSnapshot = { repo: input.repo, number, title, body, url, state: "OPEN" };
      byMarker.set(marker, issue);
      created.push(issue);
    }
    return created;
  }

  async createPullRequest(input: {
    repo: string; issue: number; headBranch: string; baseBranch: string; title: string; body: string;
  }): Promise<PullRequestSnapshot> {
    const url = (await this.gh([
      "pr", "create", "--repo", input.repo, "--head", input.headBranch, "--base", input.baseBranch,
      "--title", input.title, "--body-file", "-",
    ], input.body)).trim();
    if (!url) throw new Error("GitHub did not return a pull request URL");
    return this.getPullRequest(input.repo, Number(url.split("/").at(-1)));
  }

  async getPullRequest(repo: string, number: number): Promise<PullRequestSnapshot> {
    const result = await this.gh([
      "pr", "view", String(number), "--repo", repo,
      "--json", "number,title,body,url,state,headRefOid,headRefName,baseRefName",
    ]);
    const value = JSON.parse(result) as {
      number: number; title: string; body?: string; url: string; state: "OPEN" | "CLOSED" | "MERGED";
      headRefOid: string; headRefName: string; baseRefName: string;
    };
    return {
      repo, number: value.number, title: value.title, body: value.body ?? "", url: value.url, state: value.state,
      headSha: value.headRefOid, headBranch: value.headRefName, baseBranch: value.baseRefName,
    };
  }

  async getBranchHead(repo: string, branch: string): Promise<string> {
    const result = await this.gh(["api", `repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`]);
    const value = JSON.parse(result) as { object?: { sha?: string } };
    if (!value.object?.sha) throw new Error(`GitHub did not return a head SHA for ${repo}:${branch}`);
    return value.object.sha;
  }

  async listBranches(repo: string, prefix: string): Promise<BranchSnapshot[]> {
    if (!prefix || !/^[A-Za-z0-9._/-]+$/u.test(prefix) || prefix.includes("..") || prefix.startsWith("/")) {
      throw new Error(`Invalid Git branch prefix: '${prefix}'`);
    }
    const encodedPrefix = prefix.split("/").map((segment) => encodeURIComponent(segment)).join("/");
    const result = await this.gh(["api", `repos/${repo}/git/matching-refs/heads/${encodedPrefix}`]);
    const values = JSON.parse(result) as Array<{ ref?: string; object?: { sha?: string } }>;
    const refPrefix = "refs/heads/";
    return values.flatMap((value) => {
      if (!value.ref?.startsWith(refPrefix) || !value.object?.sha) return [];
      return [{ name: value.ref.slice(refPrefix.length), headSha: value.object.sha }];
    });
  }

  async getPullRequestDiff(repo: string, number: number): Promise<string> {
    return this.gh(["pr", "diff", String(number), "--repo", repo]);
  }

  async mergePullRequest(repo: string, number: number, expectedHeadSha: string, expectedBaseBranch: string): Promise<void> {
    const current = await this.getPullRequest(repo, number);
    if (current.headSha !== expectedHeadSha) {
      throw new Error(`Pull request head changed: reviewed ${expectedHeadSha}, current ${current.headSha}`);
    }
    if (current.baseBranch !== expectedBaseBranch) {
      throw new Error(`Pull request target changed: expected ${expectedBaseBranch}, current ${current.baseBranch}`);
    }
    await this.gh([
      "pr", "merge", String(number), "--repo", repo, "--merge", "--delete-branch",
      "--match-head-commit", expectedHeadSha,
    ]);
  }

  async closeIssue(repo: string, number: number, reason: string): Promise<void> {
    const marker = `<!-- FORGEDOCK:CLOSE repo=${repo.toLowerCase()} issue=${number} -->`;
    await this.publishIssueComment({ repo, issue: number, marker, body: `${reason}\n\n${marker}` });
    let issue = await this.getIssue(number, repo);
    if (issue.state !== "CLOSED") {
      await this.gh(["issue", "close", String(number), "--repo", repo]);
      issue = await this.getIssue(number, repo);
    }
    if (issue.state !== "CLOSED") {
      throw new Error(`Issue #${number} close command completed but authoritative GitHub state is ${issue.state}`);
    }
  }

  async materializeBatchIssue(input: BatchIssueInput): Promise<IssueSnapshot> {
    const marker = /<!-- FORGEDOCK:BATCH ([0-9-]+) -->/.exec(input.body)?.[0];
    if (!marker) throw new Error("Batch issue body is missing its deterministic FORGEDOCK:BATCH marker");
    const incomingContract = parseBatchContract(input.body);
    const existing = (await this.listAllIssues(input.repo)).find((issue) => issue.state === "OPEN" && issue.body.includes(marker));
    if (existing) {
      const existingContract = parseBatchContract(existing.body);
      if (JSON.stringify(existingContract) !== JSON.stringify(incomingContract)) {
        throw new Error(`Existing batch marker ${marker} has a different member contract`);
      }
      return existing;
    }

    await this.gh([
      "label", "create", "batch", "--repo", input.repo, "--color", "C2E0C6",
      "--description", "Multiple compatible findings delivered as one verified work unit", "--force",
    ]);
    const createArgs = [
      "issue", "create", "--repo", input.repo, "--title", input.title, "--body-file", "-",
      "--label", "batch", "--label", "review-finding", "--label", input.priorityLabel,
    ];
    if (input.milestone) createArgs.push("--milestone", input.milestone);
    const url = (await this.gh(createArgs, input.body)).trim();
    const number = Number(url.split("/").at(-1));
    if (!url || !Number.isSafeInteger(number) || number < 1) throw new Error("GitHub did not return a batch issue number");
    return { repo: input.repo, number, title: input.title, body: input.body, url, state: "OPEN" };
  }

  async findOpenPullRequest(repo: string, headBranch: string): Promise<PullRequestSnapshot | undefined> {
    const result = await this.gh([
      "pr", "list", "--repo", repo, "--state", "open", "--head", headBranch,
      "--json", "number", "--limit", "2",
    ]);
    const values = JSON.parse(result) as Array<{ number?: number }>;
    const number = values[0]?.number;
    return number ? this.getPullRequest(repo, number) : undefined;
  }

  async closePullRequest(repo: string, number: number, reason: string): Promise<void> {
    await this.gh(["pr", "close", String(number), "--repo", repo, "--comment", reason]);
  }

  async clearWorkflowLabels(repo: string, issue: number): Promise<void> {
    const labelResult = await this.gh(["issue", "view", String(issue), "--repo", repo, "--json", "labels"]);
    const current = (JSON.parse(labelResult) as { labels?: Array<{ name?: string }> }).labels?.flatMap((label) => label.name ? [label.name] : []) ?? [];
    const remove = current.filter((label) => WORKFLOW_LABEL_NAMES.includes(label as (typeof WORKFLOW_LABEL_NAMES)[number]));
    if (remove.length) await this.gh(["issue", "edit", String(issue), "--repo", repo, "--remove-label", remove.join(",")]);
  }

  private async listAllIssues(repo: string): Promise<IssueSnapshot[]> {
    const result = await this.gh(["api", `repos/${repo}/issues?state=all&per_page=100`, "--paginate", "--slurp"]);
    const pages = JSON.parse(result) as Array<Array<{
      number?: number; title?: string; body?: string; html_url?: string; state?: string; pull_request?: unknown;
    }>>;
    return pages.flat().flatMap((issue) => {
      if (issue.pull_request || !issue.number || !issue.title || !issue.html_url) return [];
      return [{
        repo,
        number: issue.number,
        title: issue.title,
        body: issue.body ?? "",
        url: issue.html_url,
        state: issue.state?.toUpperCase() === "CLOSED" ? "CLOSED" as const : "OPEN" as const,
      }];
    });
  }

  private async resolveOriginRepository(): Promise<string | undefined> {
    try {
      return repositoryFromRemote(await this.git(["config", "--get", "remote.origin.url"]));
    } catch {
      return undefined;
    }
  }

  private git(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn("git", args, {
        cwd: this.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`git ${args[0] ?? ""} failed (${code ?? "unknown"}): ${stderr.trim()}`));
      });
    });
  }

  private gh(args: string[], input?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn("gh", args, {
        cwd: this.cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`gh ${args[0] ?? ""} failed (${code ?? "unknown"}): ${stderr.trim()}`));
      });
      if (input !== undefined) child.stdin.end(input);
      else child.stdin.end();
    });
  }
}

export function reviewFindingReconciliationCandidates(
  issues: readonly IssueSnapshot[],
  input: { repo: string; pullRequest: PullRequestSnapshot; runId: string; activeFindings: readonly ReviewFindingInput[] },
): IssueSnapshot[] {
  const activeMarkers = new Set(input.activeFindings.flatMap((finding) => [
    reviewFindingMarker(input.repo, input.pullRequest.number, finding),
    legacyReviewFindingMarker(input.repo, input.pullRequest.number, finding),
  ]));
  const runMarker = `**Run:** \`${input.runId}\``;
  const sourceMarker = `**Source:** PR #${input.pullRequest.number} `;
  return issues.filter((issue) => issue.state === "OPEN"
    && issue.body.includes(runMarker)
    && issue.body.includes(sourceMarker)
    && /<!-- FORGEDOCK:REVIEW-FINDING [a-f0-9]{64} -->/.test(issue.body)
    && ![...activeMarkers].some((marker) => issue.body.includes(marker)));
}

export function reviewFindingMarker(repo: string, pullRequest: number, finding: ReviewFindingInput): string {
  const legacyIdentity = reviewFindingIdentity(repo, pullRequest, finding);
  const identity = /^review-[a-f0-9]{16}$/.test(finding.id) ? `${legacyIdentity}\n${finding.id}` : legacyIdentity;
  return `<!-- FORGEDOCK:REVIEW-FINDING ${createHash("sha256").update(identity).digest("hex")} -->`;
}

function legacyReviewFindingMarker(repo: string, pullRequest: number, finding: ReviewFindingInput): string {
  return `<!-- FORGEDOCK:REVIEW-FINDING ${createHash("sha256").update(reviewFindingIdentity(repo, pullRequest, finding)).digest("hex")} -->`;
}

function reviewFindingIdentity(repo: string, pullRequest: number, finding: ReviewFindingInput): string {
  return [
    repo.toLowerCase(),
    String(pullRequest),
    finding.location?.replaceAll("\\", "/").trim().toLowerCase() ?? "",
    finding.title.replace(/\s+/g, " ").trim().toLowerCase(),
  ].join("\n");
}

function reviewFindingPriority(severity: ReviewFindingInput["severity"]): "priority:P0" | "priority:P1" | "priority:P2" | "priority:P3" {
  if (severity === "critical") return "priority:P0";
  if (severity === "high") return "priority:P1";
  if (severity === "medium") return "priority:P2";
  return "priority:P3";
}

function reviewFindingPath(location: string | undefined): string | undefined {
  if (!location) return undefined;
  const normalized = location.replaceAll("\\", "/").trim();
  return /(?:^|\s)(\.?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.@+-]+)+)/.exec(normalized)?.[1]?.replace(/^\.\//, "");
}

function boundedGitHubText(value: string, maximum: number): string {
  const normalized = value.replaceAll("\u0000", "").replace(/<!--[\s\S]*?-->/g, "[comment omitted]").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
}

function boundedGitHubCode(value: string): string {
  return boundedGitHubText(value, 500).replaceAll("`", "'").replace(/[\r\n]+/g, " ");
}

function decompositionMarker(repo: string, parentIssue: number, title: string): string {
  return createHash("sha256").update(`${repo.toLowerCase()}#${parentIssue}\n${title.trim().toLowerCase()}`).digest("hex");
}

function remediationChildMarker(repo: string, parentRunId: string, parentIssue: number, parentPullRequest: number, headSha: string, findingId: string): string {
  return createHash("sha256").update([
    repo.toLowerCase(), parentRunId, String(parentIssue), String(parentPullRequest), headSha.toLowerCase(), findingId,
  ].join("\n")).digest("hex");
}

function orderDecompositionChildren(children: DecompositionChild[]): DecompositionChild[] {
  const byTitle = new Map<string, DecompositionChild>();
  for (const child of children) {
    if (byTitle.has(child.title)) throw new Error(`Duplicate decomposition child title: ${child.title}`);
    byTitle.set(child.title, child);
  }
  const remaining = new Set(byTitle.keys());
  const ordered: DecompositionChild[] = [];
  while (remaining.size) {
    const ready = children.filter((child) => remaining.has(child.title) && child.dependsOn
      .filter((dependency) => byTitle.has(dependency))
      .every((dependency) => !remaining.has(dependency)));
    if (!ready.length) throw new Error("Decomposition child dependencies contain a cycle");
    for (const child of ready) {
      remaining.delete(child.title);
      ordered.push(child);
    }
  }
  return ordered;
}

export class GitHubArtifactRepository implements ArtifactRepository {
  constructor(readonly client: Pick<GitHubClient, "listIssueComments" | "postIssueComment">) {}

  async append(artifact: DurableArtifact): Promise<void> {
    const canonical = canonicalSubject(artifact.subject);
    const targets: Subject[] = canonical.pr && canonical.issue
      ? [{ repo: canonical.repo, pr: canonical.pr }, { repo: canonical.repo, issue: canonical.issue }]
      : [canonical];
    for (const target of targets) {
      const comments = await this.client.listIssueComments(target);
      const exists = comments.flatMap(findArtifacts).some((item) => item.id === artifact.id);
      if (!exists) await this.client.postIssueComment(target, renderArtifactComment(artifact));
    }
  }

  async list(subject: Subject, kind?: ArtifactKind): Promise<DurableArtifact[]> {
    const canonical = canonicalSubject(subject);
    const targets: Subject[] = canonical.pr && canonical.issue
      ? [{ repo: canonical.repo, pr: canonical.pr }, { repo: canonical.repo, issue: canonical.issue }]
      : [canonical];
    const found = (await Promise.all(targets.map(async (target) => (await this.client.listIssueComments(target)).flatMap(findArtifacts)))).flat();
    const unique = new Map(found.map((artifact) => [artifact.id, artifact]));
    return [...unique.values()]
      .filter((artifact) => !kind || artifact.kind === kind)
      .filter((artifact) => subjectMatches(artifact.subject, subject));
  }
}

function canonicalSubject(subject: Subject): Subject {
  return { ...subject, repo: subject.repo.trim().toLowerCase() };
}

function subjectMatches(left: Subject, right: Subject): boolean {
  if (left.repo.trim().toLowerCase() !== right.repo.trim().toLowerCase()) return false;
  return (right.issue !== undefined && left.issue === right.issue)
    || (right.pr !== undefined && left.pr === right.pr);
}
