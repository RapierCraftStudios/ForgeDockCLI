// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createArtifact, type ArtifactKind, type DurableArtifact } from "../core/artifacts/schema.js";
import { renderArtifactMarkdown } from "../core/artifacts/codec.js";
import { CachedArtifactRepository, ProjectedRunRepository, type RunRepository } from "../core/ports/repositories.js";
import { decideSubjectAdmission } from "../core/state/admission.js";
import { reconcileLatestRunArtifacts } from "../core/state/reconcile.js";
import { GitWorktreeManager } from "../adapters/git/git-worktree.js";
import { GitHubArtifactRepository, GitHubClient } from "../adapters/github/github-client.js";
import { ProcessVerificationRunner } from "../adapters/process/process-verifier.js";
import { PiAgentRuntime } from "../runtime/pi-adapter.js";
import type { AgentEvent } from "../runtime/agent-runtime.js";
import type { CheckResult, VerificationCommand } from "../core/ports/verification.js";
import { colorMode, renderHeader, statusGlyph } from "../tui/brand.js";
import { investigateWorkItem } from "../workflows/work-on/investigate.js";
import { resumeBuildWorkOn, resumeWorkOn, workOn as executeWorkOn } from "../workflows/work-on/work-on.js";
import { reviewExistingPullRequest } from "../workflows/review-pr/review-existing.js";
import { parseBatchMemberIssues } from "../workflows/orchestrate/batching.js";
import { runSchedule, type ScheduledWorkItem } from "../workflows/orchestrate/scheduler.js";
import { discoverVerificationCommands } from "./verification-policy.js";

const args = process.argv.slice(2);
const mode = colorMode();

await main(args).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${statusGlyph("failed", mode)} ${message}`);
  process.exitCode = 1;
});

async function main(argv: string[]): Promise<void> {
  const command = argv[0] ?? "help";
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "work-on") {
    await workOn(argv.slice(1));
    return;
  }
  if (command === "status") {
    await status(argv.slice(1));
    return;
  }
  if (command === "review-pr") {
    await reviewPr(argv.slice(1));
    return;
  }
  if (command === "reset") {
    await resetIssue(argv.slice(1));
    return;
  }
  if (command === "orchestrate") {
    await orchestrate(argv.slice(1));
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

async function status(argv: string[]): Promise<void> {
  const issueValue = option(argv, "--issue");
  if (issueValue !== undefined) {
    if (!/^\d+$/.test(issueValue)) throw new Error("--issue must be a positive integer");
    const github = new GitHubClient(process.cwd());
    const issue = await github.getIssue(Number(issueValue), option(argv, "--repo"));
    const artifacts = await new GitHubArtifactRepository(github).list({ repo: issue.repo, issue: issue.number });
    const reconciled = reconcileLatestRunArtifacts(artifacts);
    const result = { subject: `${issue.repo}#${issue.number}`, ...reconciled };
    if (argv.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      process.stdout.write(`${renderHeader({ subtitle: "status · reconstructed from GitHub" })}\n\n`);
      process.stdout.write(`${statusGlyph(reconciled.state === "completed" ? "passed" : reconciled.state === "blocked" ? "blocked" : "active", mode)} ${result.subject} · ${reconciled.state}\n`);
      for (const warning of reconciled.warnings) process.stdout.write(`  warning: ${warning}\n`);
    }
    return;
  }
  const { SqliteRepositories } = await import("../adapters/sqlite/sqlite-repositories.js");
  const store = new SqliteRepositories(join(process.cwd(), ".forgedock", "state.db"));
  try {
    const runs = store.listRuns();
    if (argv.includes("--json")) {
      process.stdout.write(`${JSON.stringify(runs, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${renderHeader({ subtitle: "status · local operational cache" })}\n\n`);
    if (!runs.length) {
      process.stdout.write("No local runs. Durable semantic artifacts may still exist on GitHub.\n");
      return;
    }
    for (const run of runs) {
      const subject = `${run.subject.repo}${run.subject.issue ? `#${run.subject.issue}` : ""}${run.subject.pr ? ` PR#${run.subject.pr}` : ""}`;
      const state = run.state === "completed" ? "passed" : run.state === "blocked" || run.state === "failed" ? "blocked" : "active";
      process.stdout.write(`${statusGlyph(state, mode)} ${run.runId} · ${subject} · ${run.state} · v${run.version}\n`);
    }
  } finally {
    store.close();
  }
}

