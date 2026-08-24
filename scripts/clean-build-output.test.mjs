#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { cleanBuildOutput } from "./clean-build-output.mjs";

test("cleanBuildOutput removes only the root dist output", (t) => {
  const root = join(tmpdir(), `forgedock-build-clean-${process.pid}-${Date.now()}`);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const staleTest = join(root, "dist", "stale", "old.test.js");
  const sourceFile = join(root, "src", "keep.ts");
  const vendorFile = join(root, "vendor", "pi", "dist", "keep.js");
  const unrelatedFile = join(root, "unrelated", "dist", "keep.test.js");
  mkdirSync(join(root, "dist", "stale"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "vendor", "pi", "dist"), { recursive: true });
  mkdirSync(join(root, "unrelated", "dist"), { recursive: true });
  writeFileSync(staleTest, "stale compiled test\n");
  writeFileSync(sourceFile, "export const source = true;\n");
  writeFileSync(vendorFile, "vendor output\n");
  writeFileSync(unrelatedFile, "unrelated output\n");

  cleanBuildOutput(root);

  assert.equal(existsSync(staleTest), false, "stale root dist test must be removed");
  assert.equal(existsSync(join(root, "dist")), false, "the complete root dist output must be removed");
  assert.equal(readFileSync(sourceFile, "utf8"), "export const source = true;\n");
  assert.equal(readFileSync(vendorFile, "utf8"), "vendor output\n");
  assert.equal(readFileSync(unrelatedFile, "utf8"), "unrelated output\n");
});
