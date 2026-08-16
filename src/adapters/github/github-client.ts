// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { findArtifacts, renderArtifactComment } from "../../core/artifacts/codec.js";
import type { ArtifactKind, DurableArtifact, Subject } from "../../core/artifacts/schema.js";
import type { RunState, RunStateName } from "../../core/state/machine.js";
import type {
  BranchSnapshot,
  DecompositionChild,
  ForgeHost,
  IssueSnapshot,
  PlanMaterializationNode,
  PlanMaterializationRequest,
  PlanMaterializationResult,
  PullRequestCheckDiagnostic,
  PullRequestMergeGate,
  PullRequestSnapshot,
  ReviewFindingInput,
} from "../../core/ports/forge-host.js";
import { InMemoryRemediationAdmissionRepository, type ArtifactRepository, type RemediationAdmissionKey, type RemediationAdmissionRepository } from "../../core/ports/repositories.js";
import { parseBatchContract } from "../../workflows/orchestrate/batching.js";
import { isGitHubAuthenticationFailure, refreshConfiguredGitHubApp } from "./github-auth.js";

export function repositoryFromRemote(remote: string): string | undefined {
  const trimmed = remote.trim().replace(/\/+$/, "");
  let hostname: string;
  let pathname: string;
  const scp = /^[^/\s@]+@([^/\s:]+):(.+)$/.exec(trimmed);
  if (scp?.[1] && scp[2]) {
    hostname = scp[1];
    pathname = scp[2];
  } else {
    let url: URL;
    try {
      url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    } catch {
      return undefined;
    }
    if (url.username || url.password || url.search || url.hash) return undefined;
    hostname = url.hostname;
    pathname = url.pathname;
  }
  if (hostname.toLowerCase() !== "github.com") return undefined;
  const segments = pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (segments.length !== 2) return undefined;
  const owner = segments[0];
  const repository = segments[1]?.replace(/\.git$/i, "");
  if (!owner || !repository || !/^[^\s/:]+$/.test(owner) || !/^[^\s/:]+$/.test(repository)) return undefined;
  return `${owner}/${repository}`;
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
const MAX_GITHUB_ISSUE_BODY_CHARS = 65_000;
const MAX_GITHUB_PULL_REQUEST_FILES = 3_000;
const MAX_FALLBACK_PATCH_CHARS = 1_500_000;
const MAX_FALLBACK_PATCH_CHARS_PER_FILE = 16_384;

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

interface ReviewFindingMaterializationInput {
  repo: string;
  sourceIssue?: number;
  pullRequest: PullRequestSnapshot;
  runId: string;
  reviewedHeadSha: string;
  reviewerRoles: readonly string[];
  finding: ReviewFindingInput;
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

interface GitHubPullRequestFile {
  filename?: unknown;
  previous_filename?: unknown;
  status?: unknown;
  additions?: unknown;
  deletions?: unknown;
  changes?: unknown;
  patch?: unknown;
}

function isOversizedPullRequestDiffError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP 406/i.test(message)
    && /diff exceeded the maximum number of lines|PullRequest\.diff too_large|could not find pull request diff/i.test(message);
}

function pullRequestDiffPath(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`GitHub pull request file response contains an invalid ${field}`);
  }
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/")
    || /^[A-Za-z]:\//u.test(normalized)
    || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`GitHub pull request file response contains an unsafe ${field}`);
  }
  return normalized;
}

function pullRequestFileCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function renderPaginatedPullRequestDiff(raw: string): string {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    throw new Error("GitHub returned malformed paginated pull request files JSON", { cause: error });
  }
  if (!Array.isArray(decoded) || decoded.some((page) => !Array.isArray(page))) {
    throw new Error("GitHub returned an invalid paginated pull request files response");
  }
  const files = decoded.flat() as GitHubPullRequestFile[];
  if (!files.length) throw new Error("GitHub returned no files for the oversized pull request diff");
  if (files.length >= MAX_GITHUB_PULL_REQUEST_FILES) {
    throw new Error(`Pull request has at least ${MAX_GITHUB_PULL_REQUEST_FILES} changed files; GitHub cannot prove the complete file set`);
  }

  const patchBudgetPerFile = Math.max(
    512,
    Math.min(MAX_FALLBACK_PATCH_CHARS_PER_FILE, Math.floor(MAX_FALLBACK_PATCH_CHARS / files.length)),
  );
  return files.map((file) => {
    const filename = pullRequestDiffPath(file.filename, "filename");
    const previousFilename = file.previous_filename === undefined
      ? filename
      : pullRequestDiffPath(file.previous_filename, "previous_filename");
    const status = typeof file.status === "string" ? file.status : "modified";
    const oldPath = status === "added" ? "/dev/null" : `a/${previousFilename}`;
    const newPath = status === "removed" ? "/dev/null" : `b/${filename}`;
    const additions = pullRequestFileCount(file.additions);
    const deletions = pullRequestFileCount(file.deletions);
    const changes = pullRequestFileCount(file.changes);
    const summary = [
      `status=${status}`,
      ...(additions !== undefined ? [`additions=${additions}`] : []),
      ...(deletions !== undefined ? [`deletions=${deletions}`] : []),
      ...(changes !== undefined ? [`changes=${changes}`] : []),
    ].join(" ");
    const originalPatch = typeof file.patch === "string" ? file.patch : undefined;
    const patch = originalPatch?.length
      ? originalPatch.slice(0, patchBudgetPerFile)
      : undefined;
    const patchNotice = patch === undefined
      ? "# ForgeDock: GitHub omitted this file patch; inspect the file in the frozen review workspace."
      : originalPatch!.length > patchBudgetPerFile
        ? `${patch}\n# ForgeDock: patch excerpt truncated; inspect the file in the frozen review workspace.`
        : patch;
    return [
      `diff --git a/${previousFilename} b/${filename}`,
      `# ForgeDock oversized-diff fallback: ${summary}`,
      `--- ${oldPath}`,
      `+++ ${newPath}`,
      patchNotice,
    ].join("\n");
  }).join("\n");
}

export class GitHubClient implements ForgeHost {
  private readonly initializedLabelRepos = new Map<string, Promise<void>>();
  private readonly initializedReviewFindingRepos = new Map<string, Promise<void>>();
  private authRefreshAttempted = false;

  constructor(
    readonly cwd = process.cwd(),
    readonly remediationAdmissions: RemediationAdmissionRepository = new InMemoryRemediationAdmissionRepository(),
    readonly refreshAuth?: () => Promise<boolean>,
  ) {}

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

