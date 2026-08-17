import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { createSandboxedTools, safeMutationSupportAvailable, WorkspaceGuard } from "./sandboxed-tools.js";
import { scopeManifestFor, scopeManifestForBuildPacket } from "./agent-runtime.js";

describe("scope manifests", () => {
  it("limits reads and writes to declared roots while retaining lexical and symlink guards", async () => {
    const root = await mkdtemp(join(tmpdir(), "forgedock-scope-"));
    const allowed = join(root, "src");
    const denied = join(root, "secrets");
    await mkdir(allowed);
    await mkdir(denied);
    await writeFile(join(allowed, "a.ts"), "export const a = 1;\n");
    await writeFile(join(allowed, "b.ts"), "export const b = 1;\n");
    await writeFile(join(denied, "secret.txt"), "secret\n");
    const guard = await WorkspaceGuard.create(root, { readRoots: ["src"], writeRoots: ["src"], source: "build-packet" });
    await guard.existing("src/a.ts");
    await assert.rejects(guard.existing("secrets/secret.txt"), /outside the assigned scope/);
    await assert.rejects(guard.writable("secrets/new.txt"), /outside the assigned scope/);
    const packetGuard = await WorkspaceGuard.create(root, { readRoots: ["src"], writeRoots: [], writePaths: ["src/a.ts"], source: "build-packet" });
    if (!safeMutationSupportAvailable()) {
      await assert.rejects(packetGuard.writable("src/a.ts"), /descriptor-relative no-follow filesystem primitives/);
    } else {
      const packetFile = await packetGuard.writable("src/a.ts");
      await packetFile.close();
      await assert.rejects(packetGuard.writable("src/b.ts"), /outside the assigned scope/);
    }
    const tools = await createSandboxedTools(root, ["read"], { readRoots: ["src"], writeRoots: [], source: "build-packet" });
    assert.ok(tools.some((tool) => tool.name === "read"));
    const link = join(root, "src", "outside");
    try {
      await symlink(denied, link, "junction");
      await assert.rejects(guard.existing("src/outside/secret.txt"));
    } catch {
      // Symlink creation can be disabled on constrained Windows runners.
    }
  });

  it("derives bounded metadata roots for issue hints", () => {
    const manifest = scopeManifestFor("issue-hints", { affectedFiles: ["src/api/a.ts"], metadataRoots: ["package.json", "forge.yaml"] });
    assert.ok(manifest.readRoots.includes("src/api"));
    assert.ok(manifest.readRoots.includes("package.json"));
    assert.deepEqual(manifest.writeRoots, []);
  });

  it("derives top-level discovery reads and exact writes from a frozen Build Packet", () => {
    const manifest = scopeManifestForBuildPacket([
      "src/core/ports/forge-host.ts",
      "src/adapters/github/github-client.ts",
    ]);
    assert.ok(manifest.readRoots.includes("src"));
    assert.ok(manifest.readRoots.includes("package.json"));
    assert.ok(!manifest.readRoots.includes("."));
    assert.deepEqual(manifest.writeRoots, []);
    assert.deepEqual(manifest.writePaths, [
      "src/core/ports/forge-host.ts",
      "src/adapters/github/github-client.ts",
    ]);
  });

  it("does not turn semantic claims into nonexistent filesystem roots", () => {
    const manifest = scopeManifestFor("issue-hints", { claims: ["main", "component:api", "src/core"], metadataRoots: ["package.json"] });
    assert.ok(manifest.readRoots.includes("src/core"));
    assert.ok(manifest.readRoots.includes("package.json"));
    assert.ok(!manifest.readRoots.includes("."));
    assert.ok(!manifest.readRoots.includes("main"));
    assert.ok(!manifest.readRoots.includes("component:api"));
  });

  it("derives bounded roots from globs without granting the repository root", () => {
    const manifest = scopeManifestFor("issue-hints", {
      affectedFiles: ["src/**/*.ts", "**/*.md", "../outside.ts", "/etc/passwd"],
      metadataRoots: ["package.json"],
    });
    assert.ok(manifest.readRoots.includes("src"));
    assert.ok(manifest.readRoots.includes("package.json"));
    assert.ok(!manifest.readRoots.includes("."));
    assert.ok(!manifest.readRoots.some((root) => root.includes("*")));
  });

  it("rejects globbed exact write paths", () => {
    assert.throws(
      () => scopeManifestFor("build-packet", { writePaths: ["src/**/*.ts"] }),
      /concrete repository-relative files/,
    );
  });

  it("keeps remediation line locations as exact writable files", () => {
    const manifest = scopeManifestFor("remediation", { writePaths: ["src/core/state.ts:42"] });
    assert.deepEqual(manifest.writePaths, ["src/core/state.ts"]);
    assert.deepEqual(manifest.writeRoots, []);
  });
});
