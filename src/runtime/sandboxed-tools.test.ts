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

  it("refuses unrestricted bash grants", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgedock-tools-"));
    await assert.rejects(createSandboxedTools(root, ["bash"]), /does not expose unrestricted bash/);
  });
});
