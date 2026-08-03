// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { appendProjectPreference, loadForgeGuidance, recordProjectDecision } from "../config/project-memory.js";
import { searchDevdocsMemory } from "./devdocs-memory.js";

describe("token-bounded ForgeDock project memory", () => {
  it("persists explicit preferences in FORGE.md and loads them as guidance", () => {
    const cwd = mkdtempSync(join(tmpdir(), "forgedock-memory-"));
    try {
      assert.equal(appendProjectPreference(cwd, "Prefer focused verification before broad suites.").added, true);
      assert.equal(appendProjectPreference(cwd, "Prefer focused verification before broad suites.").added, false);
      const guidance = loadForgeGuidance(cwd);
      assert.equal(guidance.length, 1);
      assert.match(guidance[0]?.content ?? "", /focused verification/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("retrieves compact anchored notes with wiki-link backlinks as reference evidence", () => {
    const cwd = mkdtempSync(join(tmpdir(), "forgedock-memory-"));
    try {
      const decisions = join(cwd, "devdocs", "decisions");
      mkdirSync(decisions, { recursive: true });
      writeFileSync(join(decisions, "auth.md"), "---\ntags: [security, auth]\nanchor: src/auth\n---\n# Auth boundary\nUse a single token boundary. See [[decisions/session]].\n");
      writeFileSync(join(decisions, "session.md"), "# Session storage\nSession state remains replaceable.\n");
      const hits = searchDevdocsMemory({ cwd, query: "security token", paths: ["src/auth/login.ts"], maxChars: 500 });
      assert.equal(hits[0]?.path, "decisions/auth.md");
      assert.ok((hits[0]?.score ?? 0) >= 20);
      const session = searchDevdocsMemory({ cwd, query: "session storage" }).find((hit) => hit.path === "decisions/session.md");
      assert.deepEqual(session?.backlinks, ["decisions/auth.md"]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("records Obsidian-compatible decision notes under devdocs", () => {
    const cwd = mkdtempSync(join(tmpdir(), "forgedock-memory-"));
    try {
      const result = recordProjectDecision({ cwd, title: "Keep memory referential", context: "Agents need history.", decision: "Memory cannot authorize actions.", consequences: ["Intent remains authoritative."] });
      assert.match(readFileSync(result.path, "utf8"), /Memory cannot authorize actions/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