  async getMilestone(number: number, repo?: string): Promise<{ number: number; title: string; state: "open" | "closed" }> {
    const resolvedRepo = repo ?? await this.resolveRepository();
    const result = await this.gh(["api", `repos/${resolvedRepo}/milestones/${number}`]);
    const milestone = JSON.parse(result) as { number?: number; title?: string; state?: string };
    if (milestone.number !== number || !milestone.title || (milestone.state !== "open" && milestone.state !== "closed")) {
      throw new Error(`Unable to resolve milestone #${number} in ${resolvedRepo}`);
    }
    return { number, title: milestone.title, state: milestone.state };
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

  async listOpenIssueNumbersForSearch(query: string, repo?: string): Promise<number[]> {
    const normalizedQuery = query.replace(/\s+/g, " ").trim();
    if (!normalizedQuery) throw new Error("GitHub issue search query must not be blank");
    if (normalizedQuery.length > 500) throw new Error("GitHub issue search query is too long");
    const resolvedRepo = repo ?? await this.resolveRepository();
    const result = await this.gh([
      "issue", "list", "--repo", resolvedRepo, "--state", "open",
      "--search", normalizedQuery, "--limit", "1000", "--json", "number,state,milestone",
    ]);
    const issues = JSON.parse(result) as Array<{ number?: number; state?: string; milestone?: { title?: string } | null }>;
    return issues
      .filter((issue) => issue.state?.toUpperCase() === "OPEN" && Number.isSafeInteger(issue.number))
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
    if (issue.number !== number) throw new Error(`GitHub returned issue #${issue.number} while #${number} was requested`);
    if (issue.state !== "OPEN" && issue.state !== "CLOSED") throw new Error(`GitHub returned an invalid state for issue #${number}`);
    if (!issue.title || !issue.url) throw new Error(`GitHub returned an incomplete projection for issue #${number}`);
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
    if (!hasCanonicalMarker(input.body, input.marker)) throw new Error("Reviewer comment body is missing its canonical idempotency marker");
    await this.publishMarkedComment({ repo: input.repo, pr: input.pullRequest }, input.marker, input.body);
  }

  async publishIssueComment(input: { repo: string; issue: number; marker: string; body: string }): Promise<void> {
    if (!hasCanonicalMarker(input.body, input.marker)) throw new Error("Issue comment is missing its canonical idempotency marker");
    await this.publishMarkedComment({ repo: input.repo, issue: input.issue }, input.marker, input.body);
  }

  private async publishMarkedComment(subject: Subject, marker: string, body: string): Promise<void> {
    const admissionKey: RemediationAdmissionKey = {
      repo: subject.repo,
      parentIssue: subject.issue ?? 0,
      parentPullRequest: subject.pr ?? 0,
      headSha: marker,
      marker: `comment:${marker}`,
    };
    const claim = await this.remediationAdmissions.claim(admissionKey);
    const comments = await this.listIssueComments(subject);
    if (comments.some((comment) => hasCanonicalMarker(comment, marker))) {
      await this.remediationAdmissions.complete(admissionKey, projectionAdmissionSnapshot(subject, marker));
      return;
    }
    if (claim.status === "materialized") {
      throw new RemediationMaterializationPendingError(marker);
    }
    if (claim.status !== "claimed") throw new RemediationMaterializationPendingError(marker);
    await this.postIssueComment(subject, body);
    await this.remediationAdmissions.complete(admissionKey, projectionAdmissionSnapshot(subject, marker));
  }

  async materializeReviewFinding(input: ReviewFindingMaterializationInput): Promise<IssueSnapshot> {
    await this.ensureReviewFindingLabels(input.repo);
    const marker = reviewFindingMarker(input.repo, input.pullRequest.number, input.finding);
    const laneMarker = reviewFindingLaneMarker(input.repo, input.pullRequest.number);
    const admissionKey: RemediationAdmissionKey = {
      repo: input.repo,
      parentIssue: 0,
      parentPullRequest: input.pullRequest.number,
      headSha: input.reviewedHeadSha,
      marker,
    };
    const claim = await this.remediationAdmissions.claim(admissionKey);
    const isAuthoritativeProjection = (issue: IssueSnapshot): boolean => issue.state === "OPEN"
      && hasCanonicalMarker(issue.body, marker);
    if (claim.status === "materialized") {
      const authoritative = await this.authoritativeIssueSnapshot(claim.snapshot);
      if (authoritative.state !== "OPEN") {
        const invalidated = await this.remediationAdmissions.invalidateMaterialized(admissionKey, claim.snapshot.number);
        if (!invalidated) throw new RemediationMaterializationPendingError(marker);
        return this.materializeReviewFinding(input);
      }
      if (!hasCanonicalMarker(authoritative.body, marker)) {
        throw new Error(`Cached review-finding issue #${authoritative.number} lost its canonical root marker`);
      }
      return this.refreshReviewFindingProjection(input, authoritative, marker, laneMarker);
    }
    const existingIssues = await this.listAllIssues(input.repo);
    const existing = existingIssues.find((issue) => isAuthoritativeProjection(issue));
    if (existing) {
      const authoritative = await this.authoritativeIssueSnapshot(existing);
      if (!isAuthoritativeProjection(authoritative)) throw new Error(`Review-finding issue #${existing.number} changed during adoption`);
      const refreshed = await this.refreshReviewFindingProjection(input, authoritative, marker, laneMarker);
      await this.remediationAdmissions.complete(admissionKey, refreshed);
      return refreshed;
    }
    if (claim.status !== "claimed") {
      const visible = await this.reconcileReviewFindingMarker(input.repo, [marker]);
      if (visible) {
        const authoritative = await this.authoritativeIssueSnapshot(visible);
        if (!isAuthoritativeProjection(authoritative)) throw new Error(`Review-finding issue #${visible.number} changed during reconciliation`);
        const refreshed = await this.refreshReviewFindingProjection(input, authoritative, marker, laneMarker);
        await this.remediationAdmissions.complete(admissionKey, refreshed);
        return refreshed;
      }
      throw new RemediationMaterializationPendingError(marker);
    }

    const regression = existingIssues
      .filter((issue) => issue.state === "CLOSED" && hasCanonicalMarker(issue.body, marker))
      .sort((left, right) => right.number - left.number)[0];
    const derivedPriority = reviewFindingPriority(input.finding.severity);
    const priority = regression && derivedPriority !== "priority:P0" ? "priority:P1" : derivedPriority;
    const { title, body } = renderReviewFindingIssue(input, marker, laneMarker, priority, regression);

    const milestoneTitle = await this.resolveReviewFindingMilestone(input);
    const args = [
      "issue", "create", "--repo", input.repo, "--title", title, "--body-file", "-",
      "--label", "review-finding", "--label", "needs-validation", "--label", priority,
    ];
    if (milestoneTitle) args.push("--milestone", milestoneTitle);
    const url = (await this.gh(args, body)).trim();
    const number = Number(url.split("/").at(-1));
    if (!url || !Number.isSafeInteger(number) || number < 1) throw new Error("GitHub did not return a review-finding issue number");
    const authoritative = await this.authoritativeIssueSnapshot({ repo: input.repo, number, title, body, url, state: "OPEN" });
    if (!isCurrentReviewFindingProjection(authoritative, { title, body, marker, priority, milestoneTitle })) {
      throw new Error(`Created review-finding issue #${number} failed authoritative identity validation`);
    }
    await this.remediationAdmissions.complete(admissionKey, authoritative);
    return authoritative;
  }

  private async refreshReviewFindingProjection(
    input: ReviewFindingMaterializationInput,
    issue: IssueSnapshot,
    marker: string,
    laneMarker: string,
  ): Promise<IssueSnapshot> {
    await this.publishReviewFindingRecurrence(input, issue, marker);
    const priority = reviewFindingPriority(input.finding.severity);
    const milestoneTitle = await this.resolveReviewFindingMilestone(input);
    const { title, body } = renderReviewFindingIssue(input, marker, laneMarker, priority);
    const currentPriorityLabels = (issue.labels ?? []).filter((label) => /^priority:P[0-3]$/.test(label));
    const expected = { title, body, marker, priority, milestoneTitle };

    let authoritative = issue;
    if (!isCurrentReviewFindingProjection(issue, expected)) {
      const args = [
        "issue", "edit", String(issue.number), "--repo", input.repo,
        "--title", title, "--body-file", "-", "--add-label", `review-finding,needs-validation,${priority}`,
      ];
      const obsoletePriorities = currentPriorityLabels.filter((label) => label !== priority);
      if (obsoletePriorities.length) args.push("--remove-label", obsoletePriorities.join(","));
      if (milestoneTitle) args.push("--milestone", milestoneTitle);
      else if (issue.milestone) args.push("--remove-milestone");
      await this.gh(args, body);
      authoritative = await this.authoritativeIssueSnapshot(issue);
    }

    if (!isCurrentReviewFindingProjection(authoritative, expected)) {
      throw new Error(`Review-finding issue #${issue.number} failed authoritative identity validation after refresh`);
    }
    return authoritative;
  }

  private async publishReviewFindingRecurrence(
    input: { repo: string; pullRequest: PullRequestSnapshot; runId: string; reviewedHeadSha: string; finding: ReviewFindingInput },
    issue: IssueSnapshot,
    marker: string,
  ): Promise<void> {
    const priorHeadSha = reviewedShaFromFindingBody(issue.body);
    if (priorHeadSha === input.reviewedHeadSha.toLowerCase()) return;
    const recurrenceMarker = reviewFindingRecurrenceMarker(input.repo, input.pullRequest.number, issue.number, input.reviewedHeadSha, marker);
    await this.publishIssueComment({
      repo: input.repo,
      issue: issue.number,
      marker: recurrenceMarker,
      body: [
        `This review finding recurred in PR #${input.pullRequest.number} at reviewed SHA \`${input.reviewedHeadSha}\`.`,
        ...(priorHeadSha ? [`Previously recorded reviewed SHA: \`${priorHeadSha}\`.`] : []),
        `Run: \`${boundedGitHubCode(input.runId)}\``,
        "",
        `**Current evidence:** ${boundedGitHubText(input.finding.evidence, 4_000)}`,
        "",
        `**Current remediation:** ${boundedGitHubText(input.finding.remediation, 2_000)}`,
        "",
        recurrenceMarker,
      ].join("\n"),
    });
  }

  private async resolveReviewFindingMilestone(input: {
    repo: string;
    sourceIssue?: number;
    pullRequest: PullRequestSnapshot;
  }): Promise<string | undefined> {
    const metadata = JSON.parse(await this.gh(["api", `repos/${input.repo}/issues/${input.pullRequest.number}`])) as {
      milestone?: { title?: string } | null;
    };
    if (metadata.milestone?.title) return metadata.milestone.title;

    const sourceIssue = input.sourceIssue ?? closingIssueFromPullRequestBody(input.pullRequest.body);
    if (sourceIssue !== undefined) {
      try {
        const issue = JSON.parse(await this.gh([
          "issue", "view", String(sourceIssue), "--repo", input.repo, "--json", "milestone",
        ])) as { milestone?: { title?: string } | null };
        if (issue.milestone?.title) return issue.milestone.title;
      } catch {
        // Milestone inheritance is best-effort after the authoritative PR lookup.
      }
    }

    const milestoneBranch = [input.pullRequest.baseBranch, input.pullRequest.headBranch]
      .find((branch) => branch.startsWith("milestone/"));
    if (!milestoneBranch) return undefined;
    const branchSlug = milestoneBranch.slice("milestone/".length).toLowerCase();
    try {
      const pages = JSON.parse(await this.gh([
        "api", `repos/${input.repo}/milestones?state=open&per_page=100`, "--paginate", "--slurp",
      ])) as Array<Array<{ title?: string }>>;
      const milestones = pages.flat().flatMap(({ title }) => title ? [{ title, slug: milestoneTitleSlug(title) }] : []);
      return milestones.find(({ slug }) => slug === branchSlug)?.title
        ?? milestones.find(({ slug }) => slug.includes(branchSlug))?.title;
    } catch {
      return undefined;
    }
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
    const inheritedLabels = parent.labels.filter((label) => {
      const normalized = label.trim().toLowerCase();
      return !normalized.startsWith("workflow:")
        && !new Set(["batch", "review-finding", "needs-validation", "needs-human", "blocked", "operator-only"]).has(normalized);
    });
    const inheritedMilestone = parent.milestone;
    const existing = await this.listAllIssues(input.repo);
    const byMarker = new Map(existing.flatMap((issue) => {
      const match = findCanonicalMarker(issue.body, /^<!-- FORGEDOCK:DECOMPOSITION ([a-f0-9]{64}) -->$/);
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
        if (inheritedMilestone) args.push("--milestone", inheritedMilestone.title);
        const url = (await this.gh(args, body)).trim();
        const number = Number(url.split("/").at(-1));
        if (!Number.isSafeInteger(number) || number < 1) throw new Error(`GitHub did not return a child issue number for '${child.title}'`);
        issue = await this.getIssue(number, input.repo);
        byMarker.set(marker, issue);
      } else {
        issue = await this.getIssue(issue.number, input.repo);
        if (inheritedMilestone && issue.milestone?.number !== inheritedMilestone.number) {
          await this.gh([
            "issue", "edit", String(issue.number), "--repo", input.repo,
            "--milestone", inheritedMilestone.title,
          ]);
          issue = await this.getIssue(issue.number, input.repo);
        }
      }
      if (inheritedMilestone && issue.milestone?.number !== inheritedMilestone.number) {
        throw new Error(`Decomposition child #${issue.number} did not inherit milestone '${inheritedMilestone.title}' from parent #${input.parentIssue}`);
      }
      materialized.set(child.title, issue);
    }

    return input.children.map((child) => {
      const issue = materialized.get(child.title);
      if (!issue) throw new Error(`Decomposition child was not materialized: ${child.title}`);
      return issue;
    });
  }

  async materializePlan(input: PlanMaterializationRequest): Promise<PlanMaterializationResult> {
    const plan = preparePlanMaterialization(input);
    const existingIssues = await this.listAllIssues(input.repo);
    const existingByIdentity = indexPlanNodeProjections(existingIssues);
    const preflightExisting = new Map<string, PlanNodeProjection>();

    // Validate the complete remote projection before the first issue write.
    // A stale contract for any node blocks the whole materialization instead
    // of allowing a mixed-revision graph to be partially created.
    for (const prepared of plan.ordered) {
      const existing = selectPlanNodeProjection(prepared, existingByIdentity.get(prepared.identityDigest) ?? []);
      if (existing) preflightExisting.set(prepared.node.nodeId, existing);
    }

    const issueByNodeId = new Map<string, IssueSnapshot>();
    const resultByNodeId = new Map<string, PlanMaterializationResult["nodes"][number]>();
    const usedIssueNumbers = new Set<number>();

    for (const prepared of plan.ordered) {
      const dependencies = prepared.node.dependsOnNodeIds.map((nodeId) => {
        const issue = issueByNodeId.get(nodeId);
        const node = plan.byNodeId.get(nodeId);
        if (!issue || !node) throw new Error(`Plan node ${prepared.node.nodeId} dependency ${nodeId} was not materialized first`);
        return { node, issueNumber: issue.number };
      });
      const body = renderPlanNodeIssue(input, prepared, dependencies, plan.evidenceById);
      if (body.length > MAX_GITHUB_ISSUE_BODY_CHARS) {
        throw new Error(`Plan node ${prepared.node.nodeId} exceeds GitHub's issue body limit`);
      }
      const admissionKey: RemediationAdmissionKey = {
        repo: input.repo,
        parentIssue: 0,
        parentPullRequest: 0,
        headSha: prepared.identityDigest,
        // Serialize all contracts for one immutable node identity. The full
        // contract digest remains in the authoritative GitHub marker.
        marker: `plan-node:${prepared.identityDigest}`,
      };
      const claim = await this.remediationAdmissions.claim(admissionKey);
      let issue: IssueSnapshot;
      if (claim.status === "materialized") {
        issue = await this.authoritativeIssueSnapshot(claim.snapshot);
      } else {
        const preflight = preflightExisting.get(prepared.node.nodeId);
        if (preflight) {
          issue = await this.authoritativeIssueSnapshot(preflight.issue);
        } else if (claim.status === "pending") {
          const visible = await this.reconcilePlanNodeProjection(input.repo, prepared);
          if (!visible) throw new RemediationMaterializationPendingError(prepared.marker);
          issue = await this.authoritativeIssueSnapshot(visible.issue);
        } else {
          const url = (await this.gh([
            "issue", "create", "--repo", input.repo, "--title", prepared.node.title, "--body-file", "-",
          ], body)).trim();
          const number = Number(url.split("/").at(-1));
          if (!url || !Number.isSafeInteger(number) || number < 1) {
            throw new Error(`GitHub did not return an issue number for plan node ${prepared.node.nodeId}`);
          }
          issue = await this.authoritativeIssueSnapshot({
            repo: input.repo,
            number,
            title: prepared.node.title,
            body,
            url,
            state: "OPEN",
          });
        }
      }
      assertAuthoritativePlanNodeIssue(input.repo, prepared, issue);
      if (usedIssueNumbers.has(issue.number)) {
        throw new Error(`Plan materialization assigned issue #${issue.number} to more than one node`);
      }
      usedIssueNumbers.add(issue.number);
      await this.remediationAdmissions.complete(admissionKey, issue);
      issueByNodeId.set(prepared.node.nodeId, issue);
      resultByNodeId.set(prepared.node.nodeId, {
        planId: input.planId,
        revision: input.revision,
        nodeId: prepared.node.nodeId,
        issue,
        dependsOnNodeIds: [...prepared.node.dependsOnNodeIds],
        dependencyIssueNumbers: dependencies.map(({ issueNumber }) => issueNumber),
      });
    }

    const nodes = input.nodes.map((node) => {
      const result = resultByNodeId.get(node.nodeId);
      if (!result) throw new Error(`Plan materialization omitted node ${node.nodeId}`);
      const expectedDependencies = node.dependsOnNodeIds.map((dependency) => {
        const issue = issueByNodeId.get(dependency);
        if (!issue) throw new Error(`Plan materialization omitted dependency ${dependency}`);
        return issue.number;
      });
      if (result.dependencyIssueNumbers.length !== expectedDependencies.length
        || result.dependencyIssueNumbers.some((number, index) => number !== expectedDependencies[index])) {
        throw new Error(`Plan node ${node.nodeId} returned an invalid dependency issue mapping`);
      }
      return result;
    });
    return { repo: input.repo, planId: input.planId, revision: input.revision, nodes };
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
    const materialized: IssueSnapshot[] = [];
    for (const finding of input.findings) {
      const marker = remediationChildMarker(input.repo, input.parentRunId, input.parentIssue, input.parentPullRequest, input.headSha, finding.id);
      const admissionKey: RemediationAdmissionKey = {
        repo: input.repo,
        parentIssue: input.parentIssue,
        parentPullRequest: input.parentPullRequest,
        headSha: input.headSha,
        marker,
      };
      const claim = await this.remediationAdmissions.claim(admissionKey);
      if (claim.status === "materialized") {
        const authoritative = await this.authoritativeIssueSnapshot(claim.snapshot);
        if (!hasCanonicalMarker(authoritative.body, marker)) {
          throw new Error(`Cached remediation admission no longer matches authoritative GitHub issue #${authoritative.number}`);
        }
        materialized.push(authoritative);
        continue;
      }

      const existing = await this.reconcileRemediationMarker(input.repo, marker);
      if (existing) {
        const authoritative = await this.authoritativeIssueSnapshot(existing);
        await this.remediationAdmissions.complete(admissionKey, authoritative);
        materialized.push(authoritative);
        continue;
      }
      if (claim.status !== "claimed") {
        throw new RemediationMaterializationPendingError(marker);
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
      // A successful create is still pending until GitHub returns an authoritative
      // issue projection. If this read is interrupted, the durable admission keeps
      // later controllers from issuing a second create.
      const authoritative = await this.authoritativeIssueSnapshot({
        repo: input.repo, number, title, body, url, state: "OPEN",
      });
      await this.remediationAdmissions.complete(admissionKey, authoritative);
      materialized.push(authoritative);
    }
    return materialized;
  }

  private async reconcilePlanNodeProjection(repo: string, prepared: PreparedPlanNode): Promise<PlanNodeProjection | undefined> {
    const delays = [0, 5, 10, 20, 40, 80, 160, 320] as const;
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      if (delays[attempt]) await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      const indexed = indexPlanNodeProjections(await this.listAllIssues(repo));
      const visible = selectPlanNodeProjection(prepared, indexed.get(prepared.identityDigest) ?? []);
      if (visible) return visible;
    }
    return undefined;
  }

  private async reconcileRemediationMarker(repo: string, marker: string, openOnly = false): Promise<IssueSnapshot | undefined> {
    const delays = [0, 5, 10, 20, 40, 80, 160, 320] as const;
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      if (delays[attempt]) await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      const issue = (await this.listAllIssues(repo)).find((candidate) => hasCanonicalMarker(candidate.body, marker)
        && (!openOnly || candidate.state === "OPEN"));
      if (issue) return issue;
    }
    return undefined;
  }

  private async reconcileReviewFindingMarker(repo: string, markers: readonly string[]): Promise<IssueSnapshot | undefined> {
    const delays = [0, 5, 10, 20, 40, 80, 160, 320] as const;
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      if (delays[attempt]) await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      const issue = (await this.listAllIssues(repo)).find((candidate) => candidate.state === "OPEN"
        && markers.some((marker) => hasCanonicalMarker(candidate.body, marker)));
      if (issue) return issue;
    }
    return undefined;
  }

