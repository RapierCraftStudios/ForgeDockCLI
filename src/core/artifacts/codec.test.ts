import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { InMemoryArtifactRepository } from "../ports/repositories.js";
import { SqliteRepositories } from "../../adapters/sqlite/sqlite-repositories.js";
import { createArtifact, normalizeSubject, subjectIdentityKey } from "./schema.js";
import { decodeArtifactMarker, encodeArtifactMarker, findArtifacts, renderArtifactComment } from "./codec.js";

function intent() {
  return createArtifact({
    kind: "Intent",
    runId: "run_test",
    subject: { repo: "acme/widget", issue: 42 },
    producer: { role: "controller", runtime: "forgedock" },
    payload: {
      title: "Fix delimiter handling",
      problem: "Input may contain --> and <!-- without damaging transport.",
      constraints: ["No regression"],
      acceptanceHints: ["Round trip"],
      dependencies: [],
    },
  }, { id: "art_test", createdAt: "2026-08-03T00:00:00.000Z" });
}

describe("artifact codec", () => {
  it("round trips a versioned artifact without HTML delimiter risk", () => {
    const artifact = intent();
    const marker = encodeArtifactMarker(artifact);
    assert.doesNotMatch(marker.slice(4, -3), /<!--|-->/);
    assert.deepEqual(decodeArtifactMarker(marker), artifact);
  });

  it("renders readable markdown plus a machine marker", () => {
    const comment = renderArtifactComment(intent());
    assert.match(comment, /ForgeDock · Intent/);
    assert.match(comment, /Fix delimiter handling/);
    assert.match(comment, /FORGEDOCK:ARTIFACT v2/);
  });

  it("decodes legacy v2 subjects into canonical GitHub subjects", () => {
    const artifact = intent();
    const legacy = { ...artifact, subject: { repo: "Acme/Widget", issue: 42 } };
    const marker = `<!-- FORGEDOCK:ARTIFACT v2 b64:${Buffer.from(JSON.stringify(legacy), "utf8").toString("base64url")} -->`;
    assert.deepEqual(decodeArtifactMarker(marker).subject, artifact.subject);
  });

  it("normalizes equivalent subjects to a deterministic identity", () => {
    const normalized = normalizeSubject({ repo: "  ACME/Widget  ", issue: 42 });
    const canonical = normalizeSubject({ forge: "github", repo: "acme/widget", issue: 42 });
    assert.deepEqual(normalized, { forge: "github", repo: "acme/widget", issue: 42 });
    assert.deepEqual(normalized, canonical);
    assert.equal(subjectIdentityKey(normalized), subjectIdentityKey(canonical));
  });

  it("rejects malformed, ambiguous, and unsafe subjects", () => {
    for (const subject of [
      { repo: "acme", issue: 1 },
      { repo: "acme/widget/extra", issue: 1 },
      { repo: "acme/widget", issue: 0 },
      { repo: "acme/widget", issue: 1.5 },
      { repo: "acme/widget", issue: Number.MAX_SAFE_INTEGER + 1 },
      { repo: "acme/widget" },
      { forge: "gitlab", repo: "acme/widget", issue: 1 },
      { repo: "acme/widget", issue: 1, extra: true },
    ]) {
      assert.throws(() => normalizeSubject(subject));
    }
  });

  it("matches equivalent targets without merging repositories or issue numbers", async () => {
    const repository = new InMemoryArtifactRepository();
    const make = (id: string, subject: { repo: string; issue?: number; pr?: number }) => createArtifact({
      kind: "Intent", runId: id, subject, producer: { role: "test" },
      payload: { title: id, problem: "test", constraints: [], acceptanceHints: [], dependencies: [] },
    }, { id, createdAt: "2026-01-01T00:00:00.000Z" });
    const issue = make("issue", { repo: "Acme/Widget", issue: 1 });
    const pull = make("pull", { repo: "acme/widget", pr: 2 });
    const both = make("both", { repo: "acme/widget", issue: 1, pr: 2 });
    const unrelated = make("unrelated", { repo: "acme/widget", issue: 9 });
    const otherRepo = make("other-repo", { repo: "other/repo", issue: 1 });
    for (const artifact of [issue, pull, both, unrelated, otherRepo]) await repository.append(artifact);
    assert.deepEqual((await repository.list({ repo: " ACME/WIDGET ", issue: 1 })).map((artifact) => artifact.id), [issue.id, both.id]);
    assert.deepEqual((await repository.list({ repo: "acme/widget", issue: 1, pr: 2 })).map((artifact) => artifact.id), [issue.id, pull.id, both.id]);
  });

  it("preserves and reindexes legacy SQLite rows across reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "forgedock-sqlite-"));
    const path = join(directory, "cache.sqlite");
    const artifact = intent();
    const legacyJson = JSON.stringify({ ...artifact, subject: { repo: " ACME/Widget ", issue: 42 } });
    const fixture = new DatabaseSync(path);
    fixture.exec("CREATE TABLE artifacts (artifact_id TEXT PRIMARY KEY, subject_key TEXT NOT NULL, kind TEXT NOT NULL, artifact_json TEXT NOT NULL);");
    fixture.prepare("INSERT INTO artifacts VALUES (?, ?, ?, ?)").run(artifact.id, "legacy-key", artifact.kind, legacyJson);
    fixture.close();
    const store = new SqliteRepositories(path);
    try {
      const migratedDb = new DatabaseSync(path);
      const rows = migratedDb.prepare("SELECT artifact_id, kind, artifact_json, subject_key FROM artifacts").all() as Array<{ artifact_id: string; kind: string; artifact_json: string; subject_key: string }>;
      migratedDb.close();
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.artifact_id, artifact.id);
      assert.equal(rows[0]?.kind, artifact.kind);
      assert.equal(rows[0]?.artifact_json, legacyJson);
      assert.equal(rows[0]?.subject_key, subjectIdentityKey(artifact.subject));
      assert.deepEqual((await store.list({ repo: "acme/widget", issue: 42 })).map((item) => item.id), [artifact.id]);
    } finally {
      store.close();
    }
    const reopened = new SqliteRepositories(path);
    try {
      assert.deepEqual((await reopened.list({ repo: "ACME/WIDGET", issue: 42 })).map((item) => item.id), [artifact.id]);
    } finally {
      reopened.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls back SQLite migration on malformed legacy input", () => {
    const directory = mkdtempSync(join(tmpdir(), "forgedock-sqlite-"));
    const path = join(directory, "broken.sqlite");
    const fixture = new DatabaseSync(path);
    fixture.exec("CREATE TABLE artifacts (artifact_id TEXT PRIMARY KEY, subject_key TEXT NOT NULL, kind TEXT NOT NULL, artifact_json TEXT NOT NULL);");
    fixture.prepare("INSERT INTO artifacts VALUES (?, ?, ?, ?)").run("bad", "legacy-key", "Intent", JSON.stringify({ subject: { repo: "invalid", issue: 1 } }));
    fixture.close();
    assert.throws(() => new SqliteRepositories(path), /repository/);
    const afterFailure = new DatabaseSync(path);
    try {
      assert.deepEqual(
        afterFailure.prepare("SELECT artifact_id, subject_key FROM artifacts").all().map((row) => ({ ...(row as { artifact_id: string; subject_key: string }) })),
        [{ artifact_id: "bad", subject_key: "legacy-key" }],
      );
    } finally {
      afterFailure.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("never renders a baseline-equivalent required failure as passed", () => {
    const outcome = createArtifact({
      kind: "Outcome",
      runId: "run_test",
      subject: { repo: "acme/widget", issue: 42 },
      producer: { role: "controller", runtime: "forgedock" },
      payload: {
        status: "blocked",
        reason: "Required verification failed",
        childIssues: [],
        failureEvidence: {
          branch: "forgedock/issue-42",
          workspacePath: "/tmp/issue-42",
          builderSummary: "Implemented the change",
          changedPaths: ["src/index.ts"],
          checks: [{
            command: "npm test", status: "failed", exitCode: 1, durationMs: 10,
            outputDigest: "a".repeat(64), failureSignatures: ["not ok - flaky fixture"],
            baselineStatus: "failed", baselineFailureSignatures: ["not ok - flaky fixture"], regression: false,
          }],
        },
      },
    });
    const comment = renderArtifactComment(outcome);
    assert.match(comment, /failed \(baseline failures unchanged\)/);
    assert.doesNotMatch(comment, /passed \(baseline failures unchanged\)/);
  });

  it("skips a damaged marker and continues parsing valid markers", () => {
    const good = encodeArtifactMarker(intent());
    const found = findArtifacts(`<!-- FORGEDOCK:ARTIFACT v2 b64:not-json -->\n${good}`);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.id, "art_test");
  });
});
