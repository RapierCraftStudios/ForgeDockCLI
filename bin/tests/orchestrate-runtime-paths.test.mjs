import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const phase4 = readFileSync(
  new URL("../../commands/orchestrate/phase-4-execution.md", import.meta.url),
  "utf8",
);
const phase3 = readFileSync(
  new URL("../../commands/orchestrate/phase-3-dependency.md", import.meta.url),
  "utf8",
);
const issue = readFileSync(new URL("../../commands/issue.md", import.meta.url), "utf8");
const opencodeDocs = readFileSync(
  new URL("../../docs/OPENCODE.md", import.meta.url),
  "utf8",
);
const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

describe("orchestrate runtime helper paths", () => {
  it("resolves lane classification without replacing Claude support", () => {
    assert.match(phase4, /resolve_classify_lane\(\)/);
    assert.match(phase4, /\$HOME\/\.claude\/scripts\/classify-lane\.sh/);
    assert.match(phase4, /\$HOME\/\.opencode\/scripts\/classify-lane\.sh/);
    assert.match(phase4, /\$REPO_PATH\/scripts\/classify-lane\.sh/);
    assert.match(phase4, /CLASSIFY_LANE_SCRIPT=\$\(resolve_classify_lane\)/);
    assert.doesNotMatch(
      phase4,
      /bash ~\/\.claude\/scripts\/classify-lane\.sh/,
    );
  });

  it("uses the resolver for every lane-classification call site", () => {
    const directCalls = phase4.match(/classify-lane\.sh/g) ?? [];
    const resolverCalls = phase4.match(/bash "\$CLASSIFY_LANE_SCRIPT"/g) ?? [];
    assert.equal(resolverCalls.length, 3);
    assert.ok(directCalls.length >= resolverCalls.length);
  });

  it("requires mktemp paths and rejects root-level temp files", () => {
    for (const spec of [phase4, issue]) {
      assert.match(spec, /BODY_FILE="\$\(mktemp\)"/);
      assert.match(spec, /never hand-roll (?:a )?(?:temp )?path/i);
      assert.match(spec, /\/tmp_invbody_31076\.txt/);
      assert.match(spec, /bypass mode cannot clear/i);
      assert.match(spec, /\/tmp\/body\.md/);
    }
  });

  it("documents OpenCode helper and worktree locations", () => {
    assert.match(opencodeDocs, /FORGE_RUNTIME=opencode/);
    assert.match(opencodeDocs, /\.opencode\/worktrees/);
    assert.match(opencodeDocs, /~\/\.opencode\/scripts/);
    assert.match(opencodeDocs, /Claude keeps its existing engine/);
    assert.match(opencodeDocs, /does not add or modify user-owned OpenCode settings/);
    assert.match(opencodeDocs, /install and uninstall may rewrite `opencode\.json`\s+only/);
    assert.match(opencodeDocs, /migration does not\s+rewrite `opencode\.jsonc`/);
    assert.match(opencodeDocs, /customized commands are\s+preserved/);
  });

  it("keeps README OpenCode install guidance aligned with migration ownership", () => {
    assert.match(
      readme,
      /without changing your provider\s+or user-owned settings\.\s+When migrating an older ForgeDock adapter, it removes\s+only exact ForgeDock-managed legacy entries from `opencode\.json`:/,
    );
    assert.doesNotMatch(readme, /without changing your provider\s+or `opencode\.json`/);
  });

  it("documents event-driven OpenCode DAG dispatch", () => {
    assert.match(phase3, /OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS/);
    assert.match(phase3, /task\(\.\.\., background=true\)/);
    assert.match(phase3, /each injected task-result event/i);
    assert.match(phase4, /OPENCODE_DISPATCH_MAP/);
    assert.match(phase4, /task-result event/i);
    assert.match(phase4, /state="running"/);
    assert.match(phase4, /background=true/);
    assert.match(phase4, /do not wait for the slowest sibling/i);
  });
});