  private async authoritativeIssueSnapshot(issue: IssueSnapshot): Promise<IssueSnapshot> {
    const fetched = await this.getIssue(issue.number, issue.repo);
    const { comments: _comments, ...snapshot } = fetched;
    return snapshot;
  }

  async createPullRequest(input: {
    repo: string; issue: number; headBranch: string; baseBranch: string; title: string; body: string;
  }): Promise<PullRequestSnapshot> {
    return this.createBranchPullRequest(input);
  }

  async createPromotionPullRequest(input: {
    repo: string; headBranch: string; baseBranch: string; title: string; body: string;
  }): Promise<PullRequestSnapshot> {
    return this.createBranchPullRequest(input);
  }

  private async createBranchPullRequest(input: {
    repo: string; headBranch: string; baseBranch: string; title: string; body: string;
  }): Promise<PullRequestSnapshot> {
    if (!input.headBranch || !input.baseBranch || input.headBranch === input.baseBranch) {
      throw new Error("Promotion pull request requires distinct source and target branches");
    }
    const url = (await this.gh([
      "pr", "create", "--repo", input.repo, "--head", input.headBranch, "--base", input.baseBranch,
      "--title", input.title, "--body-file", "-",
    ], input.body)).trim();
    if (!url) throw new Error("GitHub did not return a pull request URL");
    const number = Number(url.split("/").at(-1));
    if (!Number.isSafeInteger(number) || number < 1) throw new Error("GitHub returned an invalid pull request URL");
    const pullRequest = await this.getPullRequest(input.repo, number);
    if (pullRequest.state !== "OPEN") {
      throw new Error(`New pull request #${number} is not open (GitHub state: ${pullRequest.state})`);
    }
    if (pullRequest.headBranch !== input.headBranch || pullRequest.baseBranch !== input.baseBranch) {
      throw new Error(`New pull request #${number} identity does not match ${input.headBranch} -> ${input.baseBranch}`);
    }
    return pullRequest;
  }

