import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { ProcessVerificationRunner, waitForProcessTreeQuiescence, windowsTaskkillSucceeded } from "./process-verifier.js";

function stagingLayout(cwd: string, identity = "test-staging-identity") {
  const source = JSON.stringify({ compilerOptions: { rootDir: "src", outDir: "dist" }, include: ["src/**/*.ts"] });
  writeFileSync(join(cwd, "tsconfig.json"), source);
  return {
    sourceRoot: "src",
    outputRoot: ".dist.forgedock-verification-test",
    configuredOutputRoot: "dist",
    project: "tsconfig.json",
    configDigest: createHash("sha256").update(source).digest("hex").slice(0, 16),
    stagingIdentity: identity,
    markerName: ".forgedock-verification-marker.json",
  };
}

function stagedCommand(cwd: string, id: string, args: string[], layout: ReturnType<typeof stagingLayout>) {
  return {
    id, command: process.execPath, args, cwd, timeoutMs: 15_000, required: true,
    lockScope: "workspace" as const, cleanOutputRoot: layout.outputRoot,
    typescriptLayout: layout,
  };
}

function localCompiler(): string | undefined {
  let directory = process.cwd();
  while (true) {
    const candidate = join(directory, "node_modules", "typescript", "bin", "tsc");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

describe("deterministic process verification", () => {
  it("treats nonzero or indeterminate taskkill status as a failed tree termination", () => {
    assert.equal(windowsTaskkillSucceeded({ status: 0 }), true);
    assert.equal(windowsTaskkillSucceeded({ status: 1 }), false);
    assert.equal(windowsTaskkillSucceeded({ status: null }), false);
    assert.equal(windowsTaskkillSucceeded({ status: 0, error: new Error("spawn failed") }), false);
  });

  it("distinguishes live process trees from quiescent trees", async () => {
    assert.equal(await waitForProcessTreeQuiescence(undefined, undefined, 10), true);
    assert.equal(await waitForProcessTreeQuiescence(process.pid, undefined, 20), false);
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => resolve());
    });
    assert.equal(await waitForProcessTreeQuiescence(child.pid, undefined, 100), true);
  });

  it("records executable evidence without invoking a shell", async () => {
    const runner = isolatedRunner();
    const [result] = await runner.run([{
      id: "pass", command: process.execPath, args: ["-e", "console.log('verified')"],
      cwd: process.cwd(), timeoutMs: 5_000, required: true,
      policyVersion: "forgedock.verification/v2", targets: ["dist/pass.test.js"], planId: "plan-pass",
    }]);
    assert.equal(result?.status, "passed");
    assert.equal(result?.commandId, "pass");
    assert.equal(result?.policyVersion, "forgedock.verification/v2");
    assert.deepEqual(result?.commandTargets, ["dist/pass.test.js"]);
    assert.equal(result?.planId, "plan-pass");
    assert.equal(result?.exitCode, 0);
    assert.match(result?.outputDigest ?? "", /^[0-9a-f]{64}$/);
    assert.match(result?.summary ?? "", /verified/);
  });

  it("does not duplicate frozen targets and continues after malformed targets", async () => {
    const directory = mkdtempSync(join(tmpdir(), "forgedock-verifier-targets-"));
    writeFileSync(join(directory, "target.test.js"), "");
    try {
      const results = await isolatedRunner().run([
        {
          id: "malformed-target", command: process.execPath, args: ["-e", ""], cwd: directory,
          timeoutMs: 5_000, required: true, lockScope: "workspace", targeting: "expected-test-paths",
          targets: ["../escape.test.js"],
        },
        {
          id: "single-target", command: process.execPath,
          args: ["-e", "if(process.argv.filter((value)=>value==='target.test.js').length!==1) process.exit(31)", "target.test.js"],
          cwd: directory, timeoutMs: 5_000, required: true, lockScope: "workspace",
          targeting: "expected-test-paths", targets: ["target.test.js"],
        },
      ]);
      assert.equal(results[0]?.status, "failed");
      assert.equal(results[0]?.failureClass, "infrastructure");
      assert.equal(results[1]?.status, "passed");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps configured output untouched and removes staging after success and failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "forgedock-verifier-output-"));
    mkdirSync(join(directory, "dist"));
    const sentinel = join(directory, "dist", "sentinel.txt");
    writeFileSync(sentinel, "tracked-output");
    const layout = stagingLayout(directory);
    try {
      const runner = isolatedRunner();
      const passed = await runner.run([stagedCommand(directory, "success", ["-e", ""], layout)]);
      assert.equal(passed[0]?.status, "passed");
      assert.equal(readFileSync(sentinel, "utf8"), "tracked-output");
      assert.equal(existsSync(join(directory, layout.outputRoot)), false);
      const failed = await runner.run([stagedCommand(directory, "failure", ["-e", "process.exit(7)"], layout)]);
      assert.equal(failed[0]?.status, "failed");
      assert.equal(existsSync(join(directory, layout.outputRoot)), false);
      const spawned = await runner.run([{
        ...stagedCommand(directory, "spawn-failure", [], layout), command: "forgedock-command-that-does-not-exist",
      }]);
      assert.equal(spawned[0]?.status, "failed");
      assert.equal(existsSync(join(directory, layout.outputRoot)), false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("compiles a real TS project into sibling staging and runs an outside-root import", async () => {
    const compiler = localCompiler();
    if (!compiler) return;
    const directory = mkdtempSync(join(tmpdir(), "forgedock-verifier-ts-project-"));
    mkdirSync(join(directory, "src"), { recursive: true });
    mkdirSync(join(directory, "vendor"), { recursive: true });
    mkdirSync(join(directory, "dist"), { recursive: true });
    writeFileSync(join(directory, "dist", "sentinel.txt"), "unchanged");
    writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(directory, "vendor", "helper.js"), "import { readFileSync } from 'node:fs'; import { dirname, join } from 'node:path'; import { fileURLToPath } from 'node:url'; const marker = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../.dist.forgedock-verification-real/.forgedock-verification-marker.json'), 'utf8')); export const value = 42; export const markerFenced = Boolean(marker.childPid);\n");
    writeFileSync(join(directory, "vendor", "helper.d.ts"), "export const value: number; export const markerFenced: boolean;\n");
    writeFileSync(join(directory, "src", "outside.test.ts"), "import { value, markerFenced } from '../vendor/helper.js'; if (value !== 42 || !markerFenced) throw new Error('staging marker was not fenced');\n");
    const config = JSON.stringify({ compilerOptions: { rootDir: "src", outDir: "dist", module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022" }, include: ["src/**/*.ts"] });
    writeFileSync(join(directory, "tsconfig.json"), config);
    const layout = { sourceRoot: "src", outputRoot: ".dist.forgedock-verification-real", configuredOutputRoot: "dist", project: "tsconfig.json", configDigest: createHash("sha256").update(config).digest("hex").slice(0, 16), stagingIdentity: "real-ts-project", markerName: ".forgedock-verification-marker.json" };
    const target = `${layout.outputRoot}/outside.test.js`;
    try {
      const targetedTest = {
        id: "targeted-test", command: process.execPath, args: ["--test", "--test-concurrency=4", target], cwd: directory,
        timeoutMs: 5_000, required: true, lockScope: "workspace" as const, targeting: "expected-test-paths" as const,
        targets: [target], typescriptLayout: layout,
      };
      const results = await new ProcessVerificationRunner({ lockPath: join(directory, "lock") }).run([
        { ...stagedCommand(directory, "compile", [compiler, "-p", "tsconfig.json", "--outDir", layout.outputRoot], layout), args: [compiler, "-p", "tsconfig.json", "--outDir", layout.outputRoot] },
        targetedTest,
      ]);
      assert.equal(results[0]?.status, "passed");
      assert.equal(results[1]?.status, "passed");
      assert.equal(readFileSync(join(directory, "dist", "sentinel.txt"), "utf8"), "unchanged");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("removes staging after abort and still releases the machine lock after cleanup failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "forgedock-verifier-abort-"));
    const lockPath = join(directory, "machine.lock");
    const layout = stagingLayout(directory);
    const controller = new AbortController();
    try {
      const run = new ProcessVerificationRunner({ lockPath }).run([stagedCommand(
        directory, "abort", ["-e", "setInterval(()=>{},1000)"], layout,
      )], controller.signal);
      await new Promise((resolve) => setTimeout(resolve, 100));
      controller.abort(new Error("stop verification"));
      await assert.rejects(run, /stop verification/);
      assert.equal(existsSync(join(directory, layout.outputRoot)), false);

      const cleanupLayout = stagingLayout(directory, "cleanup-failure");
      const marker = join(directory, cleanupLayout.outputRoot, cleanupLayout.markerName);
      const first = new ProcessVerificationRunner({ lockPath }).run([{ ...stagedCommand(
        directory, "cleanup-failure", ["-e", "require('node:fs').unlinkSync(process.argv[1])", marker], cleanupLayout,
      ), lockScope: "machine-global" }]);
      const [cleanupResult] = await first;
      assert.equal(cleanupResult?.status, "failed");
      assert.match(cleanupResult?.summary ?? "", /verification cleanup: Verification staging marker changed unexpectedly/);
      const second = await new ProcessVerificationRunner({ lockPath }).run([{
        id: "after-cleanup-failure", command: process.execPath, args: ["-e", ""], cwd: directory,
        timeoutMs: 5_000, required: true,
      }]);
      const precedenceLayout = stagingLayout(directory, "primary-failure");
      precedenceLayout.outputRoot = ".dist.forgedock-verification-primary-failure";
      const precedenceMarker = join(directory, precedenceLayout.outputRoot, precedenceLayout.markerName);
      const precedence = await new ProcessVerificationRunner({ lockPath }).run([{
        ...stagedCommand(directory, "primary-failure", ["-e", "require('node:fs').unlinkSync(process.argv[1]);process.exit(9)", precedenceMarker], precedenceLayout),
        lockScope: "machine-global",
      }]);
      assert.equal(precedence[0]?.status, "failed");
      assert.equal(precedence[0]?.exitCode, 9);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("keeps concurrent runs on one runner ownership-isolated", async () => {
    const first = mkdtempSync(join(tmpdir(), "forgedock-verifier-concurrent-a-"));
    const second = mkdtempSync(join(tmpdir(), "forgedock-verifier-concurrent-b-"));
    const firstLayout = stagingLayout(first, "concurrent-a");
    const secondLayout = stagingLayout(second, "concurrent-b");
    try {
      const runner = new ProcessVerificationRunner({ lockPath: join(tmpdir(), `forgedock-${randomUUID()}.lock`) });
      const [a, b] = await Promise.all([
        runner.run([stagedCommand(first, "a", ["-e", "setTimeout(()=>{},250)"], firstLayout)]),
        runner.run([stagedCommand(second, "b", ["-e", "setTimeout(()=>{},250)"], secondLayout)]),
      ]);
      assert.equal(a[0]?.status, "passed");
      assert.equal(b[0]?.status, "passed");
      assert.equal(existsSync(join(first, firstLayout.outputRoot)), false);
      assert.equal(existsSync(join(second, secondLayout.outputRoot)), false);
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  it("recovers only exact stale markers and refuses unknown or live collisions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "forgedock-verifier-collision-"));
    const layout = stagingLayout(directory, "collision-identity");
    const output = join(directory, layout.outputRoot);
    const marker = join(output, layout.markerName);
    try {
      mkdirSync(output, { recursive: true });
      writeFileSync(marker, JSON.stringify({ schema: "forgedock.verification-output/v1", identity: layout.stagingIdentity, pid: 99999999, token: "stale" }));
      const runner = isolatedRunner();
      await runner.recoverOperationalOutput([stagedCommand(directory, "recover", ["-e", ""], layout)]);
      const pending = join(directory, `.${layout.outputRoot.split("/").at(-1)}.forgedock-verification-pending-crash`);
      mkdirSync(pending, { recursive: true });
      writeFileSync(join(pending, layout.markerName), JSON.stringify({ schema: "forgedock.verification-output/v1", identity: layout.stagingIdentity, pid: 99999999, token: "pending" }));
      await runner.recoverOperationalOutput([stagedCommand(directory, "pending", ["-e", ""], layout)]);
      assert.equal(existsSync(pending), false);
      const unmarked = join(directory, `.${layout.outputRoot.split("/").at(-1)}.forgedock-verification-pending-unmarked`);
      mkdirSync(unmarked, { recursive: true });
      writeFileSync(join(unmarked, "unknown.txt"), "do not delete");
      await runner.recoverOperationalOutput([stagedCommand(directory, "unmarked", ["-e", ""], layout)]);
      assert.equal(existsSync(unmarked), true);
      rmSync(unmarked, { recursive: true, force: false });
      const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: directory, stdio: "ignore" });
      mkdirSync(output, { recursive: true });
      writeFileSync(marker, JSON.stringify({ schema: "forgedock.verification-output/v1", identity: layout.stagingIdentity, pid: 99999999, token: "child-live", childPid: child.pid, childPgid: child.pid }));
      await assert.rejects(runner.recoverOperationalOutput([stagedCommand(directory, "child-live", ["-e", ""], layout)]), /child|collision/i);
      child.kill();
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
      await runner.recoverOperationalOutput([stagedCommand(directory, "child-dead", ["-e", ""], layout)]);
      assert.equal(existsSync(output), false);

      rmSync(output, { recursive: true, force: true });
      mkdirSync(output, { recursive: true });
      writeFileSync(join(output, "unknown.txt"), "unknown");
      await assert.rejects(runner.prepareOperationalOutput([stagedCommand(directory, "unknown", ["-e", ""], layout)]), /Unknown verification staging collision/);
      rmSync(output, { recursive: true, force: true });
      symlinkSync(join(directory, "missing-target"), output);
      await assert.rejects(runner.recoverOperationalOutput([stagedCommand(directory, "dangling", ["-e", ""], layout)]), /unsafe|collision/i);
      assert.equal(lstatSync(output).isSymbolicLink(), true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
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

  it("retains Node test failure names and locations in bounded diagnostics", async () => {
    const runner = isolatedRunner();
    const output = [
      "✖ parent suite (600ms)",
      "✖ failing tests:",
      "test at dist/tui/forgedock-extension.test.js:576:1",
      "✖ orchestration preview exposes a single-use continuation checkpoint (523.05ms)",
      "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 0 !== 1",
    ];
    const [result] = await runner.run([{
      id: "node-test-fail", command: process.execPath,
      args: ["-e", `console.log(${JSON.stringify(output.join("\n"))}); process.exit(1)`],
      cwd: process.cwd(), timeoutMs: 5_000, required: true,
    }]);
    assert.deepEqual(result?.failureSignatures, [
      "node test - orchestration preview exposes a single-use continuation checkpoint",
    ]);
    assert.match(result?.summary ?? "", /forgedock-extension\.test\.js:576:1/);
    assert.match(result?.summary ?? "", /0 !== 1/);
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

  it("releases the machine-global lease before flushing buffered progress", async () => {
    const directory = mkdtempSync(join(tmpdir(), "forgedock-verifier-progress-lock-"));
    const lockPath = join(directory, "verification.lock");
    let completedProgress!: () => void;
    const completedProgressReached = new Promise<void>((resolve) => { completedProgress = resolve; });
    let resumeProgress!: () => void;
    const progressGate = new Promise<void>((resolve) => { resumeProgress = resolve; });
    const command = {
      id: "exclusive",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: directory,
      timeoutMs: 5_000,
      required: true,
    } as const;
    try {
      const first = new ProcessVerificationRunner({ lockPath }).run([command], undefined, async (event) => {
        if (event.phase !== "command-completed") return;
        completedProgress();
        await progressGate;
      });
      await completedProgressReached;

      const second = new ProcessVerificationRunner({ lockPath }).run([command]);
      const secondResult = await Promise.race([
        second,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("lease remained held during progress write")), 1_000)),
      ]);
      assert.equal(secondResult[0]?.status, "passed");
      resumeProgress();
      assert.equal((await first)[0]?.status, "passed");
    } finally {
      resumeProgress();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves buffered progress order and command authority when writes fail", async () => {
    const phases: string[] = [];
    const results = await isolatedRunner().run([
      {
        id: "global",
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: process.cwd(),
        timeoutMs: 5_000,
        required: true,
      },
      {
        id: "workspace",
        command: process.execPath,
        args: ["-e", "process.exit(7)"],
        cwd: process.cwd(),
        timeoutMs: 5_000,
        required: true,
        lockScope: "workspace",
      },
    ], undefined, (event) => {
      phases.push(event.phase);
      throw new Error("progress sink unavailable");
    });

    assert.deepEqual(phases, [
      "lock-waiting",
      "lock-acquired",
      "command-started",
      "command-completed",
      "lock-released",
      "command-started",
      "command-completed",
    ]);
    assert.deepEqual(results.map((result) => result.status), ["passed", "failed"]);
    assert.equal(results[1]?.exitCode, 7);
  });

  it("runs isolated workspace checks concurrently and reports typed command progress", async () => {
    const directory = mkdtempSync(join(tmpdir(), "forgedock-verifier-independent-"));
    const lockPath = join(directory, "verification.lock");
    const progress: string[] = [];
    const markers = [join(directory, "left.started"), join(directory, "right.started")];
    const run = (id: string) => new ProcessVerificationRunner({ lockPath }).run([{
      id,
      command: process.execPath,
      args: ["-e", [
        "const fs=require('node:fs');",
        "const [own,left,right]=process.argv.slice(1);",
        "fs.writeFileSync(own,'started');",
        "const deadline=Date.now()+3000;",
        "const timer=setInterval(()=>{",
        "if(fs.existsSync(left)&&fs.existsSync(right)){clearInterval(timer);process.exit(0);}",
        "if(Date.now()>=deadline){clearInterval(timer);process.exit(9);}",
        "},10);",
      ].join(""), id === "left" ? markers[0]! : markers[1]!, ...markers],
      cwd: directory,
      timeoutMs: 5_000,
      required: true,
      lockScope: "workspace" as const,
    }], undefined, (event) => { progress.push(`${id}:${event.phase}`); });
    try {
      const [left, right] = await Promise.all([run("left"), run("right")]);
      assert.equal(left[0]?.status, "passed");
      assert.equal(right[0]?.status, "passed");
      assert.deepEqual(progress.filter((entry) => entry.endsWith("command-started")).sort(), [
        "left:command-started", "right:command-started",
      ]);
      assert.deepEqual(progress.filter((entry) => entry.endsWith("command-completed")).sort(), [
        "left:command-completed", "right:command-completed",
      ]);
      assert.equal(progress.some((entry) => entry.includes("lock-")), false);
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

  it("rejects with the exact cancellation reason after terminating the child", async () => {
    const directory = mkdtempSync(join(tmpdir(), "forgedock-verifier-cancel-"));
    const pidFile = join(directory, "child.pid");
    const controller = new AbortController();
    const reason = new Error("lease continuity lost");
    let childPid: number | undefined;
    try {
      const run = isolatedRunner().run([{
        id: "cancelled",
        command: process.execPath,
        args: ["-e", "require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)", pidFile],
        cwd: directory,
        timeoutMs: 5_000,
        required: true,
        lockScope: "workspace",
      }], controller.signal);
      await waitForFile(pidFile);
      childPid = Number(readFileSync(pidFile, "utf8"));
      controller.abort(reason);
      await assert.rejects(run, (error: unknown) => error === reason);
      await assertEventuallyDead(childPid);
    } finally {
      if (childPid && isAlive(childPid)) terminatePid(childPid);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rechecks cancellation after registering the child listener", async () => {
    const reason = new Error("cancelled during listener registration");
    let abortedReads = 0;
    const racingSignal = {
      get aborted() { abortedReads += 1; return abortedReads >= 2; },
      reason,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as AbortSignal;

    await assert.rejects(isolatedRunner().run([{
      id: "listener-race",
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      cwd: process.cwd(),
      timeoutMs: 5_000,
      required: true,
      lockScope: "workspace",
    }], racingSignal), (error: unknown) => error === reason);
  });

  it("bounds huge output and exposes an explicit truncation marker", async () => {
    const huge = "x".repeat(200_000);
    const [result] = await isolatedRunner().run([{
      id: "huge-output", command: process.execPath,
      args: ["-e", `process.stdout.write('x'.repeat(${huge.length}))`], cwd: process.cwd(), timeoutMs: 5_000, required: true,
    }]);
    assert.match(result?.summary ?? "", /verification output truncated/);
    assert.ok((result?.summary?.length ?? 0) < 2_000);
  });

  it("redacts secrets split across streaming stdout and stderr chunks", async () => {
    const script = "process.stdout.write('AUDIT_SECRET=split-');setImmediate(()=>process.stderr.write('secret-proof'));";
    const [result] = await isolatedRunner({ ...process.env, AUDIT_SECRET: "split-secret-proof" }).run([{
      id: "split-secret", command: process.execPath, args: ["-e", script], cwd: process.cwd(), timeoutMs: 5_000, required: true,
    }]);
    assert.equal(result?.status, "passed");
    assert.doesNotMatch(result?.summary ?? "", /split-secret-proof|split-/);
    assert.match(result?.summary ?? "", /REDACTED/);
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

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`verification child did not create ${path}`);
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
