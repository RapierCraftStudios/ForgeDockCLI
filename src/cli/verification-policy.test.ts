// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { discoverVerificationCommands } from "./verification-policy.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
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
    assert.equal(commands.length, 1);
    assert.deepEqual(commands[0]?.args.slice(-1), ["test"]);
  });
});