  async getPullRequest(repo: string, number: number): Promise<PullRequestSnapshot> {
    const result = await this.gh([
      "pr", "view", String(number), "--repo", repo,
      "--json", "number,title,body,url,state,headRefOid,headRefName,baseRefName",
    ]);
    return pullRequestSnapshotFromGitHub(repo, number, JSON.parse(result));
  }

  async getPullRequestMergeGate(repo: string, number: number, expectedHeadSha: string, expectedBaseBranch: string): Promise<PullRequestMergeGate> {
    const pullRequest = await this.getPullRequest(repo, number);
    if (pullRequest.headSha !== expectedHeadSha) {
      throw new Error(`Pull request head changed: reviewed ${expectedHeadSha}, current ${pullRequest.headSha}`);
    }
    if (pullRequest.baseBranch !== expectedBaseBranch) {
      throw new Error(`Pull request target changed: expected ${expectedBaseBranch}, current ${pullRequest.baseBranch}`);
    }
    if (pullRequest.state !== "OPEN") {
      throw new Error(`Pull request #${number} is not open (GitHub state: ${pullRequest.state})`);
    }
    let mergeable = false;
    try {
      const result = await this.gh([
        "pr", "view", String(number), "--repo", repo,
        "--json", "mergeable,mergeStateStatus",
      ]);
      const value = JSON.parse(result) as { mergeable?: string };
      // GitHub's mergeable field reports whether the head can be merged
      // without conflicts. mergeStateStatus also includes branch-protection
      // and required-check state; review evaluates the individual exact-head
      // check observations separately so contradictory results remain visible.
      mergeable = String(value.mergeable ?? "UNKNOWN").toUpperCase() === "MERGEABLE";
    } catch {
      mergeable = false;
    }

    const parseChecks = (result: string, omitInapplicable = false): PullRequestMergeGate["requiredChecks"] => {
      const parsed: unknown = JSON.parse(result);
      if (!Array.isArray(parsed)) throw new Error("GitHub checks response is not an array");
      // A push run and a pull_request run can publish the same check name at
      // the same head SHA. Preserve every observation so a later success can
      // never erase a contradictory failure from the controller's merge gate.
      return parsed.flatMap((entry: unknown) => {
        if (!entry || typeof entry !== "object") throw new Error("GitHub checks response contains an invalid entry");
        const check = entry as { name?: unknown; state?: unknown; link?: unknown };
        const name = typeof check.name === "string" ? check.name.trim() : "";
        const state = typeof check.state === "string" ? check.state : undefined;
        const detailsUrl = typeof check.link === "string" ? check.link : undefined;
        if (omitInapplicable && ["SKIPPED", "NEUTRAL"].includes(String(state ?? "").toUpperCase())) return [];
        return [{
          name: name || "unnamed-required-check",
          state: mergeCheckState(state),
          ...(detailsUrl ? { detailsUrl } : {}),
        }];
      });
    };
    let requiredChecks: PullRequestMergeGate["requiredChecks"] = [];
    try {
      const result = await this.gh([
        "pr", "checks", String(number), "--repo", repo, "--required",
        "--json", "name,state,link,completedAt,startedAt",
      ]);
      requiredChecks = parseChecks(result);
    } catch (error) {
      if (error instanceof Error && /no required checks reported/i.test(error.message)) {
        try {
          // Repositories without branch-protection required checks still
          // expose check runs. Use them as the review gate rather than
          // converting a normal GitHub response into an unavailable blocker.
          const result = await this.gh([
            "pr", "checks", String(number), "--repo", repo,
            "--json", "name,state,link,completedAt,startedAt",
          ]);
          requiredChecks = parseChecks(result, true);
        } catch (fallbackError) {
          requiredChecks = [{
            name: "required-checks-query",
            state: "unavailable",
            detailsUrl: fallbackError instanceof Error ? fallbackError.message.slice(0, 500) : String(fallbackError).slice(0, 500),
          }];
        }
      } else {
        requiredChecks = [{
          name: "required-checks-query",
          state: "unavailable",
          detailsUrl: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        }];
      }
    }
    // The checks query is PR-scoped. Re-read the PR after it so a head/base
    // race cannot attach current checks to a different reviewed revision.
    const finalPullRequest = await this.getPullRequest(repo, number);
    if (finalPullRequest.headSha !== expectedHeadSha) {
      throw new Error(`Pull request head changed while reading required checks: reviewed ${expectedHeadSha}, current ${finalPullRequest.headSha}`);
    }
    if (finalPullRequest.baseBranch !== expectedBaseBranch) {
      throw new Error(`Pull request target changed while reading required checks: expected ${expectedBaseBranch}, current ${finalPullRequest.baseBranch}`);
    }
    if (finalPullRequest.state !== "OPEN") {
      throw new Error(`Pull request #${number} changed state while reading required checks: ${finalPullRequest.state}`);
    }
    return {
      repo,
      pullRequest: number,
      headSha: expectedHeadSha,
      baseBranch: expectedBaseBranch,
      mergeable,
      requiredChecks,
      observedAt: new Date().toISOString(),
    };
  }

