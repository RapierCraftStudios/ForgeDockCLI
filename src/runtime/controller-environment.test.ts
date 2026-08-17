// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
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

  it("removes controller credentials and isolates verification config homes", () => {
    const controllerHome = "C:/controller/home";
    const environment = verificationEnvironment({
      PATH: process.env.PATH,
      HOME: controllerHome,
      USERPROFILE: controllerHome,
      AUDIT_SECRET: "fd-secret-proof",
      GH_TOKEN: "github-token",
      GITHUB_PAT: "github-pat",
      PIP_INDEX_URL: "https://user:password@example.test/simple",
      DOCKER_AUTH_CONFIG: '{"auths":{"registry.example":{"auth":"proof"}}}',
      DOCKER_CONFIG: "C:/controller/docker",
      GIT_ASKPASS: "C:/controller/askpass.exe",
      NPM_CONFIG_GLOBALCONFIG: "C:/controller/npmrc",
      NODE_OPTIONS: "--require=C:/controller/loader.js",
      BASH_ENV: "C:/controller/bash-env.sh",
      OPENAI_API_KEY: "provider-key",
      FORGEDOCK_NESTED_AGENT_TOKEN: "nested-token",
      SAFE_FLAG: "visible",
    });
    assert.equal(environment.AUDIT_SECRET, undefined);
    assert.equal(environment.GH_TOKEN, undefined);
    assert.equal(environment.GITHUB_PAT, undefined);
    assert.equal(environment.PIP_INDEX_URL, undefined);
    assert.equal(environment.DOCKER_AUTH_CONFIG, undefined);
    assert.notEqual(environment.DOCKER_CONFIG, "C:/controller/docker");
    assert.ok(environment.DOCKER_CONFIG?.startsWith(environment.HOME ?? ""));
    assert.equal(environment.GIT_ASKPASS, undefined);
    assert.equal(environment.NPM_CONFIG_GLOBALCONFIG, undefined);
    assert.equal(environment.NODE_OPTIONS, undefined);
    assert.equal(environment.BASH_ENV, undefined);
    assert.equal(environment.OPENAI_API_KEY, undefined);
    assert.equal(environment.FORGEDOCK_NESTED_AGENT_TOKEN, undefined);
    assert.equal(environment.SAFE_FLAG, "visible");
    assert.notEqual(environment.HOME, controllerHome);
    assert.equal(environment.HOME, environment.USERPROFILE);
    assert.ok(environment.NPM_CONFIG_USERCONFIG?.startsWith(environment.HOME ?? ""));
    assert.ok(environment.GIT_CONFIG_GLOBAL?.startsWith(environment.HOME ?? ""));
    const identity = spawnSync("git", ["config", "--global", "--get", "user.email"], {
      env: environment, encoding: "utf8", windowsHide: true,
    });
    assert.equal(identity.status, 0, identity.stderr || identity.error?.message);
    assert.equal(identity.stdout.trim(), "verification@forgedock.invalid");
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
    assert.equal(environment.MSYSTEM, "MINGW64", "cmd/PowerShell launches receive the Git-for-Windows identity marker");
    if (existsSync(join(homedir(), "bin"))) assert.ok(entries.includes(join(homedir(), "bin")));
  });

  it("reconstructs one sealed toolchain across a sparse-PATH Unix descendant", () => {
    if (process.platform === "win32") return;
    const sealedEntry = dirname(process.execPath);
    const inheritedEntry = join(tmpdir(), `forgedock-inherited-path-${process.pid}`);
    const source: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: [sealedEntry, inheritedEntry].join(delimiter),
    };
    for (const name of Object.keys(source)) {
      if (name.toLowerCase() === FORGEDOCK_VERIFICATION_PATH.toLowerCase()) delete source[name];
    }
    const parent = sealVerificationEnvironment(source);
    let repeated = parent;
    for (let boundary = 0; boundary < 8; boundary++) repeated = sealVerificationEnvironment(repeated);
    assert.equal(repeated.PATH, parent.PATH, "sealing must be idempotent across process boundaries");
    assert.equal(repeated[FORGEDOCK_VERIFICATION_PATH], parent[FORGEDOCK_VERIFICATION_PATH]);
    const sealedPath = parent[FORGEDOCK_VERIFICATION_PATH];
    assert.ok(sealedPath);
    assert.equal(parent.PATH, sealedPath);
    const parentEntries = (parent.PATH ?? "").split(delimiter);
    assert.deepEqual(parentEntries, [sealedEntry, inheritedEntry]);
    assert.equal(new Set(parentEntries).size, parentEntries.length);

    const sparseEntry = join(tmpdir(), `forgedock-sparse-path-${process.pid}`);
    const sparsePath = [sparseEntry, sparseEntry].join(delimiter);
    const descendant = verificationEnvironment({ ...parent, PATH: sparsePath });
    const descendantEntries = (descendant.PATH ?? "").split(delimiter);
    assert.equal(descendant[FORGEDOCK_VERIFICATION_PATH], sealedPath);
    assert.deepEqual(descendantEntries.slice(0, parentEntries.length), parentEntries);
    assert.deepEqual(descendantEntries.slice(parentEntries.length), [sparseEntry]);
    assert.equal(new Set(descendantEntries).size, descendantEntries.length);
    assert.equal(descendant.PATH, [...parentEntries, sparseEntry].join(delimiter));

    const resealed = sealVerificationEnvironment({ ...parent, PATH: sparsePath });
    assert.equal(resealed.PATH, parent.PATH, "re-sealing must retain the valid sealed PATH");
    assert.equal(resealed[FORGEDOCK_VERIFICATION_PATH], sealedPath);

    const probe = spawnSync(basename(process.execPath), ["-e", "process.stdout.write('sealed-node')"], {
      env: descendant, encoding: "utf8", windowsHide: true,
    });
    assert.equal(probe.status, 0, probe.stderr || probe.error?.message);
    assert.equal(probe.stdout, "sealed-node");
  });

  it("preserves a supplied PATH when no Unix sealed manifest exists", () => {
    if (process.platform === "win32") return;
    const suppliedPath = [
      join(tmpdir(), `forgedock-no-manifest-a-${process.pid}`),
      join(tmpdir(), `forgedock-no-manifest-b-${process.pid}`),
    ].join(delimiter);
    const source: NodeJS.ProcessEnv = { ...process.env, PATH: suppliedPath };
    for (const name of Object.keys(source)) {
      if (name.toLowerCase() === FORGEDOCK_VERIFICATION_PATH.toLowerCase()) delete source[name];
    }
    const environment = verificationEnvironment(source);
    assert.equal(environment.PATH, suppliedPath);
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
    assert.equal(isAgentTransportVariable("pi_subagent_child_agent"), true);
    assert.equal(isAgentTransportVariable("Pi_Subagents_Worktree_Dir"), true);
    assert.equal(isAgentTransportVariable("pi_intercom_session_id"), true);
    assert.equal(isAgentTransportVariable("PI_PROVIDER"), false);
    assert.equal(isAgentTransportVariable("PI_MODEL"), false);
  });

  it("removes case-varied transport keys while retaining ordinary Pi settings", () => {
    const environment = controllerEnvironment({
      pi_subagent_child_agent: "forgedock-reviewer",
      Pi_Subagents_Worktree_Dir: "C:/worker",
      pi_intercom_session_id: "intercom",
      PI_PROVIDER: "openai-codex",
      PI_MODEL: "gpt-test",
    });
    assert.equal(environment.pi_subagent_child_agent, undefined);
    assert.equal(environment.Pi_Subagents_Worktree_Dir, undefined);
    assert.equal(environment.pi_intercom_session_id, undefined);
    assert.equal(environment.PI_PROVIDER, "openai-codex");
    assert.equal(environment.PI_MODEL, "gpt-test");
  });
});
