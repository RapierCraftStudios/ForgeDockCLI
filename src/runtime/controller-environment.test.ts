// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { controllerEnvironment, isAgentTransportVariable, verificationEnvironment } from "./controller-environment.js";

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

  it("puts Git Bash ahead of ambiguous Windows bash launchers during verification", () => {
    const environment = verificationEnvironment({
      PROGRAMFILES: "C:\\Program Files",
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      PATH: "C:\\Windows\\System32;C:\\Windows",
    });
    if (process.platform === "win32") {
      assert.match(environment.PATH ?? "", /^C:\\Program Files\\Git\\usr\\bin;/i);
    }
  });

  it("classifies worker transport without stripping ordinary Pi model settings", () => {
    assert.equal(isAgentTransportVariable("PI_SUBAGENT_CHILD_AGENT"), true);
    assert.equal(isAgentTransportVariable("PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT"), true);
    assert.equal(isAgentTransportVariable("PI_PROVIDER"), false);
    assert.equal(isAgentTransportVariable("PI_MODEL"), false);
  });
});