  async getPullRequestHeadRepository(repo: string, number: number, expectedHeadSha: string): Promise<{ repo: string; isCrossRepository: boolean }> { const result = await this.gh(["pr", "view", String(number), "--repo", repo, "--json", "number,headRefOid,headRepository,headRepositoryOwner,isCrossRepository"]); const value = JSON.parse(result) as { number?: unknown; headRefOid?: unknown; headRepository?: { name?: unknown; nameWithOwner?: unknown }; headRepositoryOwner?: { login?: unknown }; isCrossRepository?: unknown }; if (value.number !== number || value.headRefOid !== expectedHeadSha) throw new Error("Pull request head identity changed while resolving its writable repository"); const name = typeof value.headRepository?.nameWithOwner === "string" ? value.headRepository.nameWithOwner : typeof value.headRepositoryOwner?.login === "string" && typeof value.headRepository?.name === "string" ? `${value.headRepositoryOwner.login}/${value.headRepository.name}` : undefined; if (!name) throw new Error(`GitHub did not return an authoritative head repository for PR #${number}`); return { repo: name, isCrossRepository: value.isCrossRepository === true }; }
  async getPullRequestCheckDiagnostics(repo: string, number: number, expectedHeadSha: string, names: readonly string[]): Promise<readonly PullRequestCheckDiagnostic[]> { if (names.length > 20) throw new Error("Pull-request check diagnostics are bounded to 20 checks"); const pr = await this.getPullRequest(repo, number); if (pr.headSha !== expectedHeadSha) throw new Error("Pull request head changed before CI diagnostics"); const gate = await this.getPullRequestMergeGate(repo, number, expectedHeadSha, pr.baseBranch); const requested = new Set(names.map((name) => name.toLowerCase())); const result: PullRequestCheckDiagnostic[] = []; for (const check of gate.requiredChecks) { if (!requested.has(check.name.toLowerCase())) continue; let logExcerpt = "Failed check logs are unavailable; inspect the details URL and repository mechanical checks."; if (check.detailsUrl && githubActionsRunBelongsToRepo(check.detailsUrl, repo)) try { logExcerpt = (await this.gh(["run", "view", check.detailsUrl, "--repo", repo, "--log-failed"])).slice(-50_000) || logExcerpt; } catch (error) { logExcerpt = `Failed check logs could not be read: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2_000); } result.push({ name: check.name, state: check.state, ...(check.detailsUrl ? { detailsUrl: check.detailsUrl } : {}), logExcerpt }); } return result; }
  async getBranchHead(repo: string, branch: string): Promise<string> {
    const result = await this.gh(["api", `repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`]);
    const value = JSON.parse(result) as { object?: { sha?: string } };
    if (!value.object?.sha) throw new Error(`GitHub did not return a head SHA for ${repo}:${branch}`);
    return value.object.sha;
  }

  async createBranch(repo: string, branch: string, fromBranch: string): Promise<BranchSnapshot> {
    if (!branch || !fromBranch || branch === fromBranch || !/^\S+$/.test(branch) || !/^\S+$/.test(fromBranch)) {
      throw new Error("GitHub branch creation requires distinct non-empty branch names");
    }
    const sha = await this.getBranchHead(repo, fromBranch);
    let createConflict = false;
    try {
      await this.gh(["api", `repos/${repo}/git/refs`, "--method", "POST", "--input", "-"], JSON.stringify({ ref: `refs/heads/${branch}`, sha }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/\breference already exists\b|\balready exists\b/i.test(message)) throw error;
      createConflict = true;
    }
    const createdSha = await this.getBranchHead(repo, branch);
    if (createdSha.toLowerCase() !== sha.toLowerCase()) {
      const circumstance = createConflict ? "already existed" : "was created";
      throw new Error(`Branch ${repo}:${branch} ${circumstance} at ${createdSha}, expected source head ${sha}`);
    }
    return { name: branch, headSha: createdSha };
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
    try {
      return await this.gh(["pr", "diff", String(number), "--repo", repo]);
    } catch (error) {
      if (!isOversizedPullRequestDiffError(error)) throw error;
      const files = await this.gh([
        "api", `repos/${repo}/pulls/${number}/files?per_page=100`, "--paginate", "--slurp",
      ]);
      return renderPaginatedPullRequestDiff(files);
    }
  }

  async getChangedPathsBetween(repo: string, baseSha: string, headSha: string): Promise<readonly string[]> {
    const output = await this.gh([
      "api", `repos/${repo}/compare/${baseSha}...${headSha}`, "--paginate", "--jq", ".files[].filename",
    ]);
    return [...new Set(output.split(/\r?\n/).map((path) => path.trim().replaceAll("\\", "/")).filter(Boolean))].sort();
  }

  async mergePullRequest(repo: string, number: number, expectedHeadSha: string, expectedBaseBranch: string): Promise<void> {
    const current = await this.getPullRequest(repo, number);
    if (current.headSha !== expectedHeadSha) {
      throw new Error(`Pull request head changed: reviewed ${expectedHeadSha}, current ${current.headSha}`);
    }
    if (current.baseBranch !== expectedBaseBranch) {
      throw new Error(`Pull request target changed: expected ${expectedBaseBranch}, current ${current.baseBranch}`);
    }
    if (current.state === "MERGED") return;
    if (current.state !== "OPEN") {
      throw new Error(`Pull request #${number} is not open (GitHub state: ${current.state})`);
    }
    const gate = await this.getPullRequestMergeGate(repo, number, expectedHeadSha, expectedBaseBranch);
    const failure = mergeGateFailure(gate);
    if (failure) throw new Error(failure);
    try {
      await this.gh([
        "pr", "merge", String(number), "--repo", repo, "--merge", "--delete-branch",
        "--match-head-commit", expectedHeadSha,
      ]);
    } catch (error) {
      const afterFailure = await this.getPullRequest(repo, number);
      if (pullRequestMatchesMergedIdentity(afterFailure, expectedHeadSha, expectedBaseBranch)) return;
      throw new Error(
        `GitHub merge command failed and PR #${number} is ${afterFailure.state} at ${afterFailure.headSha} targeting ${afterFailure.baseBranch}`,
        { cause: error },
      );
    }
  }

  async findOpenPromotionPullRequest(repo: string, headBranch: string, baseBranch: string): Promise<PullRequestSnapshot | undefined> {
    const result = await this.gh([
      "pr", "list", "--repo", repo, "--state", "open", "--head", headBranch, "--base", baseBranch,
      "--json", "number", "--limit", "10",
    ]);
    const values = JSON.parse(result) as Array<{ number?: number }>;
    for (const value of values) {
      if (value.number && Number.isSafeInteger(value.number)) {
        const pullRequest = await this.getPullRequest(repo, value.number);
        if (pullRequest.state === "OPEN" && pullRequest.headBranch === headBranch && pullRequest.baseBranch === baseBranch) return pullRequest;
      }
    }
    return undefined;
  }

  async isBranchProtected(repo: string, branch: string): Promise<boolean> {
    try {
      await this.gh(["api", `repos/${repo}/branches/${encodeURIComponent(branch)}/protection`]);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/\b404\b|not found/i.test(message)) return false;
      throw new Error(`Unable to prove branch protection for ${repo}:${branch}`, { cause: error });
    }
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
    const marker = findCanonicalMarker(input.body, /^<!-- FORGEDOCK:BATCH ([0-9-]+) -->$/)?.[0];
    if (!marker) throw new Error("Batch issue body is missing its deterministic FORGEDOCK:BATCH marker");
    const incomingContract = parseBatchContract(input.body);
    const admissionKey: RemediationAdmissionKey = {
      repo: input.repo,
      parentIssue: 0,
      parentPullRequest: 0,
      headSha: marker,
      marker: `batch:${marker}`,
    };
    const claim = await this.remediationAdmissions.claim(admissionKey);
    const validateExisting = (existing: IssueSnapshot): IssueSnapshot => {
      const existingContract = parseBatchContract(existing.body);
      if (JSON.stringify(existingContract) !== JSON.stringify(incomingContract)) {
        throw new Error(`Existing batch marker ${marker} has a different member contract`);
      }
      return existing;
    };
    if (claim.status === "materialized") {
      const authoritative = await this.authoritativeIssueSnapshot(claim.snapshot);
      if (authoritative.state !== "OPEN") {
        const invalidated = await this.remediationAdmissions.invalidateMaterialized(admissionKey, claim.snapshot.number);
        if (!invalidated) throw new RemediationMaterializationPendingError(marker);
        return this.materializeBatchIssue(input);
      }
      if (!hasCanonicalMarker(authoritative.body, marker)) {
        throw new Error(`Cached batch issue #${authoritative.number} lost its canonical root marker`);
      }
      return validateExisting(authoritative);
    }

    const existing = (await this.listAllIssues(input.repo)).find((issue) => issue.state === "OPEN" && hasCanonicalMarker(issue.body, marker));
    if (existing) {
      const authoritative = validateExisting(existing);
      await this.remediationAdmissions.complete(admissionKey, authoritative);
      return authoritative;
    }
    if (claim.status !== "claimed") {
      const visible = await this.reconcileRemediationMarker(input.repo, marker, true);
      if (visible) {
        const authoritative = validateExisting(visible);
        await this.remediationAdmissions.complete(admissionKey, authoritative);
        return authoritative;
      }
      throw new RemediationMaterializationPendingError(marker);
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
    const snapshot = { repo: input.repo, number, title: input.title, body: input.body, url, state: "OPEN" as const };
    await this.remediationAdmissions.complete(admissionKey, snapshot);
    return snapshot;
  }

  async findOpenPullRequest(repo: string, headBranch: string): Promise<PullRequestSnapshot | undefined> {
    const result = await this.gh([
      "pr", "list", "--repo", repo, "--state", "open", "--head", headBranch,
      "--json", "number", "--limit", "2",
    ]);
    const values = JSON.parse(result) as Array<{ number?: number }>;
    for (const value of values) {
      if (!value.number || !Number.isSafeInteger(value.number)) continue;
      const pullRequest = await this.getPullRequest(repo, value.number);
      if (pullRequest.state === "OPEN" && pullRequest.headBranch === headBranch) return pullRequest;
    }
    return undefined;
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
        windowsHide: true,
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

  private async gh(args: string[], input?: string): Promise<string> {
    try {
      return await this.runGh(args, input);
    } catch (error) {
      if (this.authRefreshAttempted || !isGitHubAuthenticationFailure(error)) throw error;
      this.authRefreshAttempted = true;
      const refreshed = await (this.refreshAuth ?? (() => refreshConfiguredGitHubApp(this.cwd)))();
      if (!refreshed) throw error;
      return this.runGh(args, input);
    }
  }

  private runGh(args: string[], input?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn("gh", args, {
        cwd: this.cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
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

export class RemediationMaterializationPendingError extends Error {
  constructor(readonly marker: string) {
    super(`Remediation child marker remains unresolved; admission is retained pending reconciliation: ${marker}`);
    this.name = "RemediationMaterializationPendingError";
  }
}

export function reviewFindingReconciliationCandidates(
  issues: readonly IssueSnapshot[],
  input: { repo: string; pullRequest: PullRequestSnapshot; runId: string; activeFindings: readonly ReviewFindingInput[] },
): IssueSnapshot[] {
  const activeMarkerOwners = new Map<string, string>();
  for (const finding of input.activeFindings) {
    activeMarkerOwners.set(reviewFindingMarker(input.repo, input.pullRequest.number, finding), finding.id);
  }
  const laneMarker = reviewFindingLaneMarker(input.repo, input.pullRequest.number);
  const sourceMarker = `**Source:** PR #${input.pullRequest.number} `;
  const markerPattern = /<!-- FORGEDOCK:REVIEW-FINDING [a-f0-9]{64} -->/;
  const laneIssues = issues
    .filter((issue) => issue.state === "OPEN" && hasCanonicalLinePrefix(issue.body, sourceMarker)
      && hasCanonicalMarker(issue.body, laneMarker) && findCanonicalMarker(issue.body, markerPattern) !== undefined)
    .sort((left, right) => left.number - right.number);
  const retainedOwners = new Set<string>();
  return laneIssues.filter((issue) => {
    const owner = [...activeMarkerOwners].find(([marker]) => hasCanonicalMarker(issue.body, marker))?.[1];
    if (!owner) return true;
    if (retainedOwners.has(owner)) return true;
    retainedOwners.add(owner);
    return false;
  });
}

export function reviewFindingLaneMarker(repo: string, pullRequest: number): string {
  const identity = `${repo.toLowerCase()}\n${pullRequest}`;
  return `<!-- FORGEDOCK:REVIEW-FINDING-LANE v1 ${createHash("sha256").update(identity).digest("hex")} -->`;
}

export function reviewFindingMarker(repo: string, pullRequest: number, finding: ReviewFindingInput): string {
  return `<!-- FORGEDOCK:REVIEW-FINDING ${createHash("sha256").update(`${reviewFindingIdentity(repo, pullRequest, finding)}\n${finding.id.trim()}`).digest("hex")} -->`;
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

function renderReviewFindingIssue(
  input: ReviewFindingMaterializationInput,
  marker: string,
  laneMarker: string,
  priority: "priority:P0" | "priority:P1" | "priority:P2" | "priority:P3",
  regression?: IssueSnapshot,
): { title: string; body: string } {
  const title = boundedGitHubText(`fix: ${input.finding.title} (review finding — PR #${input.pullRequest.number})`, 240).replace(/[\r\n]+/g, " ");
  const affectedFile = reviewFindingPath(input.finding.location);
  const sensitive = /security|auth|billing|payment|stripe|charge|invoice|credential|secret|token/i.test(`${affectedFile ?? ""} ${input.finding.title}`);
  const body = [
    "## Problem",
    "",
    boundedGitHubText(input.finding.title, 1_000),
    ...(regression ? ["", `> **Regression:** Previously tracked in #${regression.number}; this root recurred at reviewed SHA \`${input.reviewedHeadSha}\`.`] : []),
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
    laneMarker,
  ].join("\n");
  return { title, body };
}

function isCurrentReviewFindingProjection(
  issue: IssueSnapshot,
  expected: {
    title: string;
    body: string;
    marker: string;
    priority: "priority:P0" | "priority:P1" | "priority:P2" | "priority:P3";
    milestoneTitle: string | undefined;
  },
): boolean {
  const labels = issue.labels ?? [];
  const priorityLabels = labels.filter((label) => /^priority:P[0-3]$/.test(label));
  return issue.state === "OPEN"
    && issue.title === expected.title
    && issue.body === expected.body
    && hasCanonicalMarker(issue.body, expected.marker)
    && reviewedShaFromFindingBody(issue.body) !== undefined
    && ["review-finding", "needs-validation", expected.priority].every((label) => labels.includes(label))
    && priorityLabels.length === 1
    && priorityLabels[0] === expected.priority
    && (expected.milestoneTitle !== undefined
      ? issue.milestone?.title === expected.milestoneTitle
      : issue.milestone === undefined);
}

function reviewedShaFromFindingBody(body: string): string | undefined {
  return findCanonicalMarker(body, /^\*\*Reviewed SHA:\*\* `([a-f0-9]{40,64})`$/i)?.[1]?.toLowerCase();
}

function reviewFindingRecurrenceMarker(repo: string, pullRequest: number, issue: number, reviewedHeadSha: string, rootMarker: string): string {
  const identity = `${repo.toLowerCase()}\n${pullRequest}\n${issue}\n${reviewedHeadSha.toLowerCase()}\n${rootMarker}`;
  return `<!-- FORGEDOCK:REVIEW-FINDING-RECURRENCE ${createHash("sha256").update(identity).digest("hex")} -->`;
}

function closingIssueFromPullRequestBody(body: string): number | undefined {
  const match = /(?:^|[^a-z])(?:closes|fixes|resolves)\s+#([0-9]+)/i.exec(body);
  const issue = Number(match?.[1]);
  return Number.isSafeInteger(issue) && issue > 0 ? issue : undefined;
}

function milestoneTitleSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
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

/** Root-level marker lines only; quoted, indented, and fenced examples are not authority. */
function canonicalBodyLines(body: string): string[] {
  const canonical: string[] = [];
  let fence: "`" | "~" | undefined;
  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter) {
      const delimiterKind = delimiter[0] as "`" | "~";
      if (!fence) fence = delimiterKind;
      else if (fence === delimiterKind) fence = undefined;
      continue;
    }
    if (!fence) canonical.push(line);
  }
  return canonical;
}

function hasCanonicalMarker(body: string, marker: string): boolean {
  return marker.length > 0
    && !/[\r\n]/.test(marker)
    && canonicalBodyLines(body).some((line) => line === marker);
}

function hasCanonicalLinePrefix(body: string, prefix: string): boolean {
  return prefix.length > 0
    && !/[\r\n]/.test(prefix)
    && canonicalBodyLines(body).some((line) => line.startsWith(prefix));
}

function findCanonicalMarker(body: string, pattern: RegExp): RegExpExecArray | undefined {
  return findCanonicalMarkers(body, pattern)[0];
}

function findCanonicalMarkers(body: string, pattern: RegExp): RegExpExecArray[] {
  const flags = pattern.flags.replace(/[gy]/g, "");
  const matcher = new RegExp(pattern.source, flags);
  const matches: RegExpExecArray[] = [];
  for (const line of canonicalBodyLines(body)) {
    const match = matcher.exec(line);
    if (match?.[0] === line) matches.push(match);
  }
  return matches;
}

function pullRequestSnapshotFromGitHub(repo: string, requestedNumber: number, raw: unknown): PullRequestSnapshot {
  if (!raw || typeof raw !== "object") throw new Error(`GitHub returned an invalid projection for PR #${requestedNumber}`);
  const value = raw as Record<string, unknown>;
  if (value.number !== requestedNumber) {
    throw new Error(`GitHub returned PR #${String(value.number)} while #${requestedNumber} was requested`);
  }
  if (value.state !== "OPEN" && value.state !== "CLOSED" && value.state !== "MERGED") {
    throw new Error(`GitHub returned an invalid state for PR #${requestedNumber}`);
  }
  const requiredString = (field: string): string => {
    const fieldValue = value[field];
    if (typeof fieldValue !== "string" || !fieldValue.trim()) {
      throw new Error(`GitHub returned PR #${requestedNumber} without ${field}`);
    }
    return fieldValue;
  };
  const title = requiredString("title");
  const url = requiredString("url");
  const headSha = requiredString("headRefOid");
  const headBranch = requiredString("headRefName");
  const baseBranch = requiredString("baseRefName");
  if (!/^[a-f0-9]{40,64}$/i.test(headSha)) {
    throw new Error(`GitHub returned an invalid head SHA for PR #${requestedNumber}`);
  }
  const repositoryParts = repo.trim().split("/");
  let urlParts: string[];
  try {
    urlParts = new URL(url).pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    throw new Error(`GitHub returned an invalid URL for PR #${requestedNumber}`);
  }
  const pullIdentity = urlParts.slice(-2).map((part) => part.toLowerCase());
  if (pullIdentity[0] !== "pull" || pullIdentity[1] !== String(requestedNumber)) {
    throw new Error(`GitHub returned a URL for a different PR than #${requestedNumber}`);
  }
  const identity = urlParts.length >= 4 ? urlParts.slice(-4).map((part) => part.toLowerCase()) : undefined;
  const expectedIdentity = [repositoryParts[0], repositoryParts[1], "pull", String(requestedNumber)]
    .map((part) => String(part ?? "").toLowerCase());
  if (repositoryParts.length !== 2 || (identity !== undefined
    && identity.some((part, index) => part !== expectedIdentity[index]))) {
    throw new Error(`GitHub returned a URL outside ${repo} for PR #${requestedNumber}`);
  }
  return {
    repo,
    number: requestedNumber,
    title,
    body: typeof value.body === "string" ? value.body : "",
    url,
    state: value.state,
    headSha,
    headBranch,
    baseBranch,
  };
}

function pullRequestMatchesMergedIdentity(
  pullRequest: PullRequestSnapshot,
  expectedHeadSha: string,
  expectedBaseBranch: string,
): boolean {
  return pullRequest.state === "MERGED"
    && pullRequest.headSha === expectedHeadSha
    && pullRequest.baseBranch === expectedBaseBranch;
}

function mergeCheckState(value: string | undefined): PullRequestMergeGate["requiredChecks"][number]["state"] {
  const normalized = String(value ?? "").toUpperCase();
  if (["SUCCESS", "PASSED", "PASS", "COMPLETED"].includes(normalized)) return "passed";
  if (["FAILURE", "FAILED", "ERROR", "STARTUP_FAILURE", "ACTION_REQUIRED", "STALE"].includes(normalized)) return "failed";
  if (["CANCELLED", "CANCELED"].includes(normalized)) return "cancelled";
  if (["PENDING", "QUEUED", "IN_PROGRESS", "REQUESTED", "WAITING"].includes(normalized)) return "pending";
  return "unavailable";
}
function githubActionsRunBelongsToRepo(value: string, repo: string): boolean { try { const url = new URL(value); const [owner, name] = repo.toLowerCase().split("/"); const parts = url.pathname.split("/").filter(Boolean).map((part) => part.toLowerCase()); return url.hostname.toLowerCase() === "github.com" && parts[0] === owner && parts[1] === name && parts[2] === "actions" && parts[3] === "runs" && /^\d+$/.test(parts[4] ?? ""); } catch { return false; } }

function mergeGateFailure(gate: PullRequestMergeGate): string | undefined {
  if (!gate.mergeable) return `Pull request #${gate.pullRequest} is not mergeable at ${gate.baseBranch} for reviewed ${gate.headSha}`;
  const failed = gate.requiredChecks.filter((check) => check.state !== "passed");
  if (failed.length) {
    return `Required GitHub checks are not all passing for PR #${gate.pullRequest}: ${failed.map((check) => `${check.name}=${check.state}`).join(", ")}`;
  }
  return undefined;
}

function projectionAdmissionSnapshot(subject: Subject, marker: string): IssueSnapshot {
  const number = subject.issue ?? subject.pr;
  if (!number) throw new Error("Projection admission requires an issue or pull request target");
  return {
    repo: subject.repo,
    number,
    title: "ForgeDock idempotent projection",
    body: marker,
    url: "",
    state: "OPEN",
  };
}

interface PreparedPlanNode {
  node: PlanMaterializationNode;
  identityDigest: string;
  contractDigest: string;
  marker: string;
}

interface PreparedPlanMaterialization {
  ordered: PreparedPlanNode[];
  byNodeId: Map<string, PlanMaterializationNode>;
  evidenceById: Map<string, PlanMaterializationRequest["evidence"][number]>;
}

interface PlanNodeProjection {
  issue: IssueSnapshot;
  identityDigest: string;
  contractDigest: string;
}

interface PlanDependencyProjection {
  node: PlanMaterializationNode;
  issueNumber: number;
}

function preparePlanMaterialization(input: PlanMaterializationRequest): PreparedPlanMaterialization {
  if (!/^[^/\s]+\/[^/\s]+$/.test(input.repo)) throw new Error(`Plan materialization repository is invalid: '${input.repo}'`);
  assertPlanIdentifier(input.planId, "planId");
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new Error("Plan revision must be a positive integer");
  assertPlanText(input.objective, "objective", true);
  assertPlanTextArray(input.assumptions, "assumptions", false);
  assertPlanTextArray(input.outOfScope, "outOfScope", false);
  if (!Array.isArray(input.evidence)) throw new Error("Plan evidence must be an array");
  if (!Array.isArray(input.vocabulary)) throw new Error("Plan vocabulary must be an array");
  if (!Array.isArray(input.decisions)) throw new Error("Plan decisions must be an array");
  if (!Array.isArray(input.nodes) || !input.nodes.length) throw new Error("Plan materialization requires at least one node");

  const evidenceById = new Map<string, PlanMaterializationRequest["evidence"][number]>();
  const evidenceAuthorities = new Set(["user", "github", "repository", "forge-guidance", "devdocs", "prototype"]);
  for (const [index, evidence] of input.evidence.entries()) {
    assertPlanIdentifier(evidence.id, `evidence[${index}].id`);
    if (evidenceById.has(evidence.id)) throw new Error(`Duplicate plan evidence ID: ${evidence.id}`);
    if (!evidenceAuthorities.has(evidence.authority)) throw new Error(`Invalid authority for plan evidence ${evidence.id}`);
    assertPlanText(evidence.source, `evidence[${index}].source`, true);
    assertPlanText(evidence.locator, `evidence[${index}].locator`, true);
    assertPlanText(evidence.claim, `evidence[${index}].claim`, true);
    assertPlanText(evidence.detail, `evidence[${index}].detail`, true);
    evidenceById.set(evidence.id, evidence);
  }

  const vocabularyIds = new Set<string>();
  for (const [index, term] of input.vocabulary.entries()) {
    assertPlanIdentifier(term.id, `vocabulary[${index}].id`);
    if (vocabularyIds.has(term.id)) throw new Error(`Duplicate plan vocabulary ID: ${term.id}`);
    vocabularyIds.add(term.id);
    assertPlanText(term.term, `vocabulary[${index}].term`, true);
    assertPlanText(term.definition, `vocabulary[${index}].definition`, true);
    assertPlanTextArray(term.aliases, `vocabulary[${index}].aliases`, false);
    assertPlanReferenceArray(term.evidenceIds, `vocabulary[${index}].evidenceIds`, evidenceById, "evidence");
    if (!new Set(["proposed", "accepted", "rejected"]).has(term.status)) throw new Error(`Invalid status for vocabulary term ${term.id}`);
  }

  const decisionIds = new Set<string>();
  for (const [index, decision] of input.decisions.entries()) {
    assertPlanIdentifier(decision.questionId, `decisions[${index}].questionId`);
    if (decisionIds.has(decision.questionId)) throw new Error(`Duplicate plan decision: ${decision.questionId}`);
    decisionIds.add(decision.questionId);
    if (!Number.isSafeInteger(decision.round) || decision.round < 1) throw new Error(`Invalid round for plan decision ${decision.questionId}`);
    if (decision.authority !== "user") throw new Error(`Plan decision ${decision.questionId} is not user-authoritative`);
    assertPlanTextArray(decision.values, `decisions[${index}].values`, false);
    assertPlanTextArray(decision.labels, `decisions[${index}].labels`, false);
    if (decision.customText !== undefined) assertPlanText(decision.customText, `decisions[${index}].customText`, false);
    if (decision.note !== undefined) assertPlanText(decision.note, `decisions[${index}].note`, false);
    if (decision.optionNotes !== undefined) {
      if (!decision.optionNotes || typeof decision.optionNotes !== "object" || Array.isArray(decision.optionNotes)) {
        throw new Error(`Plan decision ${decision.questionId} option notes are invalid`);
      }
      for (const [key, value] of Object.entries(decision.optionNotes)) {
        assertPlanText(key, `decisions[${index}].optionNotes key`, true);
        assertPlanText(value, `decisions[${index}].optionNotes.${key}`, false);
      }
    }
  }

  const byNodeId = new Map<string, PlanMaterializationNode>();
  for (const [index, node] of input.nodes.entries()) {
    if (node.planId !== input.planId || node.revision !== input.revision) {
      throw new Error(`Plan node ${node.nodeId || index} has a mismatched plan identity`);
    }
    assertPlanIdentifier(node.nodeId, `nodes[${index}].nodeId`);
    if (byNodeId.has(node.nodeId)) throw new Error(`Duplicate plan node ID: ${node.nodeId}`);
    assertPlanText(node.title, `nodes[${index}].title`, true);
    if (/[\r\n]/.test(node.title) || node.title.length > 240) throw new Error(`Plan node ${node.nodeId} title is not GitHub-safe`);
    assertPlanText(node.outcome, `nodes[${index}].outcome`, true);
    assertPlanTextArray(node.dependsOnNodeIds, `nodes[${index}].dependsOnNodeIds`, true);
    assertPlanTextArray(node.acceptanceCriteria, `nodes[${index}].acceptanceCriteria`, true);
    if (!node.acceptanceCriteria.length) throw new Error(`Plan node ${node.nodeId} requires acceptance criteria`);
    assertPlanTextArray(node.affectedFiles, `nodes[${index}].affectedFiles`, false);
    assertPlanTextArray(node.claims, `nodes[${index}].claims`, true);
    assertPlanTextArray(node.verificationPlan, `nodes[${index}].verificationPlan`, true);
    if (!node.verificationPlan.length) throw new Error(`Plan node ${node.nodeId} requires a verification plan`);
    if (!Number.isSafeInteger(node.priority) || node.priority < 0) throw new Error(`Plan node ${node.nodeId} priority is invalid`);
    if (!new Set(["routine", "security", "auth", "billing"]).has(node.riskClass)) throw new Error(`Plan node ${node.nodeId} risk class is invalid`);
    assertPlanReferenceArray(node.evidenceIds, `nodes[${index}].evidenceIds`, evidenceById, "evidence");
    byNodeId.set(node.nodeId, node);
  }

  const preparedById = new Map<string, PreparedPlanNode>();
  const identityDigests = new Set<string>();
  for (const node of input.nodes) {
    assertUniquePlanValues(node.dependsOnNodeIds, `Plan node ${node.nodeId} dependencies`);
    for (const dependency of node.dependsOnNodeIds) {
      if (!byNodeId.has(dependency)) throw new Error(`Unknown plan dependency '${dependency}' for node '${node.nodeId}'`);
      if (dependency === node.nodeId) throw new Error(`Plan node ${node.nodeId} cannot depend on itself`);
    }
    const identityDigest = planNodeIdentityDigest(input.repo, input.planId, input.revision, node.nodeId);
    if (identityDigests.has(identityDigest)) throw new Error(`Plan node identity collision for ${node.nodeId}`);
    identityDigests.add(identityDigest);
    const contractDigest = planNodeContractDigest(node);
    preparedById.set(node.nodeId, {
      node,
      identityDigest,
      contractDigest,
      marker: planNodeMarker(identityDigest, contractDigest),
    });
  }

  const remaining = new Map(preparedById);
  const completed = new Set<string>();
  const ordered: PreparedPlanNode[] = [];
  while (remaining.size) {
    const ready = [...remaining.values()]
      .filter(({ node }) => node.dependsOnNodeIds.every((dependency) => completed.has(dependency)))
      .sort((left, right) => left.node.priority - right.node.priority || left.node.nodeId.localeCompare(right.node.nodeId));
    if (!ready.length) throw new Error("Plan node dependencies contain a cycle");
    const next = ready[0]!;
    remaining.delete(next.node.nodeId);
    completed.add(next.node.nodeId);
    ordered.push(next);
  }

  // Render every issue with maximum-width dependency placeholders before any
  // GitHub write. Actual issue numbers can only make these bodies shorter.
  for (const prepared of ordered) {
    const dependencies = prepared.node.dependsOnNodeIds.map((nodeId) => ({
      node: byNodeId.get(nodeId)!,
      issueNumber: Number.MAX_SAFE_INTEGER,
    }));
    const body = renderPlanNodeIssue(input, prepared, dependencies, evidenceById);
    if (!hasCanonicalMarker(body, prepared.marker)) throw new Error(`Plan node ${prepared.node.nodeId} did not render its canonical marker`);
    if (body.length > MAX_GITHUB_ISSUE_BODY_CHARS) throw new Error(`Plan node ${prepared.node.nodeId} exceeds GitHub's issue body limit`);
  }
  return { ordered, byNodeId, evidenceById };
}

function assertPlanIdentifier(value: unknown, label: string): asserts value is string {
  assertPlanText(value, label, true);
  if (value.trim() !== value || /[\r\n]/.test(value)) throw new Error(`${label} must be a single-line ID without surrounding whitespace`);
}

function assertPlanText(value: unknown, label: string, nonBlank: boolean): asserts value is string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (value.includes("\u0000")) throw new Error(`${label} must not contain NUL characters`);
  if (nonBlank && !value.trim()) throw new Error(`${label} must not be blank`);
}

function assertPlanTextArray(value: unknown, label: string, nonBlank: boolean): asserts value is readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  value.forEach((entry, index) => assertPlanText(entry, `${label}[${index}]`, nonBlank));
}

function assertUniquePlanValues(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must not contain duplicates`);
}

function assertPlanReferenceArray<T>(
  value: unknown,
  label: string,
  available: ReadonlyMap<string, T>,
  kind: string,
): asserts value is readonly string[] {
  assertPlanTextArray(value, label, true);
  assertUniquePlanValues(value, label);
  for (const reference of value) {
    if (!available.has(reference)) throw new Error(`${label} references unknown plan ${kind} ${reference}`);
  }
}

function planNodeIdentityDigest(repo: string, planId: string, revision: number, nodeId: string): string {
  return createHash("sha256").update([repo.trim().toLowerCase(), planId, String(revision), nodeId].join("\n")).digest("hex");
}

function planNodeContractDigest(node: PlanMaterializationNode): string {
  const contract = {
    planId: node.planId,
    revision: node.revision,
    nodeId: node.nodeId,
    title: node.title,
    outcome: node.outcome,
    dependsOnNodeIds: [...node.dependsOnNodeIds],
    acceptanceCriteria: [...node.acceptanceCriteria],
    affectedFiles: [...node.affectedFiles],
    claims: [...node.claims],
    verificationPlan: [...node.verificationPlan],
    priority: node.priority,
    riskClass: node.riskClass,
    evidenceIds: [...node.evidenceIds],
  };
  return createHash("sha256").update(JSON.stringify(contract)).digest("hex");
}

function planNodeMarker(identityDigest: string, contractDigest: string): string {
  return `<!-- FORGEDOCK:PLAN-NODE v1 identity=${identityDigest} contract=${contractDigest} -->`;
}

function renderPlanNodeIssue(
  input: PlanMaterializationRequest,
  prepared: PreparedPlanNode,
  dependencies: readonly PlanDependencyProjection[],
  evidenceById: ReadonlyMap<string, PlanMaterializationRequest["evidence"][number]>,
): string {
  const node = prepared.node;
  const lines = [
    prepared.marker,
    "",
    "## ForgeDock Plan Node",
    "",
    `- **Plan ID:** \`${planInline(input.planId)}\``,
    `- **Revision:** ${input.revision}`,
    `- **Node ID:** \`${planInline(node.nodeId)}\``,
    `- **Priority:** ${node.priority}`,
    `- **Risk class:** \`${node.riskClass}\``,
    "",
    "## Objective",
    "",
    ...planQuote(input.objective),
    "",
    "## Intended Outcome",
    "",
    ...planQuote(node.outcome),
    "",
    "## Dependencies",
    "",
    ...(dependencies.length
      ? dependencies.flatMap(({ node: dependency, issueNumber }) => planBullet(`#${issueNumber} — ${dependency.nodeId}: ${dependency.title}`))
      : ["- None."]),
    "",
    "## Acceptance Criteria",
    "",
    ...node.acceptanceCriteria.flatMap((criterion) => planBullet(criterion, "- [ ] ")),
    "",
    "## Affected Files",
    "",
    ...(node.affectedFiles.length ? node.affectedFiles.flatMap((path) => planBullet(path)) : ["- None specified."]),
    "",
    "## Claims",
    "",
    ...(node.claims.length ? node.claims.flatMap((claim) => planBullet(claim)) : ["- None specified."]),
    "",
    "## Verification Plan",
    "",
    ...node.verificationPlan.flatMap((step) => planBullet(step, "- [ ] ")),
    "",
    "## Evidence",
    "",
    ...(node.evidenceIds.length
      ? node.evidenceIds.flatMap((id) => {
          const evidence = evidenceById.get(id)!;
          return [
            `### \`${planInline(evidence.id)}\``,
            "",
            `- **Authority:** \`${evidence.authority}\``,
            "- **Source:**",
            ...planIndentedQuote(evidence.source),
            "- **Locator:**",
            ...planIndentedQuote(evidence.locator),
            "- **Claim:**",
            ...planIndentedQuote(evidence.claim),
            "- **Detail:**",
            ...planIndentedQuote(evidence.detail),
            "",
          ];
        })
      : ["- None referenced.", ""]),
    "## Assumptions",
    "",
    ...(input.assumptions.length ? input.assumptions.flatMap((assumption) => planBullet(assumption)) : ["- None."]),
    "",
    "## Vocabulary",
    "",
    ...(input.vocabulary.length
      ? input.vocabulary.flatMap((term) => [
          `### ${planInline(term.term)} (\`${term.status}\`)`,
          "",
          `- **ID:** \`${planInline(term.id)}\``,
          `- **Aliases:** ${term.aliases.length ? term.aliases.map(planInline).join(", ") : "None"}`,
          `- **Evidence:** ${term.evidenceIds.length ? term.evidenceIds.map((id) => `\`${planInline(id)}\``).join(", ") : "None"}`,
          "- **Definition:**",
          ...planIndentedQuote(term.definition),
          "",
        ])
      : ["- None.", ""]),
    "## User Decisions",
    "",
    ...(input.decisions.length
      ? input.decisions.flatMap((decision) => [
          `### Round ${decision.round}: \`${planInline(decision.questionId)}\``,
          "",
          `- **Authority:** \`${decision.authority}\``,
          "- **Values:**",
          ...(decision.values.length ? decision.values.flatMap((value) => planBullet(value, "  - ")) : ["  - None."]),
          "- **Labels:**",
          ...(decision.labels.length ? decision.labels.flatMap((label) => planBullet(label, "  - ")) : ["  - None."]),
          ...(decision.customText !== undefined ? ["- **Custom text:**", ...planIndentedQuote(decision.customText)] : []),
          ...(decision.note !== undefined ? ["- **Note:**", ...planIndentedQuote(decision.note)] : []),
          ...(decision.optionNotes !== undefined
            ? [
                "- **Option notes:**",
                ...Object.entries(decision.optionNotes)
                  .sort(([left], [right]) => left.localeCompare(right))
                  .flatMap(([key, value]) => planBullet(`${key}: ${value}`, "  - ")),
              ]
            : []),
          "",
        ])
      : ["- None.", ""]),
    "## Out of Scope",
    "",
    ...(input.outOfScope.length ? input.outOfScope.flatMap((item) => planBullet(item)) : ["- None."]),
  ];
  return lines.join("\n");
}