async function workOn(argv: string[]): Promise<void> {
  requirePiNodeVersion();
  const issueArg = argv.find((arg) => !arg.startsWith("-"));
  if (!issueArg || !/^\d+$/.test(issueArg)) {
    throw new Error("Usage: forgedock-next work-on <issue-number> [--depends-on N,N] [--through investigate] [--repo owner/repo] [--dry-run] [--auto-merge] [--resume] [--rerun]");
  }
  const through = option(argv, "--through");
  if (through && through !== "investigate") throw new Error("--through currently accepts only investigate");
  const dryRun = argv.includes("--dry-run");
  if (dryRun && through !== "investigate") throw new Error("--dry-run must be paired with --through investigate; full work-on creates a branch and PR");

  process.stdout.write(`${renderHeader({ subtitle: through === "investigate" ? "work-on · investigation barrier" : "work-on · controlled delivery" })}\n\n`);
  const github = new GitHubClient(process.cwd());
  const issue = await github.getIssue(Number(issueArg), option(argv, "--repo"));
  const localRepository = await github.getRepository();
  if (localRepository.repo !== issue.repo) throw new Error(`Current checkout is ${localRepository.repo}, but the issue belongs to ${issue.repo}`);
  const runId = `run_${crypto.randomUUID()}`;
  const subject = { repo: issue.repo, issue: issue.number };
  const authoritativeArtifacts = new GitHubArtifactRepository(github);
  const dependencyIssues = parseIssueNumbers(option(argv, "--depends-on"));
  const batchMembers = parseBatchMemberIssues(issue.body).filter((member) => member !== issue.number);
  const subjectEvidence = issueSubjectEvidence(issue);
  if (batchMembers.length) subjectEvidence.push(`Batch issue #${issue.number} authoritatively represents member issues: ${batchMembers.map((member) => `#${member}`).join(", ")}`);
  if (dependencyIssues.includes(issue.number)) throw new Error(`Issue #${issue.number} cannot depend on itself`);
  for (const dependency of dependencyIssues) {
    const dependencyArtifacts = await authoritativeArtifacts.list({ repo: issue.repo, issue: dependency });
    const reconciled = reconcileLatestRunArtifacts(dependencyArtifacts);
    if (reconciled.state !== "completed") {
      throw new Error(`Dependency #${dependency} is ${reconciled.state}, not completed; refusing to start #${issue.number}`);
    }
    const dependencyIssue = await github.getIssue(dependency, issue.repo);
    const mergedOutcome = dependencyArtifacts
      .filter((artifact): artifact is DurableArtifact<"Outcome"> => artifact.kind === "Outcome" && artifact.payload.status === "merged")
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
    subjectEvidence.push(
      `Dependency #${dependency} admission: authoritative artifact state completed${reconciled.runId ? ` in run ${reconciled.runId}` : ""}; merged Outcome recorded ${mergedOutcome?.createdAt ?? "with no timestamp"}; issue state ${dependencyIssue.state}; labels ${dependencyIssue.labels.join(", ") || "none"}`,
    );
  }
  const priorArtifacts = dryRun ? [] : await authoritativeArtifacts.list(subject);
  let resumeRunId: string | undefined;
  let resumeArtifacts: DurableArtifact[] = [];
  if (!dryRun) {
    const admission = decideSubjectAdmission(priorArtifacts, { rerun: argv.includes("--rerun") });
    if (admission.action === "skip") {
      process.stdout.write(`${statusGlyph("passed", mode)} Existing run ${admission.runId} is already ${admission.state}; no duplicate run was created.\n`);
      return;
    }
    if (admission.action === "block") {
      throw new Error(admission.reason);
    }
    if (admission.action === "resume") {
      if (!argv.includes("--resume")) {
        throw new Error(`Existing run ${admission.runId} has a recoverable ${admission.checkpoint} checkpoint. Re-run with --resume to continue it; reset only if you intentionally want to abandon its durable work`);
      }
      resumeRunId = admission.runId;
      resumeArtifacts = admission.artifacts;
    }
  }
  const intent = createArtifact({
    kind: "Intent", runId, subject,
    producer: { role: "controller", runtime: "forgedock" },
    payload: {
      title: issue.title,
      problem: issue.body || issue.title,
      constraints: [],
      acceptanceHints: [],
      dependencies: dependencyIssues.map((dependency) => `issue-${dependency}`),
      sourceUrl: issue.url,
      conversation: issue.comments
        .filter((comment) => !comment.containsArtifact && comment.body.trim())
        .map((comment) => ({
          author: comment.author,
          createdAt: comment.createdAt,
          body: comment.body,
          ...(comment.url ? { url: comment.url } : {}),
        })),
    },
  });

  const provider = option(argv, "--provider");
  const model = option(argv, "--model");
  const { SqliteRepositories } = await import("../adapters/sqlite/sqlite-repositories.js");
  const store = new SqliteRepositories(join(process.cwd(), ".forgedock", "state.db"));
  const artifacts = dryRun ? store : new CachedArtifactRepository(authoritativeArtifacts, store);
  const runs = dryRun ? store : projectRunsToGitHub(store, github);
  const runtime = new PiAgentRuntime({
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
  });
  const onAgentEvent = (event: AgentEvent) => writeAgentEvent(event);
  const leaseItem = `issue-${issue.number}`;
  const leaseOwner = `work-on-${process.pid}-${crypto.randomUUID()}`;
  const leaseController = new AbortController();
  let leaseToken: string | undefined;
  let leaseHeartbeat: NodeJS.Timeout | undefined;

  try {
    const lease = store.acquire(leaseItem, leaseOwner, 60_000);
    if (!lease) throw new Error(`Issue #${issue.number} already has an active local ForgeDock controller; wait for it or cancel that task before resuming`);
    leaseToken = lease.token;
    leaseHeartbeat = setInterval(() => {
      try { store.heartbeat(leaseItem, lease.token, 60_000); }
      catch (error) { leaseController.abort(error); }
    }, 20_000);

    if (resumeRunId) {
      const admission = decideSubjectAdmission(resumeArtifacts);
      if (admission.action !== "resume" || admission.runId !== resumeRunId) {
        throw new Error(`Run ${resumeRunId} no longer has a recoverable durable checkpoint`);
      }
      const runArtifacts = resumeArtifacts.filter((artifact) => artifact.runId === resumeRunId);
      const intentArtifact = latestArtifact(runArtifacts, "Intent");
      const investigation = latestArtifact(runArtifacts, "Investigation");
      const packet = latestArtifact(runArtifacts, "BuildPacket");
      if (!intentArtifact || !investigation || investigation.payload.outcome !== "confirmed" || !packet) {
        throw new Error(`Run ${resumeRunId} does not contain the Intent, confirmed Investigation, and frozen Build Packet required for ${admission.checkpoint} resume`);
      }
      const checkpointArtifact = admission.checkpoint === "verification" ? latestArtifact(runArtifacts, "Outcome") : packet;
      const artifactIds: Partial<Record<ArtifactKind, string[]>> = {};
      for (const artifact of runArtifacts) artifactIds[artifact.kind] = [...(artifactIds[artifact.kind] ?? []), artifact.id];
      const recoveredRun = {
        schema: "forgedock.run/v1" as const, runId: resumeRunId, workflow: "work-on" as const, subject,
        state: admission.state, attempt: 1, version: 0,
        createdAt: intentArtifact.createdAt, updatedAt: checkpointArtifact?.createdAt ?? packet.createdAt,
        artifactIds,
        ...(admission.state === "blocked" && checkpointArtifact?.kind === "Outcome" ? { blockedReason: checkpointArtifact.payload.reason } : {}),
      };
      let run = await store.load(resumeRunId);
      if (!run) {
        await store.create(recoveredRun);
        run = recoveredRun;
      } else if (run.state !== admission.state) {
        process.stderr.write(`warning: rebuilding divergent local run ${resumeRunId} (${run.state}) from durable GitHub state (${admission.state})\n`);
        store.rebuildRun(recoveredRun);
        run = recoveredRun;
      }

      const baseRef = `origin/${localRepository.defaultBranch}`;
      const git = new GitWorktreeManager(process.cwd());
      const verifier = new ProcessVerificationRunner();
      let workspace;
      let outcome: DurableArtifact<"Outcome"> | undefined;
      if (admission.checkpoint === "build") {
        workspace = await git.recover({ runId: resumeRunId, issue: issue.number, baseRef });
      } else {
        outcome = latestArtifact(runArtifacts, "Outcome");
        if (!outcome || outcome.payload.status !== "blocked" || !outcome.payload.failureEvidence) {
          throw new Error(`Run ${resumeRunId} does not contain complete retained verification evidence`);
        }
        workspace = {
          path: outcome.payload.failureEvidence.workspacePath,
          branch: outcome.payload.failureEvidence.branch,
          baseRef,
        };
        if (!existsSync(workspace.path)) throw new Error(`Recovery workspace is unavailable: ${workspace.path}`);
      }
      const verification = discoverVerificationCommands(process.cwd(), baseRef);
      const baselineChecks = await collectBaselineChecks({ git, verifier, verification, issue: issue.number, runId: resumeRunId, baseRef });
      process.stdout.write(`${statusGlyph("active", mode)} Resuming ${resumeRunId} from its durable ${admission.checkpoint} checkpoint; completed semantic phases will not replay\n`);
      const common = {
        run, intent: intentArtifact, investigation, packet, workspace,
        baseBranch: localRepository.defaultBranch, verification, baselineChecks,
        subjectEvidence,
        ...(batchMembers.length ? { batchMembers } : {}),
        autoMerge: argv.includes("--auto-merge"),
        ...(provider !== undefined ? { provider } : {}),
        ...(model !== undefined ? { model } : {}),
        signal: leaseController.signal,
      };
      const dependencies = { runtime, artifacts, runs, git, verifier, host: github, onAgentEvent };
      const result = admission.checkpoint === "build"
        ? await resumeBuildWorkOn(common, dependencies)
        : await resumeWorkOn({ ...common, outcome: outcome! }, dependencies);
      const suffix = result.awaitingHuman ? ` · awaiting human merge at ${result.pullRequest?.url ?? "PR"}` : "";
      process.stdout.write(`${statusGlyph(result.run.state === "completed" ? "passed" : "blocked", mode)} Resumed run ${result.run.runId} · ${result.run.state}${suffix}\n`);
      if (result.run.state !== "completed") process.exitCode = 2;
      return;
    }

    if (through === "investigate") {
      process.stdout.write(`${statusGlyph("active", mode)} Investigating ${issue.repo}#${issue.number} — ${issue.title}\n`);
      const result = await investigateWorkItem({
        intent, priorArtifacts, cwd: process.cwd(),
        ...(provider !== undefined ? { provider } : {}),
        ...(model !== undefined ? { model } : {}),
        signal: leaseController.signal,
      }, { runtime, artifacts, runs, decomposer: github, onAgentEvent });
      process.stdout.write(`\n${renderArtifactMarkdown(result.investigation)}\n\n`);
      process.stdout.write(`${statusGlyph("passed", mode)} Investigation committed · run state: ${result.run.state}${dryRun ? " · dry run (not published)" : ""}\n`);
      return;
    }

    const baseRef = `origin/${localRepository.defaultBranch}`;
    const verification = discoverVerificationCommands(process.cwd(), baseRef);
    const git = new GitWorktreeManager(process.cwd());
    const verifier = new ProcessVerificationRunner();
    const baselineChecks = await collectBaselineChecks({ git, verifier, verification, issue: issue.number, runId, baseRef });
    process.stdout.write(`${statusGlyph("active", mode)} Running full workflow for ${issue.repo}#${issue.number}\n`);
    const result = await executeWorkOn({
      intent,
      priorArtifacts,
      repoPath: process.cwd(),
      baseBranch: localRepository.defaultBranch,
      baseRef,
      verification,
      baselineChecks,
      subjectEvidence,
      ...(batchMembers.length ? { batchMembers } : {}),
      autoMerge: argv.includes("--auto-merge"),
      ...(provider !== undefined ? { provider } : {}),
      ...(model !== undefined ? { model } : {}),
      signal: leaseController.signal,
    }, {
      runtime, artifacts, runs,
      git,
      verifier,
      host: github,
      onAgentEvent,
    });
    const suffix = result.awaitingHuman ? ` · awaiting human merge at ${result.pullRequest?.url ?? "PR"}` : "";
    process.stdout.write(`${statusGlyph(result.run.state === "completed" ? "passed" : "blocked", mode)} Run ${result.run.runId} · ${result.run.state}${suffix}\n`);
    if (result.run.state !== "completed") process.exitCode = 2;
  } finally {
    if (leaseHeartbeat) clearInterval(leaseHeartbeat);
    if (leaseToken) store.release(leaseItem, leaseToken);
    await runtime.close();
    store.close();
  }
}

async function resetIssue(argv: string[]): Promise<void> {
  const issueArg = argv.find((arg) => !arg.startsWith("-"));
  if (!issueArg || !/^\d+$/.test(issueArg)) throw new Error("Usage: forgedock-next reset <issue-number> [--repo owner/repo] [--reason text]");
  const github = new GitHubClient(process.cwd());
  const issue = await github.getIssue(Number(issueArg), option(argv, "--repo"));
  const repository = new GitHubArtifactRepository(github);
  const all = await repository.list({ repo: issue.repo, issue: issue.number });
  const latestRun = latestRunArtifacts(all);
  if (!latestRun) {
    await github.clearWorkflowLabels(issue.repo, issue.number);
    process.stdout.write(`Reset ${issue.repo}#${issue.number}; no durable run existed.\n`);
    return;
  }
  const reason = option(argv, "--reason") ?? "User-requested pipeline reset before a clean rerun; prior comments remain durable audit history.";
  const priorOutcome = latestArtifact(latestRun.artifacts, "Outcome");
  if (priorOutcome?.payload.status !== "abandoned") {
    await repository.append(createArtifact({
      kind: "Outcome", runId: latestRun.runId, subject: { repo: issue.repo, issue: issue.number },
      producer: { role: "controller", runtime: "forgedock" },
      payload: { status: "abandoned", reason, childIssues: [] },
    }));
  }
  const verdict = latestArtifact(latestRun.artifacts, "ReviewVerdict");
  const buildResult = latestArtifact(latestRun.artifacts, "BuildResult");
  const pr = verdict?.subject.pr
    ? await github.getPullRequest(issue.repo, verdict.subject.pr)
    : buildResult ? await github.findOpenPullRequest(issue.repo, buildResult.payload.branch) : undefined;
  if (pr?.state === "OPEN") await github.closePullRequest(issue.repo, pr.number, reason);
  await github.clearWorkflowLabels(issue.repo, issue.number);
  process.stdout.write(`Reset ${issue.repo}#${issue.number}; run ${latestRun.runId} is abandoned and audit comments are retained.\n`);
}

async function reviewPr(argv: string[]): Promise<void> {
  requirePiNodeVersion();
  const prArg = argv.find((arg) => !arg.startsWith("-"));
  if (!prArg || !/^\d+$/.test(prArg)) throw new Error("Usage: forgedock-next review-pr <pr-number> [--repo owner/repo] [--issue number]");
  process.stdout.write(`${renderHeader({ subtitle: "review-pr · fresh context · SHA anchored" })}\n\n`);
  const github = new GitHubClient(process.cwd());
  const localRepository = await github.getRepository();
  const repo = option(argv, "--repo") ?? localRepository.repo;
  if (repo !== localRepository.repo) throw new Error(`Current checkout is ${localRepository.repo}; review workspace for ${repo} is unavailable here`);
  const issueValue = option(argv, "--issue");
  if (issueValue && !/^\d+$/.test(issueValue)) throw new Error("--issue must be a positive integer");
  const provider = option(argv, "--provider");
  const model = option(argv, "--model");
  const { SqliteRepositories } = await import("../adapters/sqlite/sqlite-repositories.js");
  const store = new SqliteRepositories(join(process.cwd(), ".forgedock", "state.db"));
  const artifacts = new CachedArtifactRepository(new GitHubArtifactRepository(github), store);
  const runs = projectRunsToGitHub(store, github);
  const runtime = new PiAgentRuntime({
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
  });
  try {
    const result = await reviewExistingPullRequest({
      repo, pr: Number(prArg),
      ...(issueValue !== undefined ? { issue: Number(issueValue) } : {}),
      ...(provider !== undefined ? { provider } : {}),
      ...(model !== undefined ? { model } : {}),
    }, {
      runtime, host: github, workspaces: new GitWorktreeManager(process.cwd()), artifacts, runs,
      onAgentEvent: (event) => writeAgentEvent(event),
    });
    process.stdout.write(`\n${renderArtifactMarkdown(result.verdict)}\n\n`);
    const approved = result.verdict.payload.disposition === "approve";
    process.stdout.write(`${statusGlyph(approved ? "passed" : "blocked", mode)} Review ${result.verdict.payload.disposition} at ${result.verdict.payload.headSha}\n`);
    if (!approved) process.exitCode = 2;
  } finally {
    await runtime.close();
    store.close();
  }
}

async function orchestrate(argv: string[]): Promise<void> {
  requirePiNodeVersion();
  const issueNumbers = argv.filter((arg) => /^\d+$/.test(arg)).map(Number);
  if (!issueNumbers.length) throw new Error("Usage: forgedock-next orchestrate <issue>... [--max-parallel N] [--dry-run] [--auto-merge] [--rerun]");
  const maxParallelValue = option(argv, "--max-parallel") ?? "2";
  if (!/^\d+$/.test(maxParallelValue) || Number(maxParallelValue) < 1) throw new Error("--max-parallel must be a positive integer");
  process.stdout.write(`${renderHeader({ subtitle: "orchestrate · dependencies · claims · bounded concurrency" })}\n\n`);
  const github = new GitHubClient(process.cwd());
  const repository = await github.getRepository();
  const items = loadOrchestrationItems(issueNumbers, repository.repo);
  if (argv.includes("--dry-run")) {
    for (const item of items) process.stdout.write(`${item.id} · depends [${item.dependencies.join(", ") || "none"}] · claims [${item.claims.join(", ")}]\n`);
    return;
  }

  const provider = option(argv, "--provider");
  const model = option(argv, "--model");
  const runtime = new PiAgentRuntime({
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
  });
  const { SqliteRepositories } = await import("../adapters/sqlite/sqlite-repositories.js");
  const store = new SqliteRepositories(join(process.cwd(), ".forgedock", "state.db"));
  const artifacts = new CachedArtifactRepository(new GitHubArtifactRepository(github), store);
  const runs = projectRunsToGitHub(store, github);
  const git = new GitWorktreeManager(process.cwd());
  const verifier = new ProcessVerificationRunner();
  const verification = discoverVerificationCommands(process.cwd());
  const outcomes = new Map<string, string>();
  const skipped = new Map<string, string>();
  try {
    const owner = `pid-${process.pid}-${crypto.randomUUID()}`;
    const schedule = await runSchedule(items, Number(maxParallelValue), async (item) => {
      const lease = store.acquire(item.id, owner, 60_000);
      if (!lease) throw new Error(`${item.id} already has an active ForgeDock lease`);
      const controller = new AbortController();
      const heartbeat = setInterval(() => {
        try { store.heartbeat(item.id, lease.token, 60_000); }
        catch (error) { controller.abort(error); }
      }, 20_000);
      try {
        const subject = { repo: repository.repo, issue: item.issue };
        const admission = decideSubjectAdmission(await artifacts.list(subject), { rerun: argv.includes("--rerun") });
        if (admission.action === "skip") {
          skipped.set(item.id, admission.state);
          outcomes.set(item.id, admission.state);
          process.stdout.write(`${statusGlyph("passed", mode)} ${item.id} skipped · existing run ${admission.runId} is ${admission.state}\n`);
          return;
        }
        if (admission.action === "block") {
          throw new Error(admission.reason);
        }
        if (admission.action === "resume") {
          clearInterval(heartbeat);
          store.release(item.id, lease.token);
          const resumeArgs = [String(item.issue), "--repo", repository.repo, "--resume"];
          const dependencies = item.dependencies.map(issueNumberFromScheduledId);
          if (dependencies.length) resumeArgs.push("--depends-on", dependencies.join(","));
          if (argv.includes("--auto-merge")) resumeArgs.push("--auto-merge");
          if (provider !== undefined) resumeArgs.push("--provider", provider);
          if (model !== undefined) resumeArgs.push("--model", model);
          await workOn(resumeArgs);
          const resumed = reconcileLatestRunArtifacts(await artifacts.list(subject));
          outcomes.set(item.id, resumed.state);
          if (resumed.state !== "completed") throw new Error(`${item.id} resumed to ${resumed.state}; dependents remain blocked`);
          process.stdout.write(`${statusGlyph("passed", mode)} ${item.id} resumed · completed\n`);
          return;
        }
        const issue = await github.getIssue(item.issue, repository.repo);
        const intent = createArtifact({
          kind: "Intent", runId: `run_${crypto.randomUUID()}`, subject: { repo: repository.repo, issue: item.issue },
          producer: { role: "controller", runtime: "forgedock" },
          payload: { title: issue.title, problem: issue.body || issue.title, constraints: [], acceptanceHints: [], dependencies: [...item.dependencies], sourceUrl: issue.url },
        });
        process.stdout.write(`${statusGlyph("active", mode)} ${item.id} started\n`);
        const result = await executeWorkOn({
          intent, repoPath: process.cwd(), baseBranch: repository.defaultBranch, baseRef: `origin/${repository.defaultBranch}`,
          verification, autoMerge: argv.includes("--auto-merge"), signal: controller.signal,
          ...(provider !== undefined ? { provider } : {}),
          ...(model !== undefined ? { model } : {}),
        }, {
          runtime, artifacts, runs, git, verifier, host: github,
          onAgentEvent: (event) => writeAgentEvent(event, item.id),
        });
        outcomes.set(item.id, result.run.state);
        process.stdout.write(`${statusGlyph(result.run.state === "completed" || result.run.state === "merging" ? "passed" : "blocked", mode)} ${item.id} ${result.run.state}\n`);
        if (result.run.state !== "completed") throw new Error(`${item.id} ended in ${result.run.state}; dependents remain blocked`);
      } finally {
        clearInterval(heartbeat);
        store.release(item.id, lease.token);
      }
    });
    const failed = [...schedule.status.entries()].filter(([, status]) => status === "failed" || status === "blocked");
    const completed = [...schedule.status.values()].filter((status) => status === "completed").length;
    process.stdout.write(`\nOrchestration complete · ${completed - skipped.size} dispatched successfully · ${skipped.size} already terminal · ${failed.length} blocked/failed\n`);
    for (const [id, state] of outcomes) process.stdout.write(`  ${id}: ${state}\n`);
    if (failed.length) process.exitCode = 2;
  } finally {
    await runtime.close();
    store.close();
  }
}

function projectRunsToGitHub(runs: RunRepository, github: GitHubClient): RunRepository {
  return new ProjectedRunRepository(
    runs,
    (state) => github.projectRunState(state),
    (error, state) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`warning: GitHub label projection failed for ${state.subject.repo}#${state.subject.issue ?? "?"} at ${state.state}: ${message}\n`);
    },
  );
}

