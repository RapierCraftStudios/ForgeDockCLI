import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { FORGEDOCK_VERIFICATION_PATH, sealVerificationEnvironment } from "../../runtime/controller-environment.js";
import { ProcessVerificationRunner, windowsTaskkillSucceeded } from "./process-verifier.js";

describe("deterministic process verification", () => {
  it("treats nonzero or indeterminate taskkill status as a failed tree termination", () => {
    assert.equal(windowsTaskkillSucceeded({ status: 0 }), true);
    assert.equal(windowsTaskkillSucceeded({ status: 1 }), false);
    assert.equal(windowsTaskkillSucceeded({ status: null }), false);
    assert.equal(windowsTaskkillSucceeded({ status: 0, error: new Error("spawn failed") }), false);
  });

  it("records executable evidence without invoking a shell", async () => {
    const runner = isolatedRunner();
    const [result] = await runner.run([{
      id: "pass", command: process.execPath, args: ["-e", "console.log('verified')"],
      cwd: process.cwd(), timeoutMs: 5_000, required: true,
    }]);
    assert.equal(result?.status, "passed");
    assert.equal(result?.exitCode, 0);
    assert.match(result?.outputDigest ?? "", /^[0-9a-f]{64}$/);
    assert.match(result?.summary ?? "", /verified/);
  });

  it("resolves a bare command from the sealed PATH after a sparse descendant boundary", async () => {
    if (process.platform === "win32") return;
    const source: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: dirname(process.execPath),
    };
    for (const name of Object.keys(source)) {
      if (name.toLowerCase() === FORGEDOCK_VERIFICATION_PATH.toLowerCase()) delete source[name];
    }
    const parent = sealVerificationEnvironment(source);
    const sealedPath = parent[FORGEDOCK_VERIFICATION_PATH];
    assert.ok(sealedPath);
    const descendant: NodeJS.ProcessEnv = {
      ...parent,
      PATH: join(tmpdir(), `forgedock-runner-sparse-${process.pid}-${randomUUID()}`),
    };
    assert.equal(descendant[FORGEDOCK_VERIFICATION_PATH], sealedPath);
    const [result] = await isolatedRunner(descendant).run([{
      id: "sealed-bare-node", command: basename(process.execPath),
      args: ["-e", "console.log('sealed runner')"],
      cwd: process.cwd(), timeoutMs: 5_000, required: true,
    }]);
    assert.equal(result?.status, "passed");
    assert.match(result?.summary ?? "", /sealed runner/);
  });

  it("executes every required command even when coverage metadata is present", async () => {
    const runner = isolatedRunner();
    const [covered, parent] = await runner.run([
      {
        id: "build", command: process.execPath, args: ["-e", "process.exit(17)"],
        cwd: process.cwd(), timeoutMs: 5_000, required: true, planId: "plan-1", coveredBy: ["test"],
      },
      {
        id: "test", command: process.execPath, args: ["-e", "console.log('parent ran')"],
        cwd: process.cwd(), timeoutMs: 5_000, required: true, planId: "plan-1",
      },
    ]);
    assert.equal(covered?.status, "failed");
    assert.equal(covered?.exitCode, 17);
    assert.ok((covered?.durationMs ?? 0) >= 0);
    assert.equal(parent?.status, "passed");
    assert.match(parent?.summary ?? "", /parent ran/);
  });

  it("does not expose orchestrator child identity to verification commands", async () => {
    const runner = isolatedRunner({ ...process.env, PI_SUBAGENT_CHILD_AGENT: "forgedock-issue-worker" });
    const [result] = await runner.run([{
      id: "clean-environment", command: process.execPath,
      args: ["-e", "if(process.env.PI_SUBAGENT_CHILD_AGENT) process.exit(41); console.log('controller environment')"],
      cwd: process.cwd(), timeoutMs: 5_000, required: true,
    }]);
    assert.equal(result?.status, "passed");
    assert.match(result?.summary ?? "", /controller environment/);
  });

  it("does not expose controller credentials to verification commands", async () => {
    const runner = isolatedRunner({
      ...process.env,
      AUDIT_SECRET: "fd-secret-proof",
      GH_TOKEN: "github-token",
      OPENAI_API_KEY: "provider-key",
    });
    const script = [
      "if(process.env.AUDIT_SECRET||process.env.GH_TOKEN||process.env.OPENAI_API_KEY) process.exit(42);",
      "if(!process.env.HOME||!process.env.NPM_CONFIG_USERCONFIG?.startsWith(process.env.HOME)) process.exit(43);",
      "console.log('GH_TOKEN=ghp_hardcodedproof https://user:password@example.test/simple github_pat_abcdefgh\\u001b[31mijklmnop github_pat_qrst\\u009b31muvwxyz12');",
      "console.log('credentials sealed')",
    ].join("");
    const [result] = await runner.run([{
      id: "sealed-credentials", command: process.execPath, args: ["-e", script],
      cwd: process.cwd(), timeoutMs: 5_000, required: true,
    }]);
    assert.equal(result?.status, "passed");
    assert.match(result?.summary ?? "", /credentials sealed/);
    assert.doesNotMatch(
      result?.summary ?? "",
      /ghp_hardcodedproof|user:password|github_pat_abcdefghijklmnop|github_pat_qrstuvwxyz12/,
    );
  });

  it("resolves Git Bash rather than the Windows or WSL launcher in headed verification", async () => {
    if (process.platform !== "win32") return;
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    assert.ok(systemRoot);
    const script = [
      "const {spawnSync}=require('node:child_process');",
      "const r=spawnSync('bash',['-c','test -n \"$MSYSTEM\" && command -v mktemp && command -v jq'],{encoding:'utf8'});",
      "if(r.status!==0){process.stderr.write(r.stderr||'wrong bash');process.exit(42)}",
      "console.log(r.stdout.trim())",
    ].join("");
    const sparseEnvironment: NodeJS.ProcessEnv = { ...process.env, PATH: join(systemRoot, "System32") };
    for (const name of Object.keys(sparseEnvironment)) {
      if (name.toLowerCase() === "msystem") delete sparseEnvironment[name];
    }
    const [result] = await isolatedRunner(sparseEnvironment).run([{
      id: "git-bash", command: process.execPath, args: ["-e", script],
      cwd: process.cwd(), timeoutMs: 15_000, required: true,
    }]);
    assert.equal(result?.status, "passed");
    assert.match(result?.summary ?? "", /mktemp/);
    assert.match(result?.summary ?? "", /jq/);
  });

  it("extracts stable TAP failure identities for baseline comparison", async () => {
    const runner = isolatedRunner();
    const [result] = await runner.run([{
      id: "tap-fail", command: process.execPath,
      args: ["-e", "console.log('not ok 15 - windows path import'); console.log('not ok 176 - forge (Act II)'); process.exit(1)"],
      cwd: process.cwd(), timeoutMs: 5_000, required: true,
    }]);
    assert.deepEqual(result?.failureSignatures, ["not ok - forge (Act II)", "not ok - windows path import"]);
    assert.match(result?.summary ?? "", /not ok 15 - windows path import/);
  });

  it("serializes verification across runner instances that share machine-global fixtures", async () => {
    const directory = mkdtempSync(join(tmpdir(), "forgedock-verifier-lock-"));
    const lockPath = join(directory, "verification.lock");
    const fixturePath = join(directory, "active-fixture");
    const script = [
      "const fs=require('node:fs');",
      "const path=process.argv[1];",
      "if(fs.existsSync(path)) process.exit(9);",
      "fs.writeFileSync(path,String(process.pid));",
      "setTimeout(()=>{fs.unlinkSync(path);process.exit(0)},100);",
    ].join("");
    try {
      const run = () => new ProcessVerificationRunner({ lockPath }).run([{
        id: "exclusive", command: process.execPath, args: ["-e", script, fixturePath],
        cwd: process.cwd(), timeoutMs: 5_000, required: true,
      }]);
      const [left, right] = await Promise.all([run(), run()]);
      assert.equal(left[0]?.status, "passed");
      assert.equal(right[0]?.status, "passed");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("terminates the complete verification process tree on timeout", async () => {
    const directory = mkdtempSync(join(tmpdir(), "forgedock-verifier-tree-"));
    const pidFile = join(directory, "descendant.pid");
    const lockPath = join(directory, "verification.lock");
    const descendant = "setInterval(()=>{},1000)";
    const parent = [
      "const {spawn}=require('node:child_process');",
      "const fs=require('node:fs');",
      `const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});`,
      "fs.writeFileSync(process.argv[1],String(child.pid));",
      "setInterval(()=>{},1000);",
    ].join("");
    let descendantPid: number | undefined;
    try {
      const [result] = await new ProcessVerificationRunner({ lockPath }).run([{
        id: "timeout-tree", command: process.execPath, args: ["-e", parent, pidFile],
        cwd: process.cwd(), timeoutMs: 500, required: true,
      }]);
      assert.equal(result?.status, "failed");
      assert.equal(result?.failureClass, "timeout");
      assert.equal(result?.summary, "Timed out");
      assert.ok(existsSync(pidFile), "parent recorded the descendant pid before timeout");
      descendantPid = Number(readFileSync(pidFile, "utf8"));
      await assertEventuallyDead(descendantPid);
    } finally {
      if (descendantPid && isAlive(descendantPid)) terminatePid(descendantPid);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("records spawn failures and continues through the remaining verification plan", async () => {
    const runner = isolatedRunner();
    const results = await runner.run([
      { id: "missing", command: `forgedock-missing-${randomUUID()}`, args: [], cwd: process.cwd(), timeoutMs: 5_000, required: true },
      { id: "after-spawn-error", command: process.execPath, args: ["-e", "process.exit(0)"], cwd: process.cwd(), timeoutMs: 5_000, required: true },
    ]);
    assert.equal(results.length, 2);
    assert.equal(results[0]?.status, "failed");
    assert.equal(results[0]?.failureClass, "infrastructure");
    assert.match(results[0]?.summary ?? "", /Failed to start verification command \(ENOENT\)/);
    assert.equal(results[1]?.status, "passed");
  });

  it("collects every required check so one repair receives complete failure evidence", async () => {
    const runner = isolatedRunner();
    const results = await runner.run([
      { id: "fail", command: process.execPath, args: ["-e", "process.exit(3)"], cwd: process.cwd(), timeoutMs: 5_000, required: true },
      { id: "after-failure", command: process.execPath, args: ["-e", "process.exit(0)"], cwd: process.cwd(), timeoutMs: 5_000, required: true },
    ]);
    assert.equal(results.length, 2);
    assert.equal(results[0]?.status, "failed");
    assert.equal(results[0]?.failureClass, "command");
    assert.equal(results[0]?.exitCode, 3);
    assert.equal(results[1]?.status, "passed");
  });
});

function isolatedRunner(environment: NodeJS.ProcessEnv = process.env): ProcessVerificationRunner {
  return new ProcessVerificationRunner({
    lockPath: join(tmpdir(), `forgedock-verifier-test-${randomUUID()}.lock`),
    environment,
  });
}

async function assertEventuallyDead(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!isAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`verification descendant ${pid} survived process-tree termination`);
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function terminatePid(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, shell: false });
  } else {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}
