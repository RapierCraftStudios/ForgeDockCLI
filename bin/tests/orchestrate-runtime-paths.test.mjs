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

  it("resolves affected-file extraction from ForgeDock before the target repo", () => {
    assert.match(phase3, /resolve_extract_affected_files\(\)/);
    assert.match(phase3, /\$FORGE_HOME\/scripts\/extract-affected-files\.sh/);
    assert.match(phase3, /\$REPO_PATH\/scripts\/extract-affected-files\.sh/);
    assert.match(phase3, /AFFECTED_FILES_SCRIPT=\$\(resolve_extract_affected_files\)/);
    assert.match(phase3, /bash "\$AFFECTED_FILES_SCRIPT"/);
    assert.match(phase3, /FILE_SOURCE\[\$NUM\].*=.*error/);
    assert.match(phase3, /affected-file extraction for #\$NUM was inconclusive/);
    assert.doesNotMatch(phase3, /bash scripts\/extract-affected-files\.sh/);
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
    assert.match(phase4, /FORGE:DISPATCH/);
    assert.match(phase4, /child_session_id/);
    assert.match(phase4, /fresh OpenCode `task\(background=true\)` continuation/);
    assert.doesNotMatch(phase4, /task\(task_id=.*background=true\)/);
    assert.match(phase4, /do not wait for the slowest sibling/i);
  });

  it("re-reads durable claims before dispatch and pairs release comments by holder", () => {
    assert.match(phase4, /read_active_claims\(\)/);
    assert.match(phase4, /gh api --paginate --slurp/);
    assert.match(phase4, /select\(\.created_at > \$claim\.created_at\)/);
    assert.match(phase4, /capture\("\\\\\*\\\\\*Holder/);
    assert.match(phase4, /claim_conflicts_with_live_holder/);
    assert.match(phase4, /before each engine Bash, Agent\(\), or OpenCode task call/);
    assert.match(phase3, /Rebuild the durable file-claim map/);
    assert.match(phase3, /ACTIVE_CLAIM_FILES/);
  });

  it("documents the compact OpenCode preflight", () => {
    const orchestrate = readFileSync(
      new URL("../../commands/orchestrate.md", import.meta.url),
      "utf8",
    );
    assert.match(orchestrate, /orchestrate-preflight\.mjs/);
    assert.match(orchestrate, /do not load the full\s+Phase 3 or Phase 4 prose just\s+to ask that\s+question/i);
  });
});
