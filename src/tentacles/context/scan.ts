/**
 * Deterministic context-gathering heuristics.
 *
 * Pure functions + a read-only local filesystem walker that discover existing
 * dbt/SQL/YAML/doc assets so the pipeline does not rebuild what already exists.
 * No LLM, no network. The walker is read-only (it never mutates the repo) and is
 * bounded (depth + file-count caps) so it stays fast and safe on large repos.
 *
 * IMPORTANT: file CONTENT discovered here is untrusted external evidence — the
 * caller wraps it via the sanitizer before persisting and treats it as data, not
 * instructions. This module only reads structure and surfaces references.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";

/** A discovered repository asset (model, test, macro, doc, ...). */
export interface DiscoveredAsset {
  /** Path relative to the scan root (POSIX separators, deterministic). */
  relPath: string;
  /** Coarse classification used for grouping in the artifacts. */
  kind: AssetKind;
  /** dbt resource name derived from the filename, when applicable. */
  name?: string;
  /** dbt layer inferred from a name prefix (stg/int/fct/dim/mart/rpt). */
  layer?: string;
}

export type AssetKind =
  | "dbt_model"
  | "dbt_test"
  | "dbt_schema_yml"
  | "sql"
  | "macro"
  | "doc"
  | "dbt_project";

/** Directories never worth walking (deterministic skip list). */
const IGNORED_DIRS = new Set([
  ".git",
  ".oswald",
  "node_modules",
  "target",
  "dbt_packages",
  "logs",
  ".venv",
  "venv",
  "__pycache__",
  ".idea",
  ".vscode",
  "dist",
  "build",
]);

export interface WalkOptions {
  /** Max directory depth to descend (root = depth 0). */
  maxDepth?: number;
  /** Hard cap on number of files returned (protects against huge repos). */
  maxFiles?: number;
}

const DEFAULT_WALK: Required<WalkOptions> = { maxDepth: 8, maxFiles: 2000 };

/**
 * Recursively list candidate files under `root` (read-only, bounded).
 * Returns POSIX-relative paths sorted for deterministic output. Missing or
 * unreadable directories yield an empty list rather than throwing.
 */
export async function walkRepo(
  root: string,
  options: WalkOptions = {},
): Promise<string[]> {
  const maxDepth = options.maxDepth ?? DEFAULT_WALK.maxDepth;
  const maxFiles = options.maxFiles ?? DEFAULT_WALK.maxFiles;
  const out: string[] = [];

  async function recurse(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth || out.length >= maxFiles) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Sort entries for deterministic traversal order.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (entry.name.startsWith(".") && entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
      }
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await recurse(abs, depth + 1);
      } else if (entry.isFile()) {
        out.push(path.relative(root, abs).split(path.sep).join("/"));
      }
    }
  }

  await recurse(root, 0);
  out.sort((a, b) => a.localeCompare(b));
  return out.slice(0, maxFiles);
}

const DBT_LAYER_RE = /^(stg|int|fct|dim|mart|rpt|base)_/i;

/** Infer a dbt layer from a model name prefix, if present. */
export function inferLayer(name: string): string | undefined {
  const m = name.match(DBT_LAYER_RE);
  return m ? m[1]!.toLowerCase() : undefined;
}

/** Classify a single relative path into a {@link DiscoveredAsset}. */
export function classifyFile(relPath: string): DiscoveredAsset | null {
  const base = relPath.split("/").pop() ?? relPath;
  const lower = base.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : "";
  const stem = base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base;
  const inMacros = /(^|\/)macros\//.test(relPath);

  if (lower === "dbt_project.yml") {
    return { relPath, kind: "dbt_project" };
  }

  if (ext === ".sql") {
    if (inMacros) {
      return { relPath, kind: "macro", name: stem };
    }
    const layer = inferLayer(stem);
    const asset: DiscoveredAsset = { relPath, kind: "dbt_model", name: stem };
    if (layer) asset.layer = layer;
    return asset;
  }

  if (ext === ".yml" || ext === ".yaml") {
    // schema.yml / *.yml inside a models tree → dbt schema/test definitions.
    if (lower === "schema.yml" || lower === "schema.yaml" || /(^|\/)models\//.test(relPath)) {
      return { relPath, kind: "dbt_schema_yml", name: stem };
    }
    return { relPath, kind: "dbt_schema_yml", name: stem };
  }

  if (ext === ".md" || ext === ".markdown" || ext === ".rst" || ext === ".txt") {
    // Skip Oswald's own artifacts (already excluded by dir, but be safe).
    return { relPath, kind: "doc", name: stem };
  }

  return null;
}

/** Classify a list of relative paths, dropping unrecognized files. */
export function classifyAssets(relPaths: string[]): DiscoveredAsset[] {
  const assets: DiscoveredAsset[] = [];
  for (const p of relPaths) {
    const a = classifyFile(p);
    if (a) assets.push(a);
  }
  return assets;
}

// ---------------------------------------------------------------------------
// Source / table reference extraction (untrusted text → structured candidates)
// ---------------------------------------------------------------------------

