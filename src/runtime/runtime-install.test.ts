// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertRuntimeDispatcherLoad, assertRuntimeInstall, assertRuntimeInstallAsync, RuntimeInstallError } from "./runtime-install.js";

test("runtime preflight resolves the staged Pi dispatcher and its complete HTTP dependency", () => {
  const runtime = assertRuntimeInstall();
  assert.match(runtime.runtimeEntry, /[\\/]dist[\\/]index\.js$/);
  assert.match(runtime.dispatcherEntry, /[\\/]dist[\\/]core[\\/]http-dispatcher\.js$/);
  assert.match(runtime.undiciEntry, /[\\/]undici[\\/]index\.js$/);
  assert.equal(runtime.undiciVersion, "8.10.0");
});

test("runtime preflight also smoke-loads the dispatcher", async () => {
  const runtime = await assertRuntimeInstallAsync();
  assert.equal(runtime.undiciVersion, "8.10.0");
});

test("runtime preflight rejects a truncated transitive HTTP dependency", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgedock-runtime-truncated-"));
  try {
    const packageRoot = join(root, "node_modules", "undici");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "undici", main: "index.js" }));
    await writeFile(join(packageRoot, "index.js"), "export const dispatcher = {\n");
    const dispatcher = join(root, "dispatcher.mjs");
    await writeFile(dispatcher, 'import "undici";\n');

    await assert.rejects(
      assertRuntimeDispatcherLoad(dispatcher),
      (error: unknown) => error instanceof RuntimeInstallError
        && error.code === "FORGEDOCK_RUNTIME_INSTALL_INCOMPLETE"
        && error.message.includes("cannot be loaded"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime installation errors are distinguishable from issue and command failures", () => {
  const error = new RuntimeInstallError("missing runtime entry");
  assert.equal(error.name, "RuntimeInstallError");
  assert.equal(error.code, "FORGEDOCK_RUNTIME_INSTALL_INCOMPLETE");
});
