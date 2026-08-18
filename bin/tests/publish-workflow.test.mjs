// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflow = readFileSync(join(root, ".github", "workflows", "publish.yml"), "utf8");
const pushPathsStart = workflow.indexOf("  push:\n");
const pushPathsEnd = workflow.indexOf("  workflow_dispatch:", pushPathsStart);
const pushPaths = workflow.slice(pushPathsStart, pushPathsEnd);
const changedGuardStart = workflow.indexOf("CHANGED=$(git diff --name-only");
const changedGuardEnd = workflow.indexOf('\n            if [ -z "$CHANGED" ]', changedGuardStart);
const changedPathGuard = workflow.slice(changedGuardStart, changedGuardEnd);

function stepBlock(name) {
  const startMarker = `      - name: ${name}`;
  const start = workflow.indexOf(startMarker);
  assert.notEqual(start, -1, `workflow should contain the '${name}' step`);
  const end = workflow.indexOf("\n      - name: ", start + startMarker.length);
  return workflow.slice(start, end === -1 ? workflow.length : end);
}

describe("npm publish workflow recovery", () => {
  it("preserves the publish path guards and serialized publish policy", () => {
    assert.notEqual(pushPathsStart, -1);
    assert.notEqual(pushPathsEnd, -1);
    assert.notEqual(changedGuardStart, -1);
    assert.notEqual(changedGuardEnd, -1);

    for (const path of ["src/**", "vendor/pi", "vendor/pi/**", "vendor/pi-runtime", "vendor/pi-runtime/**"]) {
      assert.ok(pushPaths.includes(`'${path}'`), `push.paths should include '${path}'`);
    }
    for (const path of ["src/", "'vendor/pi'", "'vendor/pi/**'", "'vendor/pi-runtime'", "'vendor/pi-runtime/**'"]) {
      assert.ok(changedPathGuard.includes(path), `changed-path guard should include ${path}`);
    }
    assert.doesNotMatch(changedPathGuard, /\.github\/workflows\/publish\.yml/);
    assert.match(workflow, /concurrency:\n  group: publish-main\n  cancel-in-progress: false/);
  });

  it("queries both exact registry versions and fails closed on uncertain responses", () => {
    const bump = stepBlock("Bump version");

    assert.match(bump, /query_registry_version[\s\\\n]+"forgedockcli@\$NEXT_VERSION"/);
    assert.match(bump, /"https:\/\/registry\.npmjs\.org"/);
    assert.match(bump, /query_registry_version[\s\\\n]+"@rapiercraftstudios\/forgedockcli@\$NEXT_VERSION"/);
    assert.match(bump, /"https:\/\/npm\.pkg\.github\.com"/);
    assert.match(bump, /GITHUB_PACKAGES_NPMRC=.*forgedock-github-packages\.npmrc/);
    assert.match(bump, /_authToken=\$\{GH_TOKEN\}/);
    assert.match(bump, /@rapiercraftstudios:registry=https:\/\/npm\.pkg\.github\.com/);
    assert.match(bump, /npm_args=\(show "\$package_spec" version "--registry=\$registry"\)/);
    assert.doesNotMatch(bump, /npm_args=.*--silent/);
    assert.match(bump, /npm_args\+=\(--userconfig "\$userconfig"\)/);
    assert.match(bump, /if \[ "\$output" = "\$NEXT_VERSION" \]/);
    assert.match(bump, /Ambiguous .*refusing to publish or finalize/);
    assert.match(bump, /E404\|404\[\[:space:\]\]\+Not Found\|is not in this registry/);
    assert.match(bump, /without an explicit not-found response; refusing to publish or finalize/);
    assert.match(bump, /return 1/);
    assert.match(bump, /NPM_ALREADY_PUBLISHED=\$\(query_registry_version/);
    assert.match(bump, /GITHUB_PACKAGES_ALREADY_PUBLISHED=\$\(query_registry_version/);
    assert.match(bump, /npm version "\$NEXT_VERSION" --no-git-tag-version --allow-same-version/);
    assert.match(bump, /echo "VERSION=\$NEXT_VERSION" >> "\$GITHUB_ENV"/);
    assert.doesNotMatch(bump, /npm show forgedockcli@"\$NEXT_VERSION" version --silent 2>\/dev\/null/);
  });

  it("implements the independent four-state publication matrix", () => {
    const npmPublish = stepBlock("Publish to npm (OIDC trusted publishing)");
    const savePackage = stepBlock("Save package.json before name mutation");
    const githubPublish = stepBlock("Publish to GitHub Packages");

    assert.match(npmPublish, /if: env\.SKIP_PUBLISH != 'true' && env\.NPM_ALREADY_PUBLISHED != 'true'/);
    assert.doesNotMatch(npmPublish, /GITHUB_PACKAGES_ALREADY_PUBLISHED/);
    assert.match(npmPublish, /npm publish --provenance --access public/);
    assert.match(npmPublish, /NPM_ALREADY_PUBLISHED=true/);

    assert.match(savePackage, /if: env\.SKIP_PUBLISH != 'true' && env\.GITHUB_PACKAGES_ALREADY_PUBLISHED != 'true'/);
    assert.doesNotMatch(savePackage, /NPM_ALREADY_PUBLISHED/);
    assert.match(githubPublish, /if: env\.SKIP_PUBLISH != 'true' && env\.GITHUB_PACKAGES_ALREADY_PUBLISHED != 'true'/);
    assert.doesNotMatch(githubPublish, /NPM_ALREADY_PUBLISHED/);
    assert.match(githubPublish, /npm pkg set name="@rapiercraftstudios\/forgedockcli"/);
    assert.match(githubPublish, /npm publish --access public --userconfig "\$NPMRC"/);
    assert.match(githubPublish, /GITHUB_PACKAGES_ALREADY_PUBLISHED=true/);
    assert.match(githubPublish, /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);

    const matrix = [
      { npm: true, githubPackages: true, npmPublishes: false, githubPublishes: false },
      { npm: true, githubPackages: false, npmPublishes: false, githubPublishes: true },
      { npm: false, githubPackages: true, npmPublishes: true, githubPublishes: false },
      { npm: false, githubPackages: false, npmPublishes: true, githubPublishes: true },
    ];
    for (const state of matrix) {
      assert.equal(state.npmPublishes, !state.npm, `npm matrix state is wrong for ${JSON.stringify(state)}`);
      assert.equal(
        state.githubPublishes,
        !state.githubPackages,
        `GitHub Packages matrix state is wrong for ${JSON.stringify(state)}`,
      );
    }
    assert.match(workflow, /neither present publishes both/);
    assert.match(workflow, /npm-present\/GitHub-absent retries only/);
    assert.match(workflow, /npm-absent\/GitHub-present publishes only npm/);
    assert.match(workflow, /present skips both/);

    assert.ok(workflow.indexOf(npmPublish) < workflow.indexOf(savePackage));
    assert.ok(workflow.indexOf(savePackage) < workflow.indexOf(githubPublish));
    assert.doesNotMatch(npmPublish, /always\(\)/);
    assert.doesNotMatch(githubPublish, /always\(\)/);
  });

  it("retries only the missing GitHub Packages publication after a partial run", () => {
    const savePackage = stepBlock("Save package.json before name mutation");
    const githubPublish = stepBlock("Publish to GitHub Packages");
    const restorePackage = stepBlock("Restore package.json name");

    assert.match(savePackage, /GITHUB_PACKAGES_ATTEMPTED=true/);
    assert.match(restorePackage, /if: always\(\) && env\.SKIP_PUBLISH != 'true' && env\.GITHUB_PACKAGES_ATTEMPTED == 'true'/);
    assert.doesNotMatch(restorePackage, /NPM_ALREADY_PUBLISHED/);
    assert.match(restorePackage, /mv package\.json\.orig package\.json/);
    assert.ok(workflow.indexOf(githubPublish) < workflow.indexOf(restorePackage));
    assert.match(githubPublish, /npm publish --access public --userconfig "\$NPMRC"[\s\S]*GITHUB_PACKAGES_ALREADY_PUBLISHED=true/);
    assert.match(workflow, /publish command is cancelled or fails halfway through/);
    assert.doesNotMatch(workflow, /REGISTRY_ALREADY_PUBLISHED/);
  });

  it("blocks metadata and release finalization behind both registries and restored package name", () => {
    const restorePackage = stepBlock("Restore package.json name");
    const verify = stepBlock("Verify registry reconciliation");
    const finalizationSteps = [
      stepBlock("Sync plugin.json version"),
      stepBlock("Push version bump"),
      stepBlock("Create GitHub Release"),
    ];

    assert.ok(workflow.indexOf(restorePackage) < workflow.indexOf(verify));
    assert.match(verify, /if: env\.SKIP_PUBLISH != 'true'/);
    assert.doesNotMatch(verify, /always\(\)/);
    assert.match(verify, /NPM_ALREADY_PUBLISHED:-false/);
    assert.match(verify, /GITHUB_PACKAGES_ALREADY_PUBLISHED:-false/);
    assert.match(verify, /Both registries must be reconciled before finalization/);
    assert.match(verify, /PACKAGE_NAME=.*require\('\.\/package\.json'\)\.name/);
    assert.match(verify, /\[ "\$PACKAGE_NAME" != "forgedockcli" \]/);
    assert.match(verify, /REGISTRIES_RECONCILED=true/);

    for (const finalization of finalizationSteps) {
      assert.match(finalization, /if: env\.SKIP_PUBLISH != 'true' && env\.REGISTRIES_RECONCILED == 'true'/);
      assert.doesNotMatch(finalization, /always\(\)/);
      assert.ok(workflow.indexOf(verify) < workflow.indexOf(finalization));
    }
  });

  it("retains the version metadata rebase and retry contract", () => {
    const pushVersion = stepBlock("Push version bump");
    assert.match(pushVersion, /git add package\.json package-lock\.json \.claude-plugin\/plugin\.json/);
    assert.match(pushVersion, /for attempt in 1 2 3/);
    assert.match(pushVersion, /git rebase origin\/main/);
    assert.match(pushVersion, /git push origin HEAD:main/);
    assert.match(pushVersion, /npm test/);
  });
});
