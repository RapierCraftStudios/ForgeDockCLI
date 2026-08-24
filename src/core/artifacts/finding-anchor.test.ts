// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDiffManifest, resolveRepositoryAnchor } from "./finding-anchor.js";

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const HASH = "c".repeat(64);
const modified = `diff --git a/src/a.ts b/src/a.ts\nindex ${OLD}..${NEW} 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n`;

function anchor(overrides: Record<string, unknown> = {}) {
  return { version: 1 as const, kind: "repository-location" as const, path: "src/a.ts", blobSha: NEW, side: "new" as const, range: { start: 2, end: 2 }, snippetHash: HASH, ...overrides };
}

describe("versioned finding anchors and frozen diff resolver", () => {
  it("accepts exact modified-file evidence and gives the manifest a stable identity", () => {
    const first = buildDiffManifest({ diff: modified, headSha: NEW });
    const second = buildDiffManifest({ diff: modified, headSha: NEW });
    assert.equal(first.identity, second.identity);
    assert.equal(resolveRepositoryAnchor(anchor(), first).status, "accepted");
    assert.equal(first.entries[0]?.status, "modified");
    assert.equal(first.entries[0]?.hunks[0]?.id, "-1,2 +1,2");
  });

  it("invariant:matrix-identity-isolation-058593064f42 keeps anchor resolution bound to its manifest identity", () => {
    const manifest = buildDiffManifest({ diff: modified, headSha: NEW });
    assert.equal(resolveRepositoryAnchor(anchor(), manifest, { currentHeadSha: NEW }).manifestIdentity, manifest.identity);
    assert.equal(resolveRepositoryAnchor(anchor(), manifest, { currentHeadSha: OLD }).status, "concurrent-head");
  });

  it("invariant:matrix-identity-isolation-32ce6cf921b4 keeps manifest identities deterministic across streams", () => {
    const left = buildDiffManifest({ diff: modified, headSha: NEW });
    const right = buildDiffManifest({ diff: modified, headSha: NEW });
    assert.equal(left.identity, right.identity);
    assert.notEqual(buildDiffManifest({ diff: modified, headSha: OLD }).identity, left.identity);
  });

  it("covers added files, side/range validation, and actionable stale evidence", () => {
    const manifest = buildDiffManifest({
      diff: `diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\nindex 0000000..${NEW}\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+export const added = true;\n`,
    });
    assert.equal(manifest.entries[0]?.status, "added");
    assert.equal(resolveRepositoryAnchor(anchor({ path: "src/new.ts" }), manifest).status, "accepted");
    assert.equal(resolveRepositoryAnchor(anchor({ blobSha: OLD }), manifest).status, "wrong-sha");
    assert.equal(resolveRepositoryAnchor(anchor({ path: "src/new.ts", side: "old", blobSha: OLD }), manifest).status, "impossible");
    assert.equal(resolveRepositoryAnchor(anchor({ range: { start: 20, end: 20 } }), manifest).status, "out-of-diff");
  });

  it("rejects traversal and classifies rename, deletion, binary, generated, omitted, and concurrent cases", () => {
    const cases: Array<[string, string, "rename" | "deletion" | "binary" | "generated" | "omitted-patch"]> = [
      ["rename", `diff --git a/src/old.ts b/src/new.ts\nsimilarity index 95%\nrename from src/old.ts\nrename to src/new.ts\n`, "rename"],
      ["deletion", `diff --git a/src/deleted.ts b/src/deleted.ts\ndeleted file mode 100644\nindex ${OLD}..0000000\n--- a/src/deleted.ts\n+++ /dev/null\n`, "deletion"],
      ["binary", `diff --git a/src/image.bin b/src/image.bin\nBinary files a/src/image.bin and b/src/image.bin differ\n`, "binary"],
      ["generated", `diff --git a/dist/out.js b/dist/out.js\nindex ${OLD}..${NEW}\n--- a/dist/out.js\n+++ b/dist/out.js\n@@ -1 +1 @@\n-old\n+new\n`, "generated"],
      ["omitted-patch", `diff --git a/src/omitted.ts b/src/omitted.ts\nindex ${OLD}..${NEW}\n`, "omitted-patch"],
    ];
    for (const [name, diff, status] of cases) {
      const manifest = buildDiffManifest({ diff, headSha: NEW });
      assert.equal(resolveRepositoryAnchor(anchor({ path: name === "rename" ? "src/new.ts" : name === "deletion" ? "src/deleted.ts" : name === "binary" ? "src/image.bin" : name === "generated" ? "dist/out.js" : "src/omitted.ts" }), manifest).status, status);
    }
    const traversal = buildDiffManifest({ diff: modified, headSha: NEW });
    assert.equal(resolveRepositoryAnchor(anchor({ path: "../src/a.ts" }), traversal).status, "traversal");
    assert.equal(resolveRepositoryAnchor(anchor(), traversal, { currentHeadSha: OLD }).status, "concurrent-head");
  });

  it("bounds manifest resources and diagnostics", () => {
    assert.throws(() => buildDiffManifest({ diff: modified, limits: { maxPatchBytes: 8 } }), /bounded manifest patch limit/);
    const manifest = buildDiffManifest({ diff: modified, limits: { maxDiagnosticBytes: 100 } });
    const result = resolveRepositoryAnchor(anchor({ path: "missing.ts" }), manifest);
    assert.equal(result.status, "out-of-diff");
    assert.ok(result.diagnostic.length <= 100);
  });
});
