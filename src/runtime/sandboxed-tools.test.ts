import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  it("defaults reviewer grep patterns to literal matching unless regex mode is explicit", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgedock-grep-"));
    try {
      writeFileSync(join(root, "suite.test.ts"), 'const marker = `describe("forge (Act II)")`;\n');
      const grep = (await createSandboxedTools(root, ["grep"])).find((tool) => tool.name === "grep");
      assert.ok(grep);
      const result = await grep.execute("grep-1", { pattern: 'describe("forge (Act II)")', path: "." }, undefined, undefined, {} as never);
      assert.match((result.content[0] as { text: string }).text, /suite\.test\.ts/);
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
