// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { materializeWorkerAgent } from "./worker-agent.js";

const entry = "bin/forgedock-terminal.mjs";

describe("ForgeDock Pi terminal launcher", () => {
  it("runs the branded fork", () => {
    const result = spawnSync(process.execPath, [entry, "--version"], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^0\.83\.0/m);
  });

  it("presents ForgeDock rather than Pi as the CLI", () => {
    const result = spawnSync(process.execPath, [entry, "--help"], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^forgedock - provider-neutral software delivery terminal/m);
    assert.match(result.stdout, /forgedock \[options\]/);
  });

  it("bootstraps forge.yaml through the parent terminal launcher", () => {
    const launcher = readFileSync(entry, "utf8");
    assert.match(launcher, /ensureForgeDockConfig\(process\.cwd\(\)\)/);
    assert.match(launcher, /shouldBootstrapProject\(cliArgs\)/);

    const cwd = mkdtempSync(join(tmpdir(), "forgedock-launch-config-"));
    try {
      const result = spawnSync(process.execPath, [resolve(entry), "--list-models"], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, PI_OFFLINE: "1" },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(readFileSync(join(cwd, "forge.yaml"), "utf8"), /FORGEDOCK:NEXT-CONFIG:START/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("discovers and propagates Git Bash before starting the Pi terminal", () => {
    const launcher = readFileSync(entry, "utf8");
    assert.match(launcher, /discoveredEnvironment = verificationEnvironment\(process\.env\)/);
    assert.match(launcher, /process\.env\.PATH = discoveredEnvironment\.PATH/);
    assert.match(launcher, /process\.env\.FORGEDOCK_GIT_BASH = discoveredEnvironment\.FORGEDOCK_GIT_BASH/);
  });

  it("ships and invokes the GitHub App refresher without a bash path boundary", () => {
    const launcher = readFileSync(entry, "utf8");
    const packageManifest = JSON.parse(readFileSync("package.json", "utf8")) as { files?: string[] };
    assert.equal(existsSync("scripts/refresh-bot-token.mjs"), true);
    assert.ok(packageManifest.files?.includes("scripts/"));
    assert.equal(packageManifest.files?.includes("!scripts/refresh-bot-token.mjs"), false);
    assert.match(launcher, /refresh-bot-token\.mjs/);
    assert.match(launcher, /spawnSync\(process\.execPath, \[refreshScript/);
    assert.doesNotMatch(launcher, /spawnSync\("bash", \[refreshScript/);
  });

  it("gives issue workers an absolute child-only ForgeDock extension", () => {
    const extension = resolve("dist/tui/forgedock-extension.js");
    const reviewer = resolve("agents/forgedock-reviewer.md");
    const agent = materializeWorkerAgent(resolve("agents/forgedock-issue-worker.md"), extension, [reviewer]);
    try {
      const rendered = readFileSync(agent.file, "utf8");
      assert.match(rendered, /tools: forgedock_work_on, subagent, contact_supervisor/);
      assert.ok(rendered.includes(`subagentOnlyExtensions: ${JSON.stringify(extension)}`));
      assert.match(readFileSync(join(agent.directory, "forgedock-reviewer.md"), "utf8"), /tools: read, grep, find, ls/);
    } finally {
      agent.dispose();
    }
    assert.equal(existsSync(agent.directory), false);
  });
});
