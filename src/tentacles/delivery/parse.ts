/**
 * Pure, deterministic extractors for the Delivery tentacle.
 *
 * No I/O, no LLM, no clock — every function here is a referentially-transparent
 * string/array transform so it can be unit-tested in isolation. The tentacle's
 * `run` orchestrates these against the artifacts it reads.
 */

/** A changed file classified by its role in a dbt project. */
export interface ChangedFile {
  path: string;
  category: ChangeCategory;
}

export type ChangeCategory =
  | "model"
  | "test"
  | "schema_yml"
  | "macro"
  | "seed"
  | "snapshot"
  | "doc"
  | "config"
  | "other";

/**
 * Classify a repo-relative path into a dbt-aware change category. Deterministic,
 * extension + path-segment based — never guesses from content.
 */
export function classifyChangedFile(p: string): ChangeCategory {
  const lower = p.toLowerCase();
  const base = lower.split("/").pop() ?? lower;

  // YAML schema/property files (model docs + tests live here in dbt).
  if (/\.ya?ml$/.test(base)) {
    if (/(^|\/)(dbt_project|packages|profiles)\.ya?ml$/.test(lower)) {
      return "config";
    }
    return "schema_yml";
  }
  const seg = `/${lower}/`; // normalize so leading segments match too
  if (seg.includes("/macros/") || base.endsWith(".macro.sql")) return "macro";
  if (seg.includes("/seeds/") || base.endsWith(".csv")) return "seed";
  if (seg.includes("/snapshots/")) return "snapshot";
  if (seg.includes("/tests/") || base.startsWith("test_")) return "test";
  if (base.endsWith(".sql")) return "model";
  if (base.endsWith(".md")) return "doc";
  if (/\.(json|toml|ini|cfg|txt)$/.test(base)) return "config";
  return "other";
}

/** Classify a flat list of paths, preserving input order. */
export function classifyChangedFiles(paths: string[]): ChangedFile[] {
  return paths
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => ({ path: p, category: classifyChangedFile(p) }));
}

/** Count files per category (stable, sorted by category name). */
export function summarizeCategories(
  files: ChangedFile[],
): Array<{ category: ChangeCategory; count: number }> {
  const counts = new Map<ChangeCategory, number>();
  for (const f of files) {
    counts.set(f.category, (counts.get(f.category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([category, count]) => ({ category, count }));
}

/**
 * Derive the set of dbt model names touched (sql models + their schema yml is
 * harder to attribute, so we only name actual model files). Deterministic.
 */
export function modelNames(files: ChangedFile[]): string[] {
  const names = files
    .filter((f) => f.category === "model")
    .map((f) => {
      const base = f.path.split("/").pop() ?? f.path;
      return base.replace(/\.sql$/i, "");
    });
  return dedupe(names);
}

/**
 * A coarse, deterministic read of a validation artifact. We DO NOT trust this to
 * be machine-structured; we scan for the conventional signals the validation
 * tentacle emits (and degrade to "unknown" when absent).
 */
export interface ValidationSignal {
  /** "pass" | "fail" | "unknown" — derived from explicit markers only. */
  status: "pass" | "fail" | "unknown";
  /** Lines that look like individual check results, for the evidence section. */
  evidenceLines: string[];
}

const PASS_MARKERS = [
  /\bbuild(s)?\s+clean/i,
  /\ball\s+tests?\s+pass/i,
  /\bvalidation\s+passed\b/i,
  /\bstatus:\s*pass/i,
  /\bgreen\b/i,
  /✅/,
];

const FAIL_MARKERS = [
  /\b\d+\s+failing\b/i,
  /\btest(s)?\s+failed\b/i,
  /\bvalidation\s+failed\b/i,
  /\bvalidation\s+blocked\b/i,
  /\bstatus:\s*fail/i,
  /\berror\b/i,
  // The validation tentacle's explicit blocking markers.
  /⛔\s*blocked/i,
  /\bblocking\s+failure/i,
  /\*\*done:\*\*\s*no\b/i,
  /❌/,
];

/**
 * Read validation status from a validation.md body. Conservative: only reports
 * pass/fail when an explicit marker is present; otherwise "unknown".
 *
 * The content is UNTRUSTED — callers must have neutralized it first. This only
 * does pattern detection over the already-defused text.
 */
export function readValidationSignal(body: string | null): ValidationSignal {
  if (!body || body.trim().length === 0) {
    return { status: "unknown", evidenceLines: [] };
  }
  const lines = body.split(/\r?\n/);
  const evidenceLines = lines
    .filter((l) => /(pass|fail|test|row count|✅|❌|error|clean)/i.test(l))
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, 20);

  const hasFail = FAIL_MARKERS.some((re) => re.test(body));
  const hasPass = PASS_MARKERS.some((re) => re.test(body));

  let status: ValidationSignal["status"] = "unknown";
  if (hasFail) status = "fail";
  else if (hasPass) status = "pass";

  return { status, evidenceLines };
}

/**
 * Extract bullet-ish lines from a markdown body under a heading whose text
 * matches `headingRe`. Returns the list items (stripped of markers). Pure.
 */
export function extractSectionItems(
  body: string | null,
  headingRe: RegExp,
): string[] {
  if (!body) return [];
  const lines = body.split(/\r?\n/);
  const items: string[] = [];
  let inSection = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const headingMatch = /^#{1,6}\s+(.*)$/.exec(line);
    if (headingMatch) {
      inSection = headingRe.test(headingMatch[1]!.trim());
      continue;
    }
    if (!inSection) continue;
    const itemMatch = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (itemMatch) {
      const text = stripListMarkers(itemMatch[1]!).trim();
      if (text) items.push(text);
    }
  }
  return items;
}

/** Strip leading checkbox / list residue like "[ ]", "[x]". */
function stripListMarkers(s: string): string {
  return s.replace(/^\[[ xX]\]\s*/, "");
}

/**
 * Suggest a deterministic branch name from a ticket id + a short slug of the
 * title. Lowercased, hyphenated, ascii-only. Never random.
 */
export function suggestBranchName(
  ticketId: string | null,
  title: string,
): string {
  const id = (ticketId ?? "oswald").trim();
  const slug = slug40(title);
  const idSlug = slug40(id);
  return slug ? `oswald/${idSlug}-${slug}` : `oswald/${idSlug}`;
}

function slug40(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/** A deterministic PR title from ticket id + title. */
export function suggestPrTitle(ticketId: string | null, title: string): string {
  const id = (ticketId ?? "").trim();
  const t = title.trim() || "dbt model changes";
  return id ? `[${id}] ${t}` : t;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