function planInline(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replaceAll("`", "'");
}

function planBullet(value: string, prefix = "- "): string[] {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  return [`${prefix}${lines[0] ?? ""}`, ...lines.slice(1).map((line) => `  ${line}`)];
}

function planQuote(value: string): string[] {
  return value.replace(/\r\n?/g, "\n").split("\n").map((line) => `> ${line}`);
}

function planIndentedQuote(value: string): string[] {
  return planQuote(value).map((line) => `  ${line}`);
}

function indexPlanNodeProjections(issues: readonly IssueSnapshot[]): Map<string, PlanNodeProjection[]> {
  const indexed = new Map<string, PlanNodeProjection[]>();
  const pattern = /^<!-- FORGEDOCK:PLAN-NODE v1 identity=([a-f0-9]{64}) contract=([a-f0-9]{64}) -->$/;
  for (const issue of issues) {
    for (const marker of findCanonicalMarkers(issue.body, pattern)) {
      const identityDigest = marker[1]!;
      const contractDigest = marker[2]!;
      const projections = indexed.get(identityDigest) ?? [];
      projections.push({ issue, identityDigest, contractDigest });
      indexed.set(identityDigest, projections);
    }
  }
  return indexed;
}

function selectPlanNodeProjection(prepared: PreparedPlanNode, projections: readonly PlanNodeProjection[]): PlanNodeProjection | undefined {
  if (projections.length > 1) throw new Error(`Plan node ${prepared.node.nodeId} has multiple GitHub issue projections`);
  const projection = projections[0];
  if (!projection) return undefined;
  if (projection.contractDigest !== prepared.contractDigest) {
    throw new Error(`Plan node ${prepared.node.nodeId} already exists with a different contract digest`);
  }
  if (projection.issue.state !== "OPEN") {
    throw new Error(`Plan node ${prepared.node.nodeId} issue #${projection.issue.number} is ${projection.issue.state.toLowerCase()}`);
  }
  return projection;
}

