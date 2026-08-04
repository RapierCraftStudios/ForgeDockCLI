// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { controllerEnvironment, FORGEDOCK_VERIFICATION_PATH, isAgentTransportVariable, sealVerificationEnvironment, verificationEnvironment } from "./controller-environment.js";

describe("controller environment boundary", () => {
  it("removes inherited Pi subagent role and routing variables", () => {
    const environment = controllerEnvironment({
      PATH: "test-path",
      PI_PROVIDER: "openai-codex",
      PI_MODEL: "gpt-5.6-luna",
      PI_SUBAGENT_CHILD: "1",
      PI_SUBAGENT_CHILD_AGENT: "forgedock-issue-worker",
      PI_SUBAGENT_PARENT_SESSION: "parent",
      PI_SUBAGENT_CAPABILITY_CEILING_V1: "encoded",
      PI_SUBAGENTS_WORKTREE_DIR: "/tmp/worktrees",
      PI_INTERCOM_SESSION_ID: "intercom",
    }, {
      FORGEDOCK_NESTED_AGENT_URL: "http://127.0.0.1:1234/v1/run",
      FORGEDOCK_NESTED_AGENT_TOKEN: "token",
    });

    assert.equal(environment.PATH, "test-path");
    assert.equal(environment.PI_PROVIDER, "openai-codex");
    assert.equal(environment.PI_MODEL, "gpt-5.6-luna");
    assert.equal(environment.FORGEDOCK_NESTED_AGENT_URL, "http://127.0.0.1:1234/v1/run");
    assert.equal(environment.FORGEDOCK_NESTED_AGENT_TOKEN, "token");
    assert.equal(environment.PI_SUBAGENT_CHILD, undefined);
    assert.equal(environment.PI_SUBAGENT_CHILD_AGENT, undefined);
    assert.equal(environment.PI_SUBAGENT_PARENT_SESSION, undefined);
    assert.equal(environment.PI_SUBAGENT_CAPABILITY_CEILING_V1, undefined);
    assert.equal(environment.PI_SUBAGENTS_WORKTREE_DIR, undefined);
    assert.equal(environment.PI_INTERCOM_SESSION_ID, undefined);
  });

  it("puts discovered Git Bash and user tools ahead of ambiguous Windows launchers", () => {
    if (process.platform !== "win32") return;
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    assert.ok(systemRoot);
    const environment = verificationEnvironment({
      SystemRoot: systemRoot,
      USERPROFILE: homedir(),
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      PATH: join(systemRoot, "System32"),
    });
    const entries = (environment.PATH ?? "").split(delimiter);
    assert.ok(existsSync(join(entries[0] ?? "", "bash.exe")), `Git Bash was not discovered: ${environment.PATH}`);
    assert.equal(environment.FORGEDOCK_GIT_BASH, join(entries[0] ?? "", "bash.exe"));
    if (existsSync(join(homedir(), "bin"))) assert.ok(entries.includes(join(homedir(), "bin")));
  });

  it("reconstructs one sealed toolchain across a sparse-PATH verification descendant", () => {
    if (process.platform !== "win32") return;
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    assert.ok(systemRoot);
    const parent = sealVerificationEnvironment(process.env);
    let repeated = parent;
    for (let boundary = 0; boundary < 8; boundary++) repeated = sealVerificationEnvironment(repeated);
    assert.equal(repeated.PATH, parent.PATH, "sealing must be idempotent across process boundaries");
    const parentEntries = (parent.PATH ?? "").split(delimiter);
    assert.equal(new Set(parentEntries.map((entry) => entry.toLowerCase().replace(/[\\/]+$/, ""))).size, parentEntries.length);
    assert.ok(parentEntries.some((entry) => entry.toLowerCase().replace(/[\\/]+$/, "") === dirname(process.execPath).toLowerCase().replace(/[\\/]+$/, "")));
    const descendant = verificationEnvironment({ ...parent, PATH: join(systemRoot, "System32") });
    assert.ok(parent[FORGEDOCK_VERIFICATION_PATH]);
    assert.equal(descendant.FORGEDOCK_GIT_BASH, parent.FORGEDOCK_GIT_BASH);
    assert.equal((descendant.PATH ?? "").split(delimiter)[0], (parent.PATH ?? "").split(delimiter)[0]);
    const probe = spawnSync("bash", ["-c", "test -n \"$MSYSTEM\" && command -v mktemp && command -v jq"], {
      env: descendant, encoding: "utf8", windowsHide: true,
    });
    assert.equal(probe.status, 0, probe.stderr || probe.stdout || probe.error?.message);
  });

  it("classifies worker transport without stripping ordinary Pi model settings", () => {
    assert.equal(isAgentTransportVariable("PI_SUBAGENT_CHILD_AGENT"), true);
    assert.equal(isAgentTransportVariable("PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT"), true);
    assert.equal(isAgentTransportVariable("PI_PROVIDER"), false);
    assert.equal(isAgentTransportVariable("PI_MODEL"), false);
  });
});
