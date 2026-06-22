/**
 * Map dbt test nodes/results to Oswald's logical-check taxonomy.
 *
 * Pure, deterministic functions (no I/O). dbt generic tests surface in
 * `run_results.json` / `manifest.json` with names like:
 *   - unique_stg_crm_customers_customer_id
 *   - not_null_stg_crm_customers_customer_id
 *   - accepted_values_fct_customer_retention_retention_status__active__churned
 *   - relationships_fct_customer_retention_customer_id__customer_id__ref_...
 *   - source_not_null_..., dbt_utils_unique_combination_of_columns_...
 * Singular (custom SQL) tests have arbitrary names; we classify those by
 * keyword and otherwise fall back to "other".
 */
import type { DbtCheckKind } from "./types.js";

/**
 * Ordered (pattern, kind) rules; first match wins. Most-specific first.
 *
 * dbt test names are `_`-delimited (e.g. "not_null_stg_x_id"), and JS `\b`
 * treats `_` as a word char — so we anchor on `_`-or-edge boundaries, NOT `\b`.
 */
const NAME_RULES: Array<{ re: RegExp; kind: DbtCheckKind }> = [
  // dbt_utils.unique_combination_of_columns → a uniqueness/grain check
  { re: /unique_combination_of_columns/i, kind: "unique" },
  { re: /(^|_)accepted_values(_|$)/i, kind: "accepted_values" },
  { re: /(^|_)relationships?(_|$)/i, kind: "relationships" },
  { re: /(^|_)not_null(_|$)/i, kind: "not_null" },
  { re: /(^|_)unique(_|$)/i, kind: "unique" },
  // freshness shows up as a source-freshness result or a named test
  { re: /(^|_)freshness(_|$)/i, kind: "freshness" },
  // row-count style singular tests / dbt_utils.equal_rowcount / cardinality
  {
    re: /(^|_)(row_?count|equal_rowcount|fewer_rows_than|cardinality)(_|$)/i,
    kind: "row_count",
  },
];

/**
 * Classify a dbt test by its node name and (optional) `test_metadata.name`
 * (the generic-test macro name, the most reliable signal when available).
 */
export function classifyDbtTest(
  nodeName: string,
  testMetadataName?: string,
): DbtCheckKind {
  // The generic-test macro name is authoritative when present.
  if (testMetadataName) {
    const meta = testMetadataName.toLowerCase();
    if (meta.includes("accepted_values")) return "accepted_values";
    if (meta.includes("relationship")) return "relationships";
    if (meta.includes("not_null")) return "not_null";
    if (meta.includes("unique_combination")) return "unique";
    if (meta.includes("unique")) return "unique";
    if (meta.includes("freshness")) return "freshness";
    if (
      meta.includes("rowcount") ||
      meta.includes("row_count") ||
      meta.includes("cardinality")
    ) {
      return "row_count";
    }
  }
  for (const rule of NAME_RULES) {
    if (rule.re.test(nodeName)) return rule.kind;
  }
  return "other";
}

/**
 * Best-effort extraction of the target column from a dbt generic-test node name.
 * Generic tests embed the column as the trailing token(s) after the model name,
 * but without the manifest we can only heuristically grab the last identifier.
 * Returns undefined when nothing sensible can be recovered.
 */
export function extractTestColumn(
  nodeName: string,
  metadataColumn?: string,
): string | undefined {
  if (metadataColumn && metadataColumn.trim()) return metadataColumn.trim();
  // accepted_values names append `__val1__val2`; strip those before guessing.
  const base = nodeName.replace(/__.*$/, "");
  const tokens = base.split("_").filter(Boolean);
  // Heuristic: a trailing token like "id" / "status" / "month" is plausibly a
  // column. We only return it when the name clearly began with a known prefix.
  if (/^(unique|not_null|accepted_values|relationships)/.test(base)) {
    const last = tokens[tokens.length - 1];
    if (last && /^[a-z][a-z0-9]*$/i.test(last)) return last;
  }
  return undefined;
}
