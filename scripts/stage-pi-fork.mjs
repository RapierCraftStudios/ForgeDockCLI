#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fork = join(root, "vendor", "pi");
const source = join(fork, "packages", "coding-agent");
const target = join(root, "vendor", "pi-runtime");

if (!existsSync(join(source, "dist", "cli.js"))) {
  throw new Error("The ForgeDock Pi fork has not been built. Run `npm run build:pi` first.");
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const path of ["dist", "docs", "examples", "README.md", "CHANGELOG.md", "containerization.md"]) {
  const from = join(source, path);
  if (existsSync(from)) cpSync(from, join(target, path), { recursive: true });
}
cpSync(join(fork, "LICENSE"), join(target, "LICENSE"));

const packageJson = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
packageJson.private = true;
// The pinned fork release declared undici 8.5.0 exactly. Stage the patched
// compatible release so packaged terminals do not ship known GHSA findings.
if (packageJson.dependencies?.undici) packageJson.dependencies.undici = "8.10.0";
delete packageJson.devDependencies;
delete packageJson.scripts;
writeFileSync(join(target, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
writeFileSync(join(target, "FORGEDOCK-NOTICE.md"), `# ForgeDock Pi runtime\n\nGenerated from the MIT-licensed source fork pinned at \`vendor/pi\`. Do not edit this directory directly; run \`npm run stage:pi\`. Fork policy and provenance are documented in \`vendor/pi/FORGEDOCK.md\`.\n`);
console.log(`Staged ForgeDock Pi runtime at ${target}`);