function assertAuthoritativePlanNodeIssue(repo: string, prepared: PreparedPlanNode, issue: IssueSnapshot): void {
  if (issue.repo.trim().toLowerCase() !== repo.trim().toLowerCase()) {
    throw new Error(`Plan node ${prepared.node.nodeId} issue belongs to ${issue.repo}, not ${repo}`);
  }
  const indexed = indexPlanNodeProjections([issue]);
  const projection = selectPlanNodeProjection(prepared, indexed.get(prepared.identityDigest) ?? []);
  if (!projection) throw new Error(`Plan node ${prepared.node.nodeId} issue #${issue.number} is missing its canonical contract marker`);
  if (!Number.isSafeInteger(issue.number) || issue.number < 1 || !issue.url) {
    throw new Error(`Plan node ${prepared.node.nodeId} returned an invalid issue projection`);
  }
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
  for (const child of children) {
    for (const dependency of child.dependsOn) {
      if (!byTitle.has(dependency)) {
        throw new Error(`Unknown decomposition dependency '${dependency}' for child '${child.title}'`);
      }
    }
  }
  const remaining = new Set(byTitle.keys());
  const ordered: DecompositionChild[] = [];
  while (remaining.size) {
    const ready = children.filter((child) => remaining.has(child.title)
      && child.dependsOn.every((dependency) => !remaining.has(dependency)));
    if (!ready.length) throw new Error("Decomposition child dependencies contain a cycle");
    for (const child of ready) {
      remaining.delete(child.title);
      ordered.push(child);
    }
  }
  return ordered;
}

