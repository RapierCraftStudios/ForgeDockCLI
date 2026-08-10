// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflow = readFileSync(join(root, ".github", "workflows", "publish.yml"), "utf8");

const pushPathsStart = workflow.indexOf("  push:");
const pushPathsEnd = workflow.indexOf("  workflow_dispatch:", pushPathsStart);
const pushPaths = workflow.slice(pushPathsStart, pushPathsEnd);
const changedPathGuardStart = workflow.indexOf("- name: Check if publishable files changed");
const changedPathGuardEnd = workflow.indexOf("- name: Use Node.js 24", changedPathGuardStart);
const changedPathGuard = workflow.slice(changedPathGuardStart, changedPathGuardEnd);

describe("npm publish workflow recovery", () => {
  it("reconciles repository versions when npm publication already succeeded", () => {
    assert.match(workflow, /REGISTRY_ALREADY_PUBLISHED=true/);
    assert.match(workflow, /npm version "\$NEXT_VERSION" --no-git-tag-version --allow-same-version/);
    const recovery = workflow.slice(workflow.indexOf('if npm show forgedock@"$NEXT_VERSION"'), workflow.indexOf("- name: Publish to npm"));
    assert.doesNotMatch(recovery, /SKIP_PUBLISH=true/);
  });

  it("does not publish an already-existing registry version again", () => {
    assert.match(workflow, /name: Publish to npm[\s\S]*?if: env\.SKIP_PUBLISH != 'true' && env\.REGISTRY_ALREADY_PUBLISHED != 'true'/);
    assert.match(workflow, /name: Publish to GitHub Packages[\s\S]*?if: env\.SKIP_PUBLISH != 'true' && env\.REGISTRY_ALREADY_PUBLISHED != 'true'/);
  });

  it("rebases and retries the complete version metadata update", () => {
    assert.match(workflow, /git add package\.json package-lock\.json \.claude-plugin\/plugin\.json/);
    assert.match(workflow, /for attempt in 1 2 3/);
    assert.match(workflow, /git rebase origin\/main/);
    assert.match(workflow, /git push origin HEAD:main/);
    assert.match(workflow, /npm test/);
  });

  it("keeps Pi vendor trees publishable in both path contracts", () => {
    for (const path of ["vendor/pi", "vendor/pi/**", "vendor/pi-runtime/**"]) {
      assert.ok(pushPaths.includes(`'${path}'`), `push paths must include ${path}`);
    }
    for (const path of ["vendor/pi", "vendor/pi/", "vendor/pi-runtime/"]) {
      assert.ok(changedPathGuard.includes(` ${path} `), `changed-path guard must include ${path}`);
    }
  });
});
