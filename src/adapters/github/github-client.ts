// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { findArtifacts, renderArtifactComment } from "../../core/artifacts/codec.js";
import type { ArtifactKind, DurableArtifact, Subject } from "../../core/artifacts/schema.js";
import type { RunState, RunStateName } from "../../core/state/machine.js";
import type { DecompositionChild, ForgeHost, IssueSnapshot, PullRequestSnapshot } from "../../core/ports/forge-host.js";
import type { ArtifactRepository } from "../../core/ports/repositories.js";

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
  priorityLabel: "priority:P2" | "P2" | "priority:P3" | "P3";
  milestone?: string;
}

export class GitHubClient implements ForgeHost {
  private readonly initializedLabelRepos = new Map<string, Promise<void>>();

  constructor(readonly cwd = process.cwd()) {}

  async resolveRepository(): Promise<string> {
    return (await this.getRepository()).repo;
  }

  async getRepository(repo?: string): Promise<{ repo: string; defaultBranch: string }> {
    const result = await this.gh(["repo", "view", ...(repo ? [repo] : []), "--json", "nameWithOwner,defaultBranchRef"]);
    const parsed = JSON.parse(result) as { nameWithOwner?: string; defaultBranchRef?: { name?: string } };
    if (!parsed.nameWithOwner || !parsed.defaultBranchRef?.name) throw new Error("Unable to resolve GitHub repository and default branch");
    return { repo: parsed.nameWithOwner, defaultBranch: parsed.defaultBranchRef.name };
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

  async getPullRequestDiff(repo: string, number: number): Promise<string> {
    return this.gh(["pr", "diff", String(number), "--repo", repo]);
  }

  async mergePullRequest(repo: string, number: number, expectedHeadSha: string): Promise<void> {
    const current = await this.getPullRequest(repo, number);
    if (current.headSha !== expectedHeadSha) {
      throw new Error(`Pull request head changed: reviewed ${expectedHeadSha}, current ${current.headSha}`);
    }
    await this.gh([
      "pr", "merge", String(number), "--repo", repo, "--merge", "--delete-branch",
      "--match-head-commit", expectedHeadSha,
    ]);
  }

  async closeIssue(repo: string, number: number, reason: string): Promise<void> {
    await this.postIssueComment({ repo, issue: number }, reason);
    await this.gh(["issue", "close", String(number), "--repo", repo]);
  }

  async materializeBatchIssue(input: BatchIssueInput): Promise<IssueSnapshot> {
    const marker = /<!-- FORGEDOCK:BATCH ([0-9-]+) -->/.exec(input.body)?.[0];
    if (!marker) throw new Error("Batch issue body is missing its deterministic FORGEDOCK:BATCH marker");
    const existing = (await this.listAllIssues(input.repo)).find((issue) => issue.state === "OPEN" && issue.body.includes(marker));
    if (existing) return existing;

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

function decompositionMarker(repo: string, parentIssue: number, title: string): string {
  return createHash("sha256").update(`${repo.toLowerCase()}#${parentIssue}\n${title.trim().toLowerCase()}`).digest("hex");
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
    const targets: Subject[] = artifact.subject.pr && artifact.subject.issue
      ? [{ repo: artifact.subject.repo, pr: artifact.subject.pr }, { repo: artifact.subject.repo, issue: artifact.subject.issue }]
      : [artifact.subject];
    for (const target of targets) {
      const comments = await this.client.listIssueComments(target);
      const exists = comments.flatMap(findArtifacts).some((item) => item.id === artifact.id);
      if (!exists) await this.client.postIssueComment(target, renderArtifactComment(artifact));
    }
  }

  async list(subject: Subject, kind?: ArtifactKind): Promise<DurableArtifact[]> {
    const targets: Subject[] = subject.pr && subject.issue
      ? [{ repo: subject.repo, pr: subject.pr }, { repo: subject.repo, issue: subject.issue }]
      : [subject];
    const found = (await Promise.all(targets.map(async (target) => (await this.client.listIssueComments(target)).flatMap(findArtifacts)))).flat();
    const unique = new Map(found.map((artifact) => [artifact.id, artifact]));
    return [...unique.values()].filter((artifact) => !kind || artifact.kind === kind);
  }
}
