// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join as pathJoin, relative } from "node:path";
import { canonicalRelationPath, digestRelation, fileNodeId, nodeId, type RelationEdge, type RelationGraphLimits, type RelationNode } from "../../core/packet/relation-graph.js";

export interface RepositoryFactSet { adapterId: string; nodes: RelationNode[]; edges: RelationEdge[]; files: string[]; targets: string[]; }
export interface RepositoryAdapterContext { cwd: string; limits: RelationGraphLimits; configuredTargets?: readonly string[]; }
export interface RepositoryAdapter { readonly id: string; readonly languages: readonly string[]; inspect(context: RepositoryAdapterContext): Promise<RepositoryFactSet>; }

const SKIP = new Set([".git", "node_modules", "dist", "build", "target", ".venv", "vendor", ".next", "coverage"]);
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".py", ".go", ".rs", ".java", ".kt", ".kts", ".scala", ".groovy"]);
const TEST_RE = /(?:^|[._-])(?:test|tests|spec|specs)(?:[._-]|\/)/i;
const GENERATED_RE = /(?:^|\/)(?:generated|gen|codegen|out|build)(?:\/|$)|\.generated\./i;
const MANIFESTS = new Set(["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "tsconfig.json", "pyproject.toml", "setup.py", "requirements.txt", "Pipfile", "poetry.lock", "go.mod", "go.sum", "go.work", "Cargo.toml", "Cargo.lock", "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradle.properties"]);

export const LANGUAGE_PROFILES = {
  javascript: { extensions: new Set([".js", ".jsx", ".mjs", ".cjs"]), manifests: new Set(["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]) },
  typescript: { extensions: new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]), manifests: new Set(["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "tsconfig.json"]) },
  python: { extensions: new Set([".py", ".pyi"]), manifests: new Set(["pyproject.toml", "setup.py", "requirements.txt", "Pipfile", "poetry.lock"]) },
  go: { extensions: new Set([".go"]), manifests: new Set(["go.mod", "go.sum", "go.work"]) },
  rust: { extensions: new Set([".rs"]), manifests: new Set(["Cargo.toml", "Cargo.lock"]) },
  jvm: { extensions: new Set([".java", ".kt", ".kts", ".scala", ".groovy"]), manifests: new Set(["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradle.properties"]) },
  monorepo: { extensions: SOURCE_EXTENSIONS, manifests: MANIFESTS },
  generated: { extensions: SOURCE_EXTENSIONS, manifests: MANIFESTS },
} as const;

export class BoundedRepositoryAdapter implements RepositoryAdapter {
  readonly manifests: ReadonlySet<string>;
  constructor(readonly id: string, readonly languages: readonly string[], readonly extensions: ReadonlySet<string> = SOURCE_EXTENSIONS, manifests: ReadonlySet<string> = MANIFESTS) { this.manifests = manifests; }

  async inspect(context: RepositoryAdapterContext): Promise<RepositoryFactSet> {
    const files = await boundedFiles(context.cwd, context.limits.maxFiles, context.limits.maxBytes);
    const accepted = files.filter((path) => this.extensions.has(ext(path)) || this.manifests.has(path.split("/").at(-1) ?? ""));
    const nodes: RelationNode[] = [];
    const edges: RelationEdge[] = [];
    const known = new Set(accepted);
    for (const path of accepted) {
      const kind = this.manifests.has(path.split("/").at(-1) ?? "") ? "config" : GENERATED_RE.test(path) ? "generated" : TEST_RE.test(path) ? "test" : "file";
      const digest = await fileDigest(pathJoin(context.cwd, path));
      nodes.push({ id: fileNodeId(path), kind, identity: path, ...(digest ? { digest } : {}) });
      if (this.manifests.has(path.split("/").at(-1) ?? "")) nodes.push({ id: nodeId("config", path), kind: "config", identity: path, ...(digest ? { digest } : {}) });
      const text = await safeRead(pathJoin(context.cwd, path), context.limits.maxBytes);
      for (const target of referencedPaths(path, text, known, this.id)) {
        edges.push(makeEdge(this.id, fileNodeId(path), fileNodeId(target), "import", path, target, text));
      }
      if (kind === "test") {
        const stem = basename(path).replace(/\.(?:test|spec)s?\b/i, "").replace(/\.[^.]+$/, "").toLowerCase();
        for (const candidate of accepted.filter((other) => other !== path && !TEST_RE.test(other)
          && ext(other) === ext(path) && basename(other).toLowerCase().startsWith(stem)).slice(0, 16)) {
          edges.push(makeEdge(this.id, fileNodeId(path), fileNodeId(candidate), "test-covers", path, candidate, `${path}:${candidate}`));
        }
      }
      if (GENERATED_RE.test(path)) {
        const source = accepted.find((candidate) => !GENERATED_RE.test(candidate) && basename(candidate).toLowerCase().includes(basename(path).replace(/\.generated\./i, ".").split(".")[0]?.toLowerCase() ?? "_"));
        if (source) edges.push(makeEdge(this.id, fileNodeId(path), fileNodeId(source), "generated-by", path, source, `${path}:${source}`));
      }
    }
    const targets = context.configuredTargets ? [...context.configuredTargets].map(canonicalRelationPath).filter((path) => known.has(path)).sort() : [];
    return { adapterId: this.id, nodes: dedupeNodes(nodes), edges: dedupeEdges(edges), files: accepted, targets };
  }
}

export class ConfiguredRepositoryAdapter extends BoundedRepositoryAdapter {
  constructor(id = "configured", languages: readonly string[] = ["configured"], private readonly targetPaths: readonly string[] = [], extensions: ReadonlySet<string> = SOURCE_EXTENSIONS, manifests: ReadonlySet<string> = MANIFESTS) { super(id, languages, extensions, manifests); }
  override inspect(context: RepositoryAdapterContext): Promise<RepositoryFactSet> { return super.inspect({ ...context, configuredTargets: this.targetPaths }); }
}

export class NoTargetRepositoryAdapter implements RepositoryAdapter {
  readonly id = "no-target";
  readonly languages = ["none"] as const;
  async inspect(_context: RepositoryAdapterContext): Promise<RepositoryFactSet> { return { adapterId: this.id, nodes: [], edges: [], files: [], targets: [] }; }
}

export class UnsupportedRepositoryLayoutError extends Error {
  constructor(readonly layout: string) { super(`Unsupported or ambiguous repository layout '${layout}'`); this.name = "UnsupportedRepositoryLayoutError"; }
}

export class ConfiguredTargetRunner extends ConfiguredRepositoryAdapter {}

export class NoTargetRunner extends NoTargetRepositoryAdapter {}

export function adapterForLanguage(language: string): RepositoryAdapter {
  const normalized = language.trim().toLowerCase();
  if (!normalized || normalized === "none" || normalized === "no-target") return new NoTargetRepositoryAdapter();
  const aliases: Record<string, [string, string[]]> = {
    javascript: ["javascript", ["javascript"]], js: ["javascript", ["javascript"]], typescript: ["typescript", ["typescript", "javascript"]], ts: ["typescript", ["typescript", "javascript"]],
    python: ["python", ["python"]], go: ["go", ["go"]], rust: ["rust", ["rust"]], jvm: ["jvm", ["jvm"]], java: ["jvm", ["jvm"]], kotlin: ["jvm", ["jvm"]],
    monorepo: ["monorepo", ["monorepo"]], generated: ["generated", ["generated"]],
  };
  if (!aliases[normalized]) throw new UnsupportedRepositoryLayoutError(normalized);
  const [id, languages] = aliases[normalized];
  const profile = LANGUAGE_PROFILES[id as keyof typeof LANGUAGE_PROFILES] ?? LANGUAGE_PROFILES.monorepo;
  return new BoundedRepositoryAdapter(id, languages, profile.extensions, profile.manifests);
}

export function repositoryAdaptersFor(languages: readonly string[], configuredTargets: readonly string[] = []): RepositoryAdapter[] {
  if (configuredTargets.length) return [new ConfiguredRepositoryAdapter("configured", languages, configuredTargets)];
  const unique = [...new Set(languages.map((language) => language.trim().toLowerCase()).filter(Boolean))];
  if (unique.length > 1 && !unique.includes("monorepo")) throw new UnsupportedRepositoryLayoutError(`ambiguous:${unique.join(",")}`);
  return unique.length ? unique.map(adapterForLanguage) : [new NoTargetRepositoryAdapter()];
}

async function boundedFiles(root: string, maxFiles: number, maxBytes: number): Promise<string[]> {
  const result: string[] = []; let bytes = 0;
  async function visit(directory: string): Promise<void> {
    if (result.length >= maxFiles || bytes >= maxBytes) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (result.length >= maxFiles || bytes >= maxBytes) return;
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      if (entry.isDirectory()) { if (!SKIP.has(entry.name)) await visit(pathJoin(directory, entry.name)); continue; }
      const path = canonicalRelationPath(relative(root, pathJoin(directory, entry.name)));
      if (!SOURCE_EXTENSIONS.has(ext(path)) && !MANIFESTS.has(entry.name)) continue;
      try { const stat = await import("node:fs/promises").then(({ stat }) => stat(pathJoin(directory, entry.name))); bytes += stat.size; } catch { /* read failures are non-authoritative */ }
      result.push(path);
    }
  }
  await visit(root); return result;
}

async function safeRead(path: string, maxBytes: number): Promise<string> { try { return (await readFile(path, "utf8")).slice(0, maxBytes); } catch { return ""; } }
async function fileDigest(path: string): Promise<string | undefined> { try { return createHash("sha256").update(await readFile(path)).digest("hex"); } catch { return undefined; } }
function ext(path: string): string { const index = path.lastIndexOf("."); return index < 0 ? "" : path.slice(index).toLowerCase(); }
function basename(path: string): string { return path.split("/").at(-1) ?? path; }
function referencedPaths(source: string, text: string, known: Set<string>, adapterId = "monorepo"): string[] {
  const found = new Set<string>();
  const patterns = [/(?:from|import)\s*["']([^"']+)["']/g, /require\s*\(\s*["']([^"']+)["']\s*\)/g, /(?:import|include)\s*["']([^"']+)["']/g];
  if (adapterId === "python") patterns.push(/from\s+([.A-Za-z0-9_]+)\s+import/g);
  if (adapterId === "rust") patterns.push(/(?:mod|use\s+crate::)\s*([A-Za-z0-9_:]+)/g);
  if (adapterId === "go") patterns.push(/import\s+\(?\s*["']([^"']+)["']/g);
  if (adapterId === "jvm") patterns.push(/(?:import|package)\s+([A-Za-z0-9_.]+)/g);
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) {
    const raw = match[1]; if (!raw || (!raw.startsWith(".") && !raw.includes("/") && adapterId !== "rust" && adapterId !== "jvm")) continue;
    const base = raw.startsWith(".") ? join(source.split("/").slice(0, -1).join("/"), raw) : raw.replaceAll("::", "/").replaceAll(".", "/");
    const normalized = base.replaceAll("\\", "/").replace(/^\.\//, "");
    const suffixes = ["", ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", "/index.ts", "/mod.rs"];
    for (const candidate of suffixes.map((suffix) => `${normalized}${suffix}`)) if (known.has(candidate)) found.add(candidate);
    if ((adapterId === "go" || adapterId === "jvm") && !found.size) {
      for (const candidate of known) if (candidate.replace(/\\.(?:go|java|kt|scala|groovy)$/i, "").endsWith(normalized)) found.add(candidate);
    }
  }
  return [...found].sort();
}
function makeEdge(adapterId: string, sourceId: string, targetId: string, kind: RelationEdge["kind"], sourcePath: string, targetPath: string, evidence: string): RelationEdge {
  return { id: `${adapterId}:${kind}:${sourcePath}:${targetPath}`, sourceId, targetId, kind, adapterId, provenance: "repository", sourcePath, targetPath, evidenceDigest: digestRelation(evidence) };
}
function dedupeNodes(nodes: RelationNode[]): RelationNode[] { return [...new Map(nodes.map((node) => [node.id, node])).values()].sort((a, b) => a.id.localeCompare(b.id)); }
function dedupeEdges(edges: RelationEdge[]): RelationEdge[] { return [...new Map(edges.map((edge) => [edge.id, edge])).values()].sort((a, b) => a.id.localeCompare(b.id)); }
function join(root: string, path: string): string { return `${root.replace(/\/$/, "")}/${path}`; }
