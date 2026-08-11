import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact, normalizeSubject, subjectIdentityKey, subjectsMatch } from "./schema.js";

describe("canonical subject identity", () => {
  it("normalizes forge, repository, and trailing forge-host dots deterministically", () => {
    const first = normalizeSubject({ forge: " GitHub.COM... ", repo: " Acme/Widget ", issue: 7 });
    const second = normalizeSubject({ forge: "github.com", repo: "acme/widget", issue: 7 });
    assert.deepEqual(first, { forge: "github.com", repo: "acme/widget", issue: 7 });
    assert.deepEqual(first, second);
    assert.equal(subjectIdentityKey(first), subjectIdentityKey(second));
    assert.notEqual(subjectIdentityKey(first), subjectIdentityKey({ forge: "forge.example", repo: "acme/widget", issue: 7 }));
  });

  it("requires a valid repository, positive safe locator, and at least one locator", () => {
    assert.throws(() => normalizeSubject({ forge: "github.com", repo: "acme", issue: 1 }), /owner\/name/);
    assert.throws(() => normalizeSubject({ forge: "github.com", repo: "acme/widget" }), /requires an issue/);
    assert.throws(() => normalizeSubject({ forge: "github.com", repo: "acme/widget", issue: 0 }), /positive safe integer/);
    assert.throws(() => normalizeSubject({ forge: "github.com", repo: "acme/widget", pr: Number.MAX_SAFE_INTEGER + 1 }), /positive safe integer/);
  });

  it("canonicalizes newly created artifacts and applies locator overlap", () => {
    const artifact = createArtifact({
      kind: "Intent", runId: "run_subject", subject: { repo: " ACME/Widget ", issue: 4, pr: 9 },
      producer: { role: "test" }, payload: { title: "Subject", problem: "Identity", constraints: [], acceptanceHints: [], dependencies: [] },
    });
    assert.deepEqual(artifact.subject, { forge: "github.com", repo: "acme/widget", issue: 4, pr: 9 });
    assert.equal(subjectsMatch(artifact.subject, { forge: "GITHUB.COM", repo: "acme/widget", pr: 9 }), true);
    assert.equal(subjectsMatch(artifact.subject, { forge: "other.example", repo: "acme/widget", issue: 4 }), false);
  });
});
