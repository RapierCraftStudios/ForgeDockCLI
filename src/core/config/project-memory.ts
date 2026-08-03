// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const PREFERENCES_START = "<!-- FORGEDOCK:PREFERENCES:START -->";
const PREFERENCES_END = "<!-- FORGEDOCK:PREFERENCES:END -->";
const MAX_GUIDANCE_BYTES = 64 * 1024;

export function loadForgeGuidance(cwd: string): Array<{ path: string; content: string }> {
  const directories: string[] = [];
  let current = resolve(cwd);
  while (true) {
    directories.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  let remaining = MAX_GUIDANCE_BYTES;
  const files: Array<{ path: string; content: string }> = [];
  for (const directory of directories) {
    const path = join(directory, "FORGE.md");
    if (!existsSync(path) || remaining <= 0) continue;
    const content = readFileSync(path, "utf8").slice(0, remaining);
    remaining -= Buffer.byteLength(content);
    files.push({ path, content });
  }
  return files;
}

export function appendProjectPreference(cwd: string, preference: string): { path: string; added: boolean } {
  const normalized = normalizeLine(preference);
  if (!normalized) throw new Error("Preference must not be empty");
  const path = join(cwd, "FORGE.md");
  const existing = existsSync(path)
    ? readFileSync(path, "utf8")
    : "# ForgeDock project guidance\n\nThis file stores durable project preferences loaded by the ForgeDock terminal and typed workflow agents.\n";
  const start = existing.indexOf(PREFERENCES_START);
  const end = existing.indexOf(PREFERENCES_END);
  let preferences: string[] = [];
  if (start >= 0 || end >= 0) {
    if (start < 0 || end < start) throw new Error("FORGE.md contains an incomplete managed preferences block");
    preferences = existing.slice(start + PREFERENCES_START.length, end)
      .split(/\r?\n/)
      .map((line) => /^-\s+(.+)$/.exec(line)?.[1]?.trim())
      .filter((line): line is string => Boolean(line));
  }
  if (preferences.some((value) => value.toLowerCase() === normalized.toLowerCase())) return { path, added: false };
  preferences.push(normalized);
  const block = [PREFERENCES_START, "## Agentic preferences", ...preferences.map((value) => `- ${value}`), PREFERENCES_END].join("\n");
  const next = start >= 0
    ? `${existing.slice(0, start)}${block}${existing.slice(end + PREFERENCES_END.length)}`
    : `${existing.trimEnd()}\n\n${block}\n`;
  atomicWrite(path, next);
  return { path, added: true };
}

export function recordProjectDecision(input: {
  cwd: string;
  title: string;
  context: string;
  decision: string;
  consequences: readonly string[];
}): { path: string } {
  const title = normalizeLine(input.title);
  if (!title) throw new Error("Decision title must not be empty");
  const directory = join(input.cwd, "devdocs", "decisions");
  mkdirSync(directory, { recursive: true });
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "decision";
  let path = join(directory, `${date}-${slug}.md`);
  for (let suffix = 2; existsSync(path); suffix++) path = join(directory, `${date}-${slug}-${suffix}.md`);
  const content = [
    "---",
    "type: decision",
    "status: accepted",
    `created: ${new Date().toISOString().slice(0, 10)}`,
    "tags: [decision, forgedock-memory]",
    "---",
    "<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->",
    "<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->",
    "",
    `# ${title}`,
    "",
    "## Context",
    "",
    input.context.trim(),
    "",
    "## Decision",
    "",
    input.decision.trim(),
    "",
    "## Consequences",
    "",
    ...(input.consequences.length ? input.consequences.map((value) => `- ${normalizeLine(value)}`) : ["- None recorded."]),
    "",
  ].join("\n");
  atomicWrite(path, content);
  return { path };
}

function atomicWrite(path: string, content: string): void {
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function normalizeLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}
