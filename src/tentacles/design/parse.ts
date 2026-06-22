/**
 * Deterministic metric & semantic-design parsing.
 *
 * Pure functions that turn already-extracted intake/requirements/EDA text into
 * structured *candidate* analytical definitions: metrics, grain, dimensions,
 * filters/exclusions, null behavior, SCD hints, reconciliation hints.
 *
 * CRITICAL ANALYTICAL-ENGINEERING RULE: this module NEVER invents business
 * logic. It detects *signals* in already-sourced text and proposes candidates;
 * the index module tags every proposed-but-unconfirmed rule as
 * `assumption` / `open_question`. No LLM, no network — heuristics only.
 *
 * All text passed in is treated as DATA to analyze (the trust boundary /
 * injection-neutralization is handled by the caller via the sanitizer).
 */

// ---------------------------------------------------------------------------
// Metric detection
// ---------------------------------------------------------------------------

/**
 * Vague business terms that imply a metric but carry no concrete definition.
 * Each detected term becomes an `open_question` (definition required).
 */
export const VAGUE_METRIC_TERMS = [
  "active",
  "engaged",
  "revenue",
  "recent",
  "top",
  "best",
  "successful",
  "churn",
  "retention",
  "conversion",
  "growth",
  "healthy",
  "qualified",
] as const;

