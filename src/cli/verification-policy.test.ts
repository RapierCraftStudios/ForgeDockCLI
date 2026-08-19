// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { selectPacketVerificationCommands } from "../workflows/work-on/prepare.js";
import { discoverLegacyVerificationCommands, discoverVerificationCommands } from "./verification-policy.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function writeTypeScriptConfig(repo: string, overrides: Record<string, unknown> = {}): void {
  writeFileSync(join(repo, "tsconfig.json"), JSON.stringify({
    compilerOptions: { rootDir: "src", outDir: "dist", ...overrides },
    include: ["src/**/*.ts"],
  }));
}

describe("verification policy discovery", () => {
  it("freezes scripts from the worktree base ref instead of dirty checkout files", () => {
    const repo = mkdtempSync(join(tmpdir(), "forgedock-policy-"));
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    git(repo, "config", "user.name", "ForgeDock Test");
    git(repo, "config", "user.email", "forgedock@example.invalid");
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    git(repo, "add", "package.json");
    git(repo, "commit", "-m", "base");
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { build: "tsc", test: "node --test" } }));

    const commands = discoverVerificationCommands(repo, "HEAD");
    assert.deepEqual(commands.map(({ id }) => id), ["diff-check"]);
    assert.equal(commands[0]?.selection, "always");
  });

  it("keeps broad lint and documentation scripts out of ordinary issue execution", () => {
    const repo = mkdtempSync(join(tmpdir(), "forgedock-policy-docs-"));
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    git(repo, "config", "user.name", "ForgeDock Test");
    git(repo, "config", "user.email", "forgedock@example.invalid");
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      scripts: { lint: "eslint .", build: "tsc", "docs:build": "vitepress build", test: "node --test" },
    }));
    writeTypeScriptConfig(repo);
    git(repo, "add", "package.json", "tsconfig.json");
    git(repo, "commit", "-m", "base");

    assert.deepEqual(discoverVerificationCommands(repo, "HEAD").map(({ id }) => id), [
      "diff-check", "build", "test",
    ]);
    const legacy = discoverLegacyVerificationCommands(repo, "HEAD");
    assert.deepEqual(legacy.map(({ id }) => id), ["diff-check", "lint", "build", "docs:build", "test"]);
    assert.deepEqual(legacy.find(({ id }) => id === "test")?.args.slice(-1), ["test"]);
    const legacyResume = selectPacketVerificationCommands({
      expectedPaths: ["src/feature.ts"],
      verificationRequirements: [{ kind: "command", id: "test", criterionIds: ["criterion-1"], rationale: "old typed packet" }],
    }, legacy, "c".repeat(40));
    assert.deepEqual(legacyResume.map(({ id }) => id), ["diff-check", "test"]);
  });

  it("never infers nested command coverage from package-script prose", () => {
    const repo = mkdtempSync(join(tmpdir(), "forgedock-policy-nested-"));
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    git(repo, "config", "user.name", "ForgeDock Test");
    git(repo, "config", "user.email", "forgedock@example.invalid");
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      scripts: { build: "tsc -p tsconfig.json", test: "echo npm run build && node --test" },
    }));
    writeTypeScriptConfig(repo);
    git(repo, "add", "package.json", "tsconfig.json");
    git(repo, "commit", "-m", "base");
    const commands = discoverVerificationCommands(repo, "HEAD");
    assert.equal(commands.find(({ id }) => id === "build")?.coveredBy, undefined);
    assert.equal(commands.find(({ id }) => id === "test")?.coveredBy, undefined);
  });

  it("materializes only packet-selected targeted tests plus cheap and compile integrity", () => {
    const repo = mkdtempSync(join(tmpdir(), "forgedock-policy-targeted-"));
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    git(repo, "config", "user.name", "ForgeDock Test");
    git(repo, "config", "user.email", "forgedock@example.invalid");
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      scripts: {
        build: "tsc -p tsconfig.json",
        "test:next": "node --test dist/**/*.test.js",
        test: "npm run build && npm run test:next",
        "docs:build": "vitepress build",
      },
    }));
    writeTypeScriptConfig(repo);
    git(repo, "add", "package.json", "tsconfig.json");
    git(repo, "commit", "-m", "base");

    const catalog = discoverVerificationCommands(repo, "HEAD");
    const plan = selectPacketVerificationCommands({
      expectedPaths: ["src/feature.ts", "src/feature.test.ts"],
      verificationRequirements: [{
        kind: "command", id: "test", criterionIds: ["criterion-1"], rationale: "Targeted regression",
      }],
    }, catalog, "a".repeat(40));
    assert.deepEqual(plan.map(({ id }) => id), ["diff-check", "build", "test"]);
    assert.equal(plan.find(({ id }) => id === "build")?.command, process.execPath);
    assert.deepEqual(plan.find(({ id }) => id === "build")?.args, [
      "node_modules/typescript/bin/tsc", "-p", "tsconfig.json", "--outDir", ".forgedock/verification-dist",
    ]);
    assert.deepEqual(plan.find(({ id }) => id === "test")?.targets, [".forgedock/verification-dist/feature.test.js"]);
    assert.deepEqual(plan.find(({ id }) => id === "test")?.args.slice(-1), [".forgedock/verification-dist/feature.test.js"]);
    assert.equal(plan.some(({ id }) => id === "docs:build" || id === "lint"), false);
    assert.ok(plan.every(({ policyVersion, planId }) => policyVersion === "forgedock.verification/v2" && Boolean(planId)));
  });

  it("rejects unknown packet commands and unsafe targeted broadening", () => {
    const catalog = [{
      id: "diff-check", command: "git", args: ["diff", "--check"], timeoutMs: 1_000, required: true,
      selection: "always" as const, lockScope: "workspace" as const,
    }, {
      id: "test", command: process.execPath, args: ["--test"], timeoutMs: 1_000, required: true,
      selection: "packet" as const, targeting: "expected-test-paths" as const, lockScope: "workspace" as const,
      typescriptLayout: { sourceRoot: "src", outputRoot: ".forgedock/verification-dist", project: "tsconfig.json", configDigest: "fixture" },
    }];
    assert.throws(() => selectPacketVerificationCommands({
      expectedPaths: ["src/a.test.ts"],
      verificationRequirements: [{ kind: "command", id: "full-suite", criterionIds: ["criterion-1"], rationale: "broad" }],
    }, catalog, "b".repeat(40)), /unavailable verification command/);
    assert.throws(() => selectPacketVerificationCommands({
      expectedPaths: Array.from({ length: 33 }, (_, index) => `src/case-${index}.test.ts`),
      verificationRequirements: [{ kind: "command", id: "test", criterionIds: ["criterion-1"], rationale: "too broad" }],
    }, catalog, "b".repeat(40)), /bounded to 32/);
  });
});
