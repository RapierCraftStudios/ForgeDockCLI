// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

let refreshPromise: Promise<boolean> | undefined;

/**
 * Refresh the configured ForgeDock GitHub App token once per controller
 * process. GitHub App installation tokens expire while long review/recovery
 * runs are still legitimately active; a 401 should be recoverable without
 * replaying semantic workflow phases.
 */
export async function refreshConfiguredGitHubApp(cwd: string): Promise<boolean> {
  if (refreshPromise) return refreshPromise;
  const pem = process.env.FORGEDOCK_APP_PEM;
  const script = resolve(cwd, "scripts", "refresh-bot-token.mjs");
  if (!pem || !existsSync(pem) || !existsSync(script)) return false;

  refreshPromise = Promise.resolve().then(() => {
    const result = spawnSync(process.execPath, [script, "--pem", pem], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 30_000,
      windowsHide: true,
      shell: false,
    });
    return result.status === 0 && !result.error;
  }).finally(() => {
    refreshPromise = undefined;
  });
  return refreshPromise;
}

export function isGitHubAuthenticationFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /bad credentials|http\s*401|unauthorized|authentication failed|not logged in/i.test(message);
}