/** Aggregation verbs that hint at the metric's underlying calculation. */
const AGGREGATION_HINTS: Array<{ re: RegExp; agg: string }> = [
  // distinct must be checked before plain count ("count distinct" → count_distinct)
  { re: /\b(distinct|unique|deduplicated)\b/i, agg: "count_distinct" },
  { re: /\b(count|number of|# of|how many|tally)\b/i, agg: "count" },
  { re: /\b(sum|total|amount|gross|net)\b/i, agg: "sum" },
  { re: /\b(average|avg|mean|per[- ]customer|per[- ]user)\b/i, agg: "average" },
  { re: /\b(rate|ratio|percent|percentage|%|share)\b/i, agg: "ratio" },
  { re: /\b(max|maximum|highest|peak)\b/i, agg: "max" },
  { re: /\b(min|minimum|lowest)\b/i, agg: "min" },
  { re: /\b(median|p50|percentile|p9\d)\b/i, agg: "percentile" },
];

export interface MetricCandidate {
  /** Snake_case candidate name derived from the phrase. */
  name: string;
  /** The original phrase the candidate was derived from. */
  phrase: string;
  /** Inferred aggregation, or null if undetermined. */
  aggregation: string | null;
  /** True when the phrase contains a vague/undefined business term. */
  vague: boolean;
  /** Vague terms found in the phrase (subset of VAGUE_METRIC_TERMS). */
  vagueTerms: string[];
}

/** Lowercase → snake_case identifier, stripped of noise words. */
export function toSnakeCase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_");
}

/**
 * Detect candidate metrics from a list of requirement / acceptance lines.
 *
 * Heuristic: a line is a metric candidate if it mentions an aggregation verb
 * OR a vague metric term. The candidate name is a snake_case slug of the
 * salient noun-ish part of the phrase (best-effort, deterministic).
 */
export function detectMetricCandidates(lines: string[]): MetricCandidate[] {
  const out: MetricCandidate[] = [];
  const seen = new Set<string>();

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // Skip lines that are clearly grain / source declarations, not metrics —
    // a "grain: one row per customer per day" line is not itself a metric.
    const stripped = line.replace(/^\s*[-*+]\s+|\s*\d+[.)]\s+/, "").trim();
    if (/^(grain|read from|source|sources?|reads? from|input)\b\s*[:=]?/i.test(stripped))
      continue;

    const aggHit = AGGREGATION_HINTS.find((h) => h.re.test(line));
    const vagueTerms = VAGUE_METRIC_TERMS.filter((t) =>
      new RegExp(`\\b${t}\\b`, "i").test(line),
    );

    if (!aggHit && vagueTerms.length === 0) continue;

    // Build a candidate name: prefer a measure-y noun phrase. Strip leading
    // imperative verbs ("produce", "build", "create", "report").
    const cleaned = line
      .replace(
        /^\s*(produce|build|create|report|show|display|deliver|provide|track|measure|calculate|define)\s+(an?\s+|the\s+)?/i,
        "",
      )
      .replace(/^(dbt\s+model|model|metric|kpi|measure)\s+/i, "")
      .replace(/[.:;].*$/, "")
      .trim();

    const name = toSnakeCase(cleaned).slice(0, 60) || toSnakeCase(line).slice(0, 60);
    if (!name || seen.has(name)) continue;
    seen.add(name);

    out.push({
      name,
      phrase: line,
      aggregation: aggHit ? aggHit.agg : null,
      vague: vagueTerms.length > 0,
      vagueTerms: [...vagueTerms],
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Grain detection
// ---------------------------------------------------------------------------

export interface GrainCandidate {
  /** The detected grain phrase, e.g. "one row per customer per day". */
  description: string;
  /** Extracted grain keys, e.g. ["customer", "day"]. */
  keys: string[];
  /** True when a grain statement was explicitly found (vs inferred default). */
  explicit: boolean;
}

/**
 * Detect grain. Looks for explicit "grain:", "one row per X (per Y)",
 * "at the X level", "by X" phrasing. Returns null if nothing explicit found.
 */
export function detectGrain(text: string): GrainCandidate | null {
  // explicit "grain: ..." line
  const grainLine = text.match(/\bgrain\s*[:=]\s*([^\n.]+)/i);
  if (grainLine) {
    const desc = grainLine[1]!.trim();
    return { description: desc, keys: extractGrainKeys(desc), explicit: true };
  }

  // "one row per X per Y" / "a row per X"
  const perPhrase = text.match(
    /\b(?:one|a|1)\s+row\s+per\s+([a-z0-9_ ]+?)(?=[.\n]|$)/i,
  );
  if (perPhrase) {
    const desc = `one row per ${perPhrase[1]!.trim()}`;
    return { description: desc, keys: extractGrainKeys(perPhrase[1]!), explicit: true };
  }

  // "at the X level" / "at X grain"
  const levelPhrase = text.match(/\bat\s+(?:the\s+)?([a-z0-9_ ]+?)\s+(?:level|grain)\b/i);
  if (levelPhrase) {
    const desc = `${levelPhrase[1]!.trim()} level`;
    return { description: desc, keys: extractGrainKeys(levelPhrase[1]!), explicit: true };
  }

  return null;
}

/** Pull grain key tokens out of a grain phrase ("customer per day" → [customer, day]). */
const GRAIN_NOISE = new Set(["row", "rows", "one", "a", "one_row", "a_row", "each"]);

export function extractGrainKeys(phrase: string): string[] {
  return phrase
    .toLowerCase()
    .split(/\bper\b|,|\band\b|\bby\b/i)
    .map((s) => toSnakeCase(s.trim()).replace(/^(one|a|each)_/, ""))
    .filter((s) => s && !GRAIN_NOISE.has(s) && s.length > 1);
}

// ---------------------------------------------------------------------------
// Dimension detection
// ---------------------------------------------------------------------------

export interface DimensionCandidate {
  name: string;
  /** Best-effort semantic type guess. */
  type: "time" | "categorical" | "geographic" | "identifier" | "boolean" | "unknown";
  phrase: string;
}

const TIME_TOKENS = [
  "day",
  "date",
  "week",
  "month",
  "quarter",
  "year",
  "hour",
  "time",
  "period",
];
const GEO_TOKENS = ["country", "region", "city", "state", "territory", "geo", "location"];
const ID_TOKENS = ["id", "key", "customer", "user", "account", "order", "product"];
const BOOL_TOKENS = ["is_", "has_", "flag", "active"];

/**
 * Detect candidate dimensions. Looks for explicit "dimensions:" / "split by" /
 * "broken down by" / "grouped by" phrasing, plus grain keys.
 */
export function detectDimensions(text: string, grainKeys: string[]): DimensionCandidate[] {
  const found = new Map<string, DimensionCandidate>();

  const addDim = (token: string, phrase: string): void => {
    const name = toSnakeCase(token);
    if (!name || name.length < 2 || found.has(name)) return;
    found.set(name, { name, type: guessDimensionType(name), phrase });
  };

  // explicit "dimensions:" / "dimension list"
  for (const m of text.matchAll(/\bdimensions?\s*[:=]\s*([^\n.]+)/gi)) {
    for (const tok of splitTokens(m[1]!)) addDim(tok, m[0]!.trim());
  }

  // "split/broken down/grouped/sliced by X (, Y, and Z)"
  for (const m of text.matchAll(
    /\b(?:split|broken down|grouped|sliced|segmented|filtered)\s+by\s+([a-z0-9_ ,]+?)(?=[.\n]|$)/gi,
  )) {
    for (const tok of splitTokens(m[1]!)) addDim(tok, m[0]!.trim());
  }

  // "by X" generic (lower confidence)
  for (const m of text.matchAll(/\bby\s+([a-z][a-z0-9_]{2,})\b/gi)) {
    addDim(m[1]!, m[0]!.trim());
  }

  // Promote grain keys to dimensions too (they are part of the contract).
  for (const k of grainKeys) addDim(k, "grain key");

  return [...found.values()];
}

function splitTokens(s: string): string[] {
  return s
    .split(/,|\band\b/i)
    .map((t) => t.trim())
    .filter(Boolean);
}

export function guessDimensionType(name: string): DimensionCandidate["type"] {
  const n = name.toLowerCase();
  if (BOOL_TOKENS.some((t) => n.startsWith(t) || n.endsWith("_flag") || n === "flag"))
    return "boolean";
  if (TIME_TOKENS.some((t) => n === t || n.endsWith(`_${t}`) || n.includes(t)))
    return "time";
  if (GEO_TOKENS.some((t) => n === t || n.includes(t))) return "geographic";
  if (ID_TOKENS.some((t) => n === t || n.endsWith(`_${t}`) || n === `${t}_id`))
    return "identifier";
  return "categorical";
}

// ---------------------------------------------------------------------------
// Filters / exclusions
// ---------------------------------------------------------------------------

export interface FilterCandidate {
  description: string;
  /** "include" (filter to) vs "exclude" (filter out). */
  kind: "include" | "exclude";
}

/**
 * Detect filter / exclusion language. "exclude/ignore/without/excluding X",
 * "only/just/where X", "test accounts", "internal users", etc.
 */
export function detectFilters(text: string): FilterCandidate[] {
  const out: FilterCandidate[] = [];
  const seen = new Set<string>();

  const push = (description: string, kind: FilterCandidate["kind"]): void => {
    const key = `${kind}:${description.toLowerCase()}`;
    if (!description || seen.has(key)) return;
    seen.add(key);
    out.push({ description, kind });
  };

  for (const m of text.matchAll(
    /\b(?:exclud(?:e|ing)|ignor(?:e|ing)|omit(?:ting)?|without|excepting|drop(?:ping)?)\s+([a-z0-9_ -]+?)(?=[.\n,]|$)/gi,
  )) {
    push(m[1]!.trim(), "exclude");
  }

  for (const m of text.matchAll(
    /\b(?:only|just|where|limited to|restricted to|including only)\s+([a-z0-9_ -]+?)(?=[.\n,]|$)/gi,
  )) {
    push(m[1]!.trim(), "include");
  }

  // Common implicit exclusions worth surfacing if mentioned.
  for (const phrase of ["test account", "test accounts", "internal user", "internal users", "bot", "bots", "refund", "refunds", "chargeback", "chargebacks"]) {
    if (new RegExp(`\\b${phrase}\\b`, "i").test(text)) {
      push(phrase, "exclude");
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Time / SCD / late-arriving hints
// ---------------------------------------------------------------------------

/** Detect whether the metric appears time-based (needs a date spine / grain). */
export function isTimeBased(grain: GrainCandidate | null, text: string): boolean {
  if (grain && grain.keys.some((k) => TIME_TOKENS.includes(k))) return true;
  return /\b(daily|weekly|monthly|quarterly|per day|over time|trend|time series|by date)\b/i.test(
    text,
  );
}

/** Detect whether the source dimension may need SCD (slowly-changing) handling. */
export function detectScdSignal(text: string): boolean {
  return /\b(history|historical|changes? over time|as of|point[- ]in[- ]time|effective date|scd|slowly changing|versioned|snapshot)\b/i.test(
    text,
  );
}

/** Detect late-arriving / out-of-order data signals. */
export function detectLateArrivingSignal(text: string): boolean {
  return /\b(late[- ]arriving|late data|backfill|out[- ]of[- ]order|restated|amendments?|corrections?|retroactive)\b/i.test(
    text,
  );
}
