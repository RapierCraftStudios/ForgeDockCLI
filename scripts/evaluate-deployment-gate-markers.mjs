#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";

const V2_MARKER = /<!--\s*FORGEDOCK:DEPLOYMENT_GATE_(START|PASS|FAILURE)\s+v2\s+repo=([^\s>]+)\s+pr=([0-9]+)\s+head=([0-9a-fA-F]{40,64})\s*-->/g;
const LEGACY_TERMINAL_MARKER = /<!--\s*FORGE:GATE_(PASS|FAILURE)\s*-->/g;
const LEGACY_IDENTITY_MARKER = /<!--\s*FORGEDOCK:DEPLOYMENT_GATE:[A-Za-z0-9._-]+:([0-9a-fA-F]{40,64})\s*-->/g;
const SPEC_LOADED_MARKER = /<!--\s*FORGE:SPEC_LOADED\s*-->/i;

/**
 * Evaluate trusted PR comments/reviews against the exact deployment route.
 * A failure for the current head is intentionally dominant. Recovery should
 * produce a new head SHA rather than attempting to supersede failure evidence
 * with another marker for the same immutable commit.
 */
export function evaluateDeploymentGateMarkers({ items, repo, pullRequest, headSha, trustedAuthors }) {
  const expectedRepo = normalizeRepo(repo);
  const expectedPr = normalizePullRequest(pullRequest);
  const expectedHead = normalizeHead(headSha);
  const trusted = new Set(trustedAuthors.map(normalizeLogin).filter(Boolean));
  const counts = {
    pass: 0,
    failure: 0,
    start: 0,
    legacyPass: 0,
    legacyFailure: 0,
    specLoaded: 0,
    untrusted: 0,
    mismatched: 0,
  };

  for (const item of items) {
    const login = normalizeLogin(item?.login);
    const body = typeof item?.body === "string" ? item.body : "";
    if (!trusted.has(login)) {
      if (containsAnyGateMarker(body)) counts.untrusted++;
      continue;
    }

    let bodyBoundToCurrentHead = false;
    for (const match of body.matchAll(V2_MARKER)) {
      const [, state, markerRepo, markerPr, markerHead] = match;
      if (normalizeRepoForComparison(markerRepo) !== expectedRepo
        || Number(markerPr) !== expectedPr
        || markerHead.toLowerCase() !== expectedHead) {
        counts.mismatched++;
        continue;
      }
      bodyBoundToCurrentHead = true;
      if (state === "PASS") counts.pass++;
      if (state === "FAILURE") counts.failure++;
      if (state === "START") counts.start++;
    }

    const legacyHeads = [...body.matchAll(LEGACY_IDENTITY_MARKER)].map((match) => match[1].toLowerCase());
    const legacyBoundToCurrentHead = legacyHeads.includes(expectedHead);
    if (legacyHeads.some((sha) => sha !== expectedHead)) counts.mismatched++;
    if (legacyBoundToCurrentHead) {
      bodyBoundToCurrentHead = true;
      for (const match of body.matchAll(LEGACY_TERMINAL_MARKER)) {
        if (match[1] === "PASS") counts.legacyPass++;
        if (match[1] === "FAILURE") counts.legacyFailure++;
      }
    } else if (body.includes("<!-- FORGE:GATE_PASS") || body.includes("<!-- FORGE:GATE_FAILURE")) {
      // A bare FORGE:GATE_* marker is not durable evidence for a commit.
      counts.mismatched++;
    }

    if (bodyBoundToCurrentHead && SPEC_LOADED_MARKER.test(body)) counts.specLoaded++;
  }

  const failure = counts.failure + counts.legacyFailure;
  const pass = counts.pass + counts.legacyPass;
  return {
    markerFound: failure > 0 ? "failure" : pass > 0 ? "pass" : "none",
    counts,
  };
}

function containsAnyGateMarker(body) {
  return body.includes("FORGEDOCK:DEPLOYMENT_GATE_")
    || body.includes("FORGEDOCK:DEPLOYMENT_GATE:")
    || body.includes("FORGE:GATE_PASS")
    || body.includes("FORGE:GATE_FAILURE");
}

function normalizeRepo(value) {
  const repo = normalizeRepoForComparison(value);
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo)) {
    throw new Error(`Invalid repository identity: ${String(value)}`);
  }
  return repo;
}

function normalizeRepoForComparison(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizePullRequest(value) {
  const pullRequest = Number(value);
  if (!Number.isSafeInteger(pullRequest) || pullRequest <= 0) {
    throw new Error(`Invalid pull request identity: ${String(value)}`);
  }
  return pullRequest;
}

function normalizeHead(value) {
  const head = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{40,64}$/.test(head)) throw new Error(`Invalid head SHA: ${String(value)}`);
  return head;
}

function normalizeLogin(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

async function readStandardInput() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  if (!text.trim()) return [];
  return text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid marker item JSON on input line ${index + 1}: ${error.message}`);
    }
  });
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${key ?? "<end>"}`);
    values.set(key.slice(2), value);
  }
  return {
    repo: values.get("repo"),
    pullRequest: values.get("pr"),
    headSha: values.get("head"),
    trustedAuthors: (values.get("trusted-authors") ?? "").split(","),
  };
}

async function main() {
  const input = parseArguments(process.argv.slice(2));
  const result = evaluateDeploymentGateMarkers({ ...input, items: await readStandardInput() });
  const { counts } = result;
  process.stdout.write([
    `marker_found=${result.markerFound}`,
    `gate_pass=${counts.pass + counts.legacyPass}`,
    `gate_failure=${counts.failure + counts.legacyFailure}`,
    `gate_start=${counts.start}`,
    `spec_loaded=${counts.specLoaded}`,
    `ignored_untrusted=${counts.untrusted}`,
    `ignored_mismatched=${counts.mismatched}`,
    "",
  ].join("\n"));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