function loadOrchestrationItems(issueNumbers: number[], repo: string): ScheduledWorkItem[] {
  let configured: { items?: Array<{ issue: number; dependsOn?: number[]; claims?: string[]; priority?: number }> } = {};
  const configPath = join(process.cwd(), "forgedock.orchestrate.json");
  if (existsSync(configPath)) {
    try { configured = JSON.parse(readFileSync(configPath, "utf8")); }
    catch (error) { throw new Error(`Invalid forgedock.orchestrate.json: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const selected = new Set(issueNumbers);
  return issueNumbers.map((issue) => {
    const config = configured.items?.find((item) => item.issue === issue);
    const missing = (config?.dependsOn ?? []).filter((dependency) => !selected.has(dependency));
    if (missing.length) throw new Error(`Issue ${issue} depends on unselected issue(s): ${missing.join(", ")}`);
    const dependencies = (config?.dependsOn ?? []).map((dependency) => `issue-${dependency}`);
    return {
      id: `issue-${issue}`,
      issue,
      priority: config?.priority ?? 100,
      dependencies,
      claims: config?.claims?.length ? config.claims : [`component:${repo}`],
    };
  });
}

function issueSubjectEvidence(issue: { number: number; body: string; labels: readonly string[] }): string[] {
  const compactBody = issue.body.replace(/\s+/g, " ").trim().slice(0, 2_000);
  return [
    `GitHub issue #${issue.number} labels: ${issue.labels.length ? issue.labels.join(", ") : "none"}`,
    `GitHub issue #${issue.number} body: ${compactBody || "(empty)"}`,
  ];
}

function latestRunArtifacts(artifacts: readonly DurableArtifact[]): { runId: string; artifacts: DurableArtifact[] } | undefined {
  const byRun = new Map<string, DurableArtifact[]>();
  for (const artifact of artifacts) byRun.set(artifact.runId, [...(byRun.get(artifact.runId) ?? []), artifact]);
  return [...byRun.entries()]
    .map(([runId, values]) => ({ runId, artifacts: values, timestamp: Math.max(...values.map((artifact) => Date.parse(artifact.createdAt) || 0)) }))
    .sort((left, right) => right.timestamp - left.timestamp || right.runId.localeCompare(left.runId))
    .map(({ runId, artifacts: values }) => ({ runId, artifacts: values }))[0];
}

function latestArtifact<K extends ArtifactKind>(artifacts: readonly DurableArtifact[], kind: K): DurableArtifact<K> | undefined {
  return artifacts
    .filter((artifact): artifact is DurableArtifact<K> => artifact.kind === kind)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
}

async function collectBaselineChecks(input: {
  git: GitWorktreeManager;
  verifier: ProcessVerificationRunner;
  verification: readonly Omit<VerificationCommand, "cwd">[];
  issue: number;
  runId: string;
  baseRef: string;
}): Promise<CheckResult[]> {
  const workspace = await input.git.create({ runId: `${input.runId}-baseline`, issue: input.issue, baseRef: input.baseRef });
  try {
    return await input.verifier.run(input.verification.map((command) => ({ ...command, cwd: workspace.path })));
  } finally {
    await input.git.remove(workspace);
  }
}

function writeAgentEvent(event: AgentEvent, prefix?: string): void {
  const task = prefix ? `${prefix} · ${event.taskId}` : event.taskId;
  if (event.type === "session.started") {
    process.stdout.write(`  ${statusGlyph("active", mode)} ${task} · ${event.provider}/${event.model}\n`);
  } else if (event.type === "tool.started") {
    process.stdout.write(`    ${statusGlyph("active", mode)} ${task} · ${event.tool}\n`);
  } else if (event.type === "artifact.submitted") {
    process.stdout.write(`  ${statusGlyph("passed", mode)} ${task} · artifact submitted\n`);
  } else if (event.type === "session.completed") {
    process.stdout.write(`  ${statusGlyph("passed", mode)} ${task} · session complete\n`);
  }
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function issueNumberFromScheduledId(id: string): number {
  const match = /^issue-(\d+)$/.exec(id);
  if (!match) throw new Error(`Invalid scheduled issue dependency: ${id}`);
  return Number(match[1]);
}

function parseIssueNumbers(value: string | undefined): number[] {
  if (!value) return [];
  const values = value.split(",").map((item) => item.trim());
  if (values.some((item) => !/^\d+$/.test(item) || Number(item) < 1)) throw new Error("--depends-on must be a comma-separated list of positive issue numbers");
  return [...new Set(values.map(Number))];
}

function requirePiNodeVersion(): void {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) {
    throw new Error(`Pi 0.83.0 requires Node >=22.19.0; current Node is ${process.versions.node}`);
  }
}

function printHelp(): void {
  process.stdout.write(`${renderHeader({ subtitle: "greenfield workflow runtime" })}\n\n`);
  process.stdout.write("Core workflows\n");
  process.stdout.write("  forgedock-next work-on <issue> [--depends-on N,N] [--repo owner/repo] [--auto-merge] [--resume] [--rerun]\n");
  process.stdout.write("  forgedock-next work-on <issue> --through investigate --dry-run\n");
  process.stdout.write("  forgedock-next review-pr <pr> [--repo owner/repo] [--issue number]\n");
  process.stdout.write("  forgedock-next reset <issue> [--repo owner/repo] [--reason text]\n");
  process.stdout.write("  forgedock-next orchestrate <issues> [--max-parallel N] [--dry-run] [--auto-merge] [--rerun]\n");
  process.stdout.write("  forgedock-next status [--json] [--issue N --repo owner/repo]\n\n");
  process.stdout.write("Model selection uses --provider/--model or PI_PROVIDER/PI_MODEL.\n");
}
