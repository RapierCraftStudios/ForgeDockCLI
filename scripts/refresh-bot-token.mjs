#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ID = "4051319";
const ORG_INSTALLATION_ID = "144998831";
const PERSONAL_INSTALLATION_ID = "140233364";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const parsed = parseArgs(process.argv.slice(2));
const pemPath = parsed.pem ?? process.env.FORGEDOCK_APP_PEM ?? resolve(packageRoot, "secrets", "rapiercraft-forgedock.pem");
const installationId = parsed.personal ? PERSONAL_INSTALLATION_ID : ORG_INSTALLATION_ID;

if (!existsSync(pemPath)) {
  fail(`Private key not found at ${pemPath}\n  Set FORGEDOCK_APP_PEM or pass --pem /path/to/key.pem`);
}

const jwt = createJwt(readFileSync(pemPath, "utf8"), APP_ID);
const response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${jwt}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "forgedock-refresh",
    "X-GitHub-Api-Version": "2022-11-28",
  },
});
const body = await response.json().catch(() => ({}));
const token = typeof body.token === "string" ? body.token : undefined;
if (!response.ok || !token) {
  const message = typeof body.message === "string" ? body.message : `HTTP ${response.status}`;
  fail(`GitHub App token exchange failed: ${message}`);
}

const login = spawnSync("gh", ["auth", "login", "--hostname", "github.com", "--with-token"], {
  input: `${token}\n`,
  encoding: "utf8",
  windowsHide: true,
  shell: false,
});
if (login.error) fail(`Unable to start gh: ${login.error.message}`);
if (login.status !== 0) fail((login.stderr || login.stdout || "gh auth login failed").trim());

const status = spawnSync("gh", ["auth", "status", "--hostname", "github.com"], {
  encoding: "utf8",
  windowsHide: true,
  shell: false,
});
if (`${status.stdout ?? ""}\n${status.stderr ?? ""}`.includes("rapiercraft-forge[bot]")) {
  spawnSync("gh", ["auth", "logout", "--hostname", "github.com", "--user", "rapiercraft-forge[bot]"], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
}

console.log(`rapiercraft-forgedock[bot] token refreshed — ${parsed.personal ? "personal (RapierCraft)" : "org (RapierCraftStudios)"} ~1h`);

function parseArgs(args) {
  let pem;
  let personal = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--pem") {
      pem = args[++index];
      if (!pem) fail("--pem requires a path");
    } else if (arg === "--personal") {
      personal = true;
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }
  return { pem, personal };
}

function createJwt(pem, appId) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId })).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(pem, "base64url")}`;
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}
