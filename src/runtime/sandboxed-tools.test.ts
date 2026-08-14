import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { WorkspaceGuard, createSandboxedTools } from "./sandboxed-tools.js";

describe("runtime workspace confinement", () => {
  it("rejects lexical reads and writes outside the assigned worktree", async () => {
    const parent = mkdtempSync(join(tmpdir(), "forgedock-sandbox-"));
    const root = join(parent, "worktree");
    mkdirSync(root);
    writeFileSync(join(root, "inside.txt"), "ok");
    writeFileSync(join(parent, "outside.txt"), "secret");
    const guard = await WorkspaceGuard.create(root);
    assert.equal(await guard.existing("inside.txt"), realpathSync(join(root, "inside.txt")));
    await assert.rejects(guard.existing("../outside.txt"), /escapes/);
    await assert.rejects(guard.writable("../created.txt"), /escapes/);
  });

  it("rejects symlink escapes for existing and new files", async () => {
    const parent = mkdtempSync(join(tmpdir(), "forgedock-symlink-"));
    const root = join(parent, "worktree");
    const outside = join(parent, "outside");
    mkdirSync(root); mkdirSync(outside); writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(root, "link"), process.platform === "win32" ? "junction" : "dir");
    const guard = await WorkspaceGuard.create(root);
    await assert.rejects(guard.existing("link/secret.txt"), /escapes/);
    await assert.rejects(guard.writable("link/new.txt"), /escapes/);
  });

  it("executes grep against the validated real path and rejects symlink escapes", async () => {
    const parent = mkdtempSync(join(tmpdir(), "forgedock-grep-symlink-"));
    const root = join(parent, "worktree");
    const allowed = join(root, "allowed");
    const outside = join(parent, "outside");
    mkdirSync(root); mkdirSync(allowed); mkdirSync(outside);
    writeFileSync(join(allowed, "inside.ts"), "export const inside = true;\n");
    writeFileSync(join(outside, "secret.ts"), "export const secret = true;\n");
    try {
      symlinkSync(allowed, join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
      symlinkSync(outside, join(allowed, "escape"), process.platform === "win32" ? "junction" : "dir");
      const scope = { readRoots: ["allowed"], writeRoots: [], source: "build-packet" as const };
      const grep = (await createSandboxedTools(root, ["grep"], scope)).find((tool) => tool.name === "grep");
      assert.ok(grep);
      const result = await grep.execute("grep-real", { pattern: "inside", path: "alias" }, undefined, undefined, {} as never);
      assert.match((result.content[0] as { text: string }).text, /inside\.ts/);
      await assert.rejects(
        grep.execute("grep-escape", { pattern: "secret", path: "allowed/escape" }, undefined, undefined, {} as never),
        /escapes the assigned workspace|outside the assigned scope/,
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("creates packet-authorized new files without widening sibling writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgedock-new-file-"));
    try {
      const scope = {
        readRoots: ["."],
        writeRoots: [],
        writePaths: ["generated/contracts/host.ts"],
        source: "build-packet" as const,
      };
      const write = (await createSandboxedTools(root, ["write"], scope)).find((tool) => tool.name === "write");
      assert.ok(write);
      await write.execute("write-new", {
        path: "generated/contracts/host.ts",
        content: "export const host = true;\n",
      }, undefined, undefined, {} as never);
      assert.equal(readFileSync(join(root, "generated", "contracts", "host.ts"), "utf8"), "export const host = true;\n");
      await assert.rejects(
        write.execute("write-sibling", {
          path: "generated/contracts/other.ts",
          content: "export const other = true;\n",
        }, undefined, undefined, {} as never),
        /outside the assigned scope/,
      );
      await assert.rejects(
        write.execute("write-unrelated", {
          path: "unrelated/other.ts",
          content: "export const other = true;\n",
        }, undefined, undefined, {} as never),
        /outside the assigned scope/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("honors grep regex defaults and explicit literal matching", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgedock-grep-"));
    try {
      writeFileSync(join(root, "suite.test.ts"), 'const marker = `describe("forge (Act II)") alpha7`;\n');
      const grep = (await createSandboxedTools(root, ["grep"])).find((tool) => tool.name === "grep");
      assert.ok(grep);
      const regexResult = await grep.execute("grep-regex", { pattern: "alpha[0-9]", path: "." }, undefined, undefined, {} as never);
      assert.match((regexResult.content[0] as { text: string }).text, /suite\.test\.ts/);
      const literalResult = await grep.execute(
        "grep-literal",
        { pattern: 'describe("forge (Act II)")', path: ".", literal: true },
        undefined,
        undefined,
        {} as never,
      );
      assert.match((literalResult.content[0] as { text: string }).text, /suite\.test\.ts/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("provides guarded regex, glob, ignore-case, and truncation without external ripgrep", async () => {
    const parent = mkdtempSync(join(tmpdir(), "forgedock-portable-grep-"));
    const root = join(parent, "worktree");
    const outside = join(parent, "outside");
    mkdirSync(join(root, "src", "nested"), { recursive: true });
    mkdirSync(join(root, "ignored"));
    mkdirSync(outside);
    writeFileSync(join(root, ".gitignore"), "ignored/\nsrc/nested/notes.txt\n");
    writeFileSync(join(root, "src", "alpha.ts"), "Needle [42]\nneedle 7\n");
    writeFileSync(join(root, "src", "nested", "bravo.test.ts"), "NEEDLE 8\n");
    writeFileSync(join(root, "src", "nested", "notes.txt"), "needle 9\n");
    writeFileSync(join(root, "ignored", "ignored.ts"), "needle 10\n");
    writeFileSync(join(outside, "secret.ts"), "needle 11\n");
    symlinkSync(outside, join(root, "outside-link"), process.platform === "win32" ? "junction" : "dir");

    const previousPath = process.env.PATH;
    const previousOffline = process.env.PI_OFFLINE;
    process.env.PATH = join(parent, "missing-bin");
    process.env.PI_OFFLINE = "1";
    try {
      const grep = (await createSandboxedTools(root, ["grep"])).find((tool) => tool.name === "grep");
      assert.ok(grep);

      const literal = await grep.execute(
        "grep-literal-portable",
        { pattern: "Needle [42]", path: ".", glob: "*.ts", context: 1, literal: true },
        undefined,
        undefined,
        {} as never,
      );
      assert.match((literal.content[0] as { text: string }).text, /src\/alpha\.ts:1: Needle \[42\]/);
      assert.match((literal.content[0] as { text: string }).text, /src\/alpha\.ts-2- needle 7/);

      const regex = await grep.execute(
        "grep-regex-portable",
        { pattern: "^needle \\d+$", path: ".", glob: "**/*.test.ts", ignoreCase: true },
        undefined,
        undefined,
        {} as never,
      );
      const regexOutput = (regex.content[0] as { text: string }).text;
      assert.match(regexOutput, /src\/nested\/bravo\.test\.ts:1: NEEDLE 8/);
      assert.doesNotMatch(regexOutput, /notes\.txt|ignored\.ts|secret\.ts/);

      const nestedIgnored = await grep.execute(
        "grep-nested-ignore",
        { pattern: "needle 9", path: "src", literal: true },
        undefined,
        undefined,
        {} as never,
      );
      assert.equal((nestedIgnored.content[0] as { text: string }).text, "No matches found");

      const limited = await grep.execute(
        "grep-limit",
        { pattern: "needle ", path: ".", glob: "**/*.ts", ignoreCase: true, limit: 1, literal: true },
        undefined,
        undefined,
        {} as never,
      );
      assert.equal((limited.details as { matchLimitReached?: number } | undefined)?.matchLimitReached, 1);
      assert.match((limited.content[0] as { text: string }).text, /1 matches limit reached/);

      const confined = await grep.execute(
        "grep-confined",
        { pattern: "needle 11", path: ".", literal: true },
        undefined,
        undefined,
        {} as never,
      );
      assert.equal((confined.content[0] as { text: string }).text, "No matches found");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousOffline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = previousOffline;
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("aborts sandbox grep without waiting for traversal to finish", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgedock-abort-grep-"));
    try {
      writeFileSync(join(root, "large.txt"), "search me\n".repeat(10_000));
      const grep = (await createSandboxedTools(root, ["grep"])).find((tool) => tool.name === "grep");
      assert.ok(grep);
      const controller = new AbortController();
      const execution = grep.execute("grep-abort", { pattern: "search", path: "." }, controller.signal, undefined, {} as never);
      controller.abort();
      await assert.rejects(execution, /Operation aborted/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("provides side-effect-free deterministic Ed25519 test-vector computation", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgedock-compute-"));
    const compute = (await createSandboxedTools(root, ["compute"])).find((tool) => tool.name === "compute");
    assert.ok(compute);
    const result = await compute.execute("compute-1", {
      operation: "ed25519_sign",
      data: "",
      encoding: "hex",
      seedHex: "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    }, undefined, undefined, {} as never);
    const output = JSON.parse((result.content[0] as { text: string }).text) as { publicKeyHex: string; signatureHex: string };
    assert.equal(output.publicKeyHex, "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
    assert.equal(output.signatureHex,
      "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155"+
      "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b");
  });

  it("refuses unrestricted bash grants", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgedock-tools-"));
    await assert.rejects(createSandboxedTools(root, ["bash"]), /does not expose unrestricted bash/);
  });
});