export class GitHubArtifactRepository implements ArtifactRepository {
  private readonly projectionAdmissions: RemediationAdmissionRepository;

  constructor(
    readonly client: Pick<GitHubClient, "listIssueComments" | "postIssueComment"> & Partial<Pick<GitHubClient, "remediationAdmissions">>,
    projectionAdmissions?: RemediationAdmissionRepository,
  ) {
    this.projectionAdmissions = projectionAdmissions ?? client.remediationAdmissions ?? new InMemoryRemediationAdmissionRepository();
  }

  async append(artifact: DurableArtifact): Promise<void> {
    const canonical = canonicalSubject(artifact.subject);
    const targets: Subject[] = canonical.pr && canonical.issue
      ? [{ repo: canonical.repo, pr: canonical.pr }, { repo: canonical.repo, issue: canonical.issue }]
      : [canonical];
    for (const target of targets) {
      const admissionKey: RemediationAdmissionKey = {
        repo: target.repo,
        parentIssue: target.issue ?? 0,
        parentPullRequest: target.pr ?? 0,
        headSha: artifact.id,
        marker: `artifact:${artifact.id}`,
      };
      const claim = await this.projectionAdmissions.claim(admissionKey);
      const comments = await this.client.listIssueComments(target);
      const exists = comments.flatMap(findArtifacts).some((item) => item.id === artifact.id);
      if (exists) {
        await this.projectionAdmissions.complete(admissionKey, projectionAdmissionSnapshot(target, artifact.id));
        continue;
      }
      if (claim.status === "materialized") throw new RemediationMaterializationPendingError(artifact.id);
      if (claim.status !== "claimed") throw new RemediationMaterializationPendingError(artifact.id);
      await this.client.postIssueComment(target, renderArtifactComment(artifact));
      await this.projectionAdmissions.complete(admissionKey, projectionAdmissionSnapshot(target, artifact.id));
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
