#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const repo = option("--repo") ?? fail("--repo owner/repo is required");
const issue = Number(option("--issue") ?? fail("--issue N is required"));
if (!Number.isSafeInteger(issue) || issue < 1) fail("--issue must be a positive integer");
const intervalMs = Number(option("--interval-ms") ?? "2000");
const output = resolve(option("--output") ?? join(".forgedock", "observations", `issue-${issue}.jsonl`));
const once = args.includes("--once");
mkdirSync(dirname(output), { recursive: true });
let previous = "";

while (true) {
  const snapshot = collect();
  const encoded = JSON.stringify(snapshot);
  if (encoded !== previous) {
    appendFileSync(output, `${encoded}\n`, "utf8");
    process.stdout.write(`${snapshot.observedAt} · #${issue} ${snapshot.issue.state} · ${snapshot.issue.labels.join(",") || "no labels"} · run ${snapshot.run?.state ?? "none"}\n`);
    previous = encoded;
  }
  if (once || terminal(snapshot)) break;
  await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalMs));
}

function collect() {
  const issueValue = gh(["issue", "view", String(issue), "--repo", repo, "--json", "number,title,state,stateReason,labels,comments,url"]);
  const parsed = JSON.parse(issueValue);
  const run = localRun(repo, issue);
  return {
    observedAt: new Date().toISOString(),
    issue: {
      number: parsed.number,
      title: parsed.title,
      state: parsed.state,
      stateReason: parsed.stateReason,
      labels: parsed.labels.map((label) => label.name).sort(),
      artifacts: parsed.comments.map((comment) => comment.body.split(/\r?\n/, 1)[0]).filter((line) => line.startsWith("## ForgeDock ·")),
      url: parsed.url,
    },
    run,
    pullRequests: linkedPullRequests(),
    worktrees: git(["worktree", "list", "--porcelain"]),
    subagents: subagentRuns(),
  };
}

function localRun(repoName, issueNumber) {
  const dbPath = resolve(".forgedock", "state.db");
  if (!existsSync(dbPath)) return undefined;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT state_json FROM runs").all();
    const run = rows.map((row) => JSON.parse(row.state_json))
      .filter((candidate) => candidate.subject?.repo === repoName && candidate.subject?.issue === issueNumber)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
    if (!run) return undefined;
    const transitions = db.prepare("SELECT record_json FROM transitions WHERE run_id = ? ORDER BY sequence").all(run.runId).map((row) => JSON.parse(row.record_json));
    return { ...run, transitions };
  } finally { db.close(); }
}

function linkedPullRequests() {
  const timeline = JSON.parse(gh(["api", `repos/${repo}/issues/${issue}/timeline?per_page=100`, "-H", "Accept: application/vnd.github+json"]));
  return timeline.flatMap((event) => {
    const source = event.source?.issue;
    if (event.event !== "cross-referenced" || !source?.pull_request) return [];
    return [{ number: source.number, title: source.title, state: source.state, url: source.html_url }];
  });
}

function subagentRuns() {
  const root = join(tmpdir(), `pi-subagents-user-${process.env.USERNAME ?? process.env.USER ?? "user"}`, "async-subagent-runs");
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((entry) => {
    const file = join(root, entry, "status.json");
    if (!existsSync(file)) return [];
    try {
      const status = JSON.parse(readFileSync(file, "utf8"));
      const relevant = status.steps?.some((step) => step.description?.includes(`issue #${issue}`));
      return relevant ? [{ runId: status.runId, state: status.state, steps: status.steps.map((step) => ({ agent: step.agent, status: step.status, acceptanceStatus: step.acceptance?.status })) }] : [];
    } catch { return []; }
  });
}

function terminal(snapshot) {
  if (snapshot.issue.state === "CLOSED") return true;
  return snapshot.issue.labels.some((label) => ["workflow:decomposed", "workflow:invalid", "workflow:awaiting-merge", "workflow:engine-error", "needs-human"].includes(label));
}

function gh(command) {
  const result = spawnSync("gh", command, { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || `gh ${command[0]} failed`);
  return result.stdout;
}

function git(command) {
  const result = spawnSync("git", command, { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : result.stderr.trim();
}

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function fail(message) { throw new Error(message); }
