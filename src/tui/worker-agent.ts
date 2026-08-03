// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export interface MaterializedWorkerAgent {
  directory: string;
  file: string;
  dispose(): void;
}

/**
 * Materialize the packaged worker definition with an absolute child-only
 * ForgeDock extension path. pi-subagents launches children from the target
 * repository, so a relative extension path would resolve against the wrong
 * project when ForgeDock is installed or invoked through npx.
 */
export function materializeWorkerAgent(templatePath: string, extensionPath: string, additionalTemplates: readonly string[] = []): MaterializedWorkerAgent {
  const source = readFileSync(templatePath, "utf8");
  const toolsLine = "tools: forgedock_work_on, subagent, contact_supervisor";
  if (!source.includes(toolsLine)) throw new Error(`Worker agent template is missing '${toolsLine}'`);
  const directory = mkdtempSync(join(tmpdir(), "forgedock-worker-agent-"));
  const file = join(directory, basename(templatePath));
  const rendered = source.replace(
    toolsLine,
    `${toolsLine}\nsubagentOnlyExtensions: ${JSON.stringify(extensionPath)}`,
  );
  writeFileSync(file, rendered, "utf8");
  for (const template of additionalTemplates) {
    writeFileSync(join(directory, basename(template)), readFileSync(template, "utf8"), "utf8");
  }
  return {
    directory,
    file,
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}