/** A candidate source/table reference discovered in text. */
export interface SourceRef {
  /** The normalized reference (e.g. `salesforce.accounts`, `stg_orders`). */
  ref: string;
  /** How it was found: a dbt `source()`/`ref()` call, or a bare identifier. */
  via: "source" | "ref" | "schema_table" | "model_name";
}

/**
 * Extract dbt `source('x','y')` / `ref('z')` calls and schema.table
 * identifiers from arbitrary (untrusted) SQL/text. Deterministic + read-only.
 */
export function extractSourceRefs(text: string): SourceRef[] {
  const found = new Map<string, SourceRef>();
  const add = (ref: string, via: SourceRef["via"]): void => {
    const key = ref.toLowerCase();
    if (!found.has(key)) found.set(key, { ref: key, via });
  };

  // {{ source('schema', 'table') }}
  for (const m of text.matchAll(
    /source\(\s*['"]([\w.-]+)['"]\s*,\s*['"]([\w.-]+)['"]\s*\)/gi,
  )) {
    add(`${m[1]}.${m[2]}`, "source");
  }
  // {{ ref('model') }} or ref('package','model')
  for (const m of text.matchAll(
    /ref\(\s*['"]([\w.-]+)['"]\s*(?:,\s*['"]([\w.-]+)['"]\s*)?\)/gi,
  )) {
    add(m[2] ? m[2]! : m[1]!, "ref");
  }
  // bare schema.table identifiers (FROM/JOIN clauses, lowercase heuristic)
  for (const m of text.matchAll(
    /\b(?:from|join)\s+([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\b/gi,
  )) {
    add(m[1]!, "schema_table");
  }
  return [...found.values()];
}

// ---------------------------------------------------------------------------
// Metric / owner discovery from dbt YAML (heuristic, no YAML parse dependency)
// ---------------------------------------------------------------------------

/** A metric/measure-like definition discovered in YAML text. */
export interface MetricRef {
  name: string;
  /** Where it was found (relative path). */
  source: string;
}

/**
 * Find metric/measure-like names in dbt YAML text. Heuristic line scan for
 * `- name:` entries under a `metrics:`/`measures:`/`semantic_models:` block.
 * Deterministic; does not need a YAML parser.
 */
export function extractMetricNames(yamlText: string): string[] {
  const names = new Set<string>();
  const lines = yamlText.split(/\r?\n/);
  let inMetricBlock = false;
  let blockIndent = -1;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (/^(metrics|measures):\s*$/.test(trimmed)) {
      inMetricBlock = true;
      blockIndent = indent;
      continue;
    }
    if (inMetricBlock) {
      // Left the block: a new top-level-or-shallower key appeared.
      if (trimmed && indent <= blockIndent && !trimmed.startsWith("-")) {
        inMetricBlock = false;
        continue;
      }
      const m = trimmed.match(/^-?\s*name:\s*['"]?([\w.-]+)['"]?/);
      if (m) names.add(m[1]!);
    }
  }
  return [...names];
}

/** Find owner/maintainer references in dbt YAML/meta text (heuristic). */
export function extractOwners(yamlText: string): string[] {
  const owners = new Set<string>();
  for (const m of yamlText.matchAll(
    /\b(?:owner|maintainer|team)\s*:\s*['"]?([^\n'"#]+?)['"]?\s*$/gim,
  )) {
    const v = m[1]!.trim();
    if (v && v !== "{}" && v !== "[]") owners.add(v);
  }
  for (const m of yamlText.matchAll(/@([a-z0-9_.-]+)/gi)) {
    owners.add(`@${m[1]}`);
  }
  return [...owners];
}

// ---------------------------------------------------------------------------
// Similarity scoring (find prior/similar work)
// ---------------------------------------------------------------------------

/** Tokenize a string into lowercase word tokens (deterministic). */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
}

/**
 * Score a candidate name against a set of query tokens by token overlap.
 * Returns a 0..1 fraction of query tokens matched. Deterministic.
 */
export function similarityScore(
  candidateName: string,
  queryTokens: string[],
): number {
  if (queryTokens.length === 0) return 0;
  const candTokens = new Set(tokenize(candidateName));
  let hits = 0;
  for (const q of queryTokens) {
    if (candTokens.has(q)) hits++;
  }
  return Math.round((hits / queryTokens.length) * 100) / 100;
}

/** A ranked similar asset. */
export interface SimilarAsset {
  asset: DiscoveredAsset;
  score: number;
}

/** Rank discovered assets by similarity to the query tokens (desc, stable). */
export function rankSimilar(
  assets: DiscoveredAsset[],
  queryTokens: string[],
  limit = 10,
): SimilarAsset[] {
  const scored = assets
    .filter((a) => a.kind === "dbt_model" || a.kind === "sql")
    .map((a) => ({ asset: a, score: similarityScore(a.name ?? a.relPath, queryTokens) }))
    .filter((s) => s.score > 0);
  scored.sort(
    (a, b) => b.score - a.score || a.asset.relPath.localeCompare(b.asset.relPath),
  );
  return scored.slice(0, limit);
}
