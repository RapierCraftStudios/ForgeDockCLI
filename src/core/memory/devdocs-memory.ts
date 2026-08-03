// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const MAX_NOTES = 500;
const MAX_NOTE_BYTES = 256 * 1024;

export interface DevdocsMemoryHit {
  path: string;
  title: string;
  score: number;
  summary: string;
  tags: string[];
  anchors: string[];
  links: string[];
  backlinks: string[];
}

interface Note extends Omit<DevdocsMemoryHit, "score" | "backlinks"> {
  searchText: string;
}

export function searchDevdocsMemory(input: {
  cwd: string;
  query: string;
  paths?: readonly string[];
  limit?: number;
  maxChars?: number;
}): DevdocsMemoryHit[] {
  const root = resolve(input.cwd, "devdocs");
  if (!existsSync(root)) return [];
  const notes = loadNotes(root);
  const backlinks = buildBacklinks(notes);
  const terms = tokenize(`${input.query} ${(input.paths ?? []).join(" ")}`);
  const normalizedPaths = (input.paths ?? []).map(normalizePath);
  const ranked = notes.map((note) => {
    let score = 0;
    for (const term of terms) {
      if (note.title.toLowerCase().includes(term)) score += 8;
      if (note.path.toLowerCase().includes(term)) score += 6;
      if (note.tags.some((tag) => tag.toLowerCase().includes(term))) score += 5;
      if (note.searchText.includes(term)) score += 1;
    }
    for (const path of normalizedPaths) {
      if (note.anchors.some((anchor) => pathsOverlap(anchor, path))) score += 20;
    }
    return { ...note, score, backlinks: backlinks.get(normalizeLink(note.path)) ?? [] };
  }).filter((note) => note.score > 0)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));

  const limit = Math.max(1, Math.min(input.limit ?? 6, 20));
  let remaining = Math.max(256, input.maxChars ?? 3_000);
  const hits: DevdocsMemoryHit[] = [];
  for (const note of ranked) {
    if (hits.length >= limit || remaining <= 0) break;
    const summary = note.summary.slice(0, remaining);
    remaining -= summary.length;
    hits.push({
      path: note.path,
      title: note.title,
      score: note.score,
      summary,
      tags: note.tags,
      anchors: note.anchors,
      links: note.links,
      backlinks: note.backlinks,
    });
  }
  return hits;
}

function loadNotes(root: string): Note[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (files.length >= MAX_NOTES) return;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md") && statSync(path).size <= MAX_NOTE_BYTES) files.push(path);
    }
  };
  visit(root);
  return files.map((path) => parseNote(root, path));
}

function parseNote(root: string, path: string): Note {
  const raw = readFileSync(path, "utf8");
  const relativePath = relative(root, path).replaceAll(sep, "/");
  const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] ?? "";
  const title = /^#\s+(.+)$/m.exec(raw)?.[1]?.trim() ?? relativePath.replace(/\.md$/i, "");
  const tags = parseList(frontmatter, "tags");
  const anchors = [parseScalar(frontmatter, "anchor"), ...parseList(frontmatter, "anchors")].filter((value): value is string => Boolean(value));
  const links = [...raw.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)].map((match) => normalizeLink(match[1] ?? ""));
  const body = raw.replace(/^---\s*\r?\n[\s\S]*?\r?\n---/, "").replace(/<!--[^]*?-->/g, "").trim();
  const summary = body.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith("#")).slice(0, 8).join(" ").replace(/\s+/g, " ").slice(0, 900);
  return {
    path: relativePath,
    title,
    summary,
    tags,
    anchors: anchors.map(normalizePath),
    links,
    searchText: `${title} ${relativePath} ${tags.join(" ")} ${anchors.join(" ")} ${body}`.toLowerCase().slice(0, 50_000),
  };
}

function buildBacklinks(notes: readonly Note[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const note of notes) {
    for (const link of note.links) result.set(link, [...(result.get(link) ?? []), note.path]);
  }
  return result;
}

function tokenize(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z0-9][a-z0-9._/-]{2,}/g) ?? [])].slice(0, 80);
}

function parseScalar(frontmatter: string, key: string): string | undefined {
  return new RegExp(`^${key}:\\s*["']?([^"'\\r\\n]+)`, "m").exec(frontmatter)?.[1]?.trim();
}

function parseList(frontmatter: string, key: string): string[] {
  const inline = new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]`, "m").exec(frontmatter)?.[1];
  if (inline !== undefined) return inline.split(",").map((value) => value.replace(/["']/g, "").trim()).filter(Boolean);
  const block = new RegExp(`^${key}:\\s*\\r?\\n((?:\\s+-\\s+[^\\r\\n]+\\r?\\n?)*)`, "m").exec(frontmatter)?.[1] ?? "";
  return [...block.matchAll(/^\s+-\s+["']?([^"'\r\n]+)/gm)].map((match) => match[1]?.trim()).filter((value): value is string => Boolean(value));
}

function normalizeLink(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^devdocs\//, "").replace(/\.md$/i, "").toLowerCase();
}

function normalizePath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "").toLowerCase();
}

function pathsOverlap(left: string, right: string): boolean {
  const a = normalizePath(left);
  const b = normalizePath(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
