/**
 * Deterministic model-planning heuristics.
 *
 * Pure functions that turn prior pipeline artifacts (design / eda / intake /
 * requirements) into a layered dbt model plan + an implementation plan + a
 * manifest of intended file changes. No LLM, no network, no I/O — heuristics
 * only. Everything proposed is sourced or tagged so unsourced decisions are
 * visible to the human reviewer.
 *
 * IMPORTANT: artifact content is parsed as *data to analyze*, never obeyed. The
 * planning tentacle wraps untrusted content via the sanitizer before this module
 * sees it; here we only read structure and emit a plan.
 *
 * This module proposes; it never touches project models. Producing the actual
 * SQL/YAML files is the job of the `build` command — planning only emits the
 * plan and the `changed_files` manifest of intended changes.
 */

/** A canonical dbt layer. Staging → intermediate → marts is the standard flow. */
export type DbtLayer = "staging" | "intermediate" | "marts";

/** A single proposed dbt model. */
export interface ProposedModel {
  /** Model name without extension, e.g. `stg_salesforce__accounts`. */
  name: string;
  layer: DbtLayer;
  /** Materialization recommendation (view for staging, table/incremental for marts). */
  materialization: "view" | "table" | "incremental" | "ephemeral";
  /** What this model is for (one line, deterministic). */
  purpose: string;
  /** Upstream refs/sources this model depends on (names only). */
  upstream: string[];
  /** Grain statement, if it can be inferred. */
  grain?: string;
  /** Whether this name/role was sourced from a prior artifact or inferred. */
  sourced: boolean;
}

/** A proposed generic (schema) test on a column. */
export interface ProposedTest {
  model: string;
  column: string;
  test: "unique" | "not_null" | "relationships" | "accepted_values";
  /** Why this test was proposed (deterministic rationale). */
  rationale: string;
}

/** A proposed singular (custom SQL) test. */
export interface ProposedSingularTest {
  /** File name (without extension) under `tests/`. */
  name: string;
  /** What the test asserts. */
  assertion: string;
  /** The acceptance criterion or rule it traces back to. */
  source: string;
}

/** A file the build step is intended to create or modify. */
export interface ChangedFile {
  path: string;
  /** create = new file, modify = edit existing. Planning only ever proposes. */
  change: "create" | "modify";
  /** Short note on what goes in the file. */
  note: string;
}

export interface ModelingPattern {
  id: string;
  title: string;
  /** Why this pattern was selected (deterministic). */
  rationale: string;
}

// ---------------------------------------------------------------------------
// Lightweight artifact reading — we accept already-sanitized markdown text.
// ---------------------------------------------------------------------------

/** Strip a leading list marker from a line. */
export function stripBullet(line: string): string {
  return line
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*\d+[.)]\s+/, "")
    .replace(/^\s*\[[ xX]?\]\s+/, "")
    .trim();
}

/** Whether a line looks like a list item. */
export function isBullet(line: string): boolean {
  return /^\s*([-*+]\s+|\d+[.)]\s+|\[[ xX]?\]\s+)/.test(line);
}

/**
 * Detect dbt source-system tokens in free text (mirrors the intake keyword
 * scan so the plan layers staging models per detected source).
 */
const SOURCE_SYSTEM_KEYWORDS = [
  "salesforce",
  "stripe",
  "snowflake",
  "bigquery",
  "redshift",
  "postgres",
  "mysql",
  "hubspot",
  "segment",
  "shopify",
  "netsuite",
  "zendesk",
  "marketo",
  "google analytics",
  "ga4",
  "fivetran",
  "kafka",
  "s3",
  "mongodb",
  "dynamodb",
];

export function detectSourceSystems(text: string): string[] {
  const lower = text.toLowerCase();
  const hits = new Set<string>();
  for (const kw of SOURCE_SYSTEM_KEYWORDS) {
    if (lower.includes(kw)) hits.add(kw);
  }
  return [...hits];
}

/**
 * Detect `schema.table` style source relations (e.g. `salesforce.accounts`).
 * Returns `{ source, relation }` pairs deduped on the full identifier.
 */
export interface SourceRelation {
  source: string;
  relation: string;
}

export function detectSourceRelations(text: string): SourceRelation[] {
  const seen = new Set<string>();
  const out: SourceRelation[] = [];
  for (const m of text.matchAll(
    /\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/gi,
  )) {
    const full = m[0]!.toLowerCase();
    // skip dbt-layer model refs (handled separately) and obvious non-sources.
    if (/^(stg|int|fct|dim|mart|rpt)_/.test(full)) continue;
    if (seen.has(full)) continue;
    seen.add(full);
    out.push({ source: m[1]!.toLowerCase(), relation: m[2]!.toLowerCase() });
  }
  return out;
}

/** Detect explicit dbt model targets (stg_/int_/fct_/dim_/mart_/rpt_). */
export function detectTargetModels(text: string): string[] {
  const hits = new Set<string>();
  for (const m of text.matchAll(
    /\b(?:stg|int|fct|dim|mart|rpt)_[a-z0-9_]+\b/gi,
  )) {
    hits.add(m[0]!.toLowerCase());
  }
  return [...hits];
}

/** Heuristic grain detection — looks for "one row per ..." / "grain: ..." phrases. */
export function detectGrain(text: string): string | null {
  const grainLabel = text.match(/\bgrain:?\s*([^\n.]+)/i);
  if (grainLabel) return grainLabel[1]!.trim();
  const perRow = text.match(/\bone row per\s+([^\n.]+)/i);
  if (perRow) return `one row per ${perRow[1]!.trim()}`;
  return null;
}

/** Detect a date/time grain signal (daily/weekly/monthly snapshots). */
export function detectTimeGrain(text: string): string | null {
  const m = text.match(/\b(daily|weekly|monthly|hourly|quarterly|annual)\b/i);
  return m ? m[1]!.toLowerCase() : null;
}

// ---------------------------------------------------------------------------
// Modeling-pattern selection.
// ---------------------------------------------------------------------------

/**
 * Choose a modeling pattern from deterministic signals. The patterns are the
 * common dbt analytical shapes; selection is keyword-driven and explainable.
 */
export function selectModelingPattern(signals: {
  hasTimeGrain: boolean;
  text: string;
  targetModels: string[];
}): ModelingPattern {
  const lower = signals.text.toLowerCase();
  const hasFact = signals.targetModels.some((t) => /^fct_/.test(t));
  const hasDim = signals.targetModels.some((t) => /^dim_/.test(t));

  if (/\bsnapshot\b|\bscd\b|\bslowly changing\b|\bhistory\b/.test(lower)) {
    return {
      id: "snapshot_scd",
      title: "Snapshot / slowly-changing dimension",
      rationale:
        "Text mentions snapshots / history / SCD — capture row history with a dbt snapshot before downstream marts.",
    };
  }
  if (signals.hasTimeGrain && (hasFact || /\bper day\b|\bdaily\b/.test(lower))) {
    return {
      id: "periodic_snapshot_fact",
      title: "Periodic-snapshot fact table",
      rationale:
        "A time grain plus a fact target implies a periodic-snapshot fact (one row per entity per period).",
    };
  }
  if (hasFact && hasDim) {
    return {
      id: "star_schema",
      title: "Star schema (fact + conformed dimensions)",
      rationale:
        "Both fact and dimension targets were named — model as a star: staging → conformed dims + a fact.",
    };
  }
  if (hasFact) {
    return {
      id: "transactional_fact",
      title: "Transactional fact table",
      rationale:
        "A fact target was named without dimensions — model as a transactional fact off staged sources.",
    };
  }
  if (hasDim) {
    return {
      id: "dimension",
      title: "Conformed dimension",
      rationale:
        "A dimension target was named — model as a conformed dimension off staged sources.",
    };
  }
  return {
    id: "staging_to_mart",
    title: "Standard staging → mart",
    rationale:
      "No specific fact/dimension/snapshot signal — apply the default layered flow: stage each source, then a single mart.",
  };
}

// ---------------------------------------------------------------------------
// Model proposal.
// ---------------------------------------------------------------------------

/** Slugify a token into a safe dbt name fragment. */
export function nameFragment(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export interface PlanInputs {
  /** Detected source systems (e.g. ["salesforce", "stripe"]). */
  sourceSystems: string[];
  /** Detected `schema.table` source relations. */
  sourceRelations: SourceRelation[];
  /** Explicit model targets named in the artifacts (e.g. fct_...). */
  targetModels: string[];
  /** Inferred grain statement, if any. */
  grain: string | null;
  /** Pattern selected for this build. */
  pattern: ModelingPattern;
}

/**
 * Propose a layered set of dbt models from the inputs.
 *
 * Deterministic rules:
 *  - one staging model per detected source relation (or per source system if no
 *    relations were named),
 *  - an intermediate model only when there are 2+ staging models to combine,
 *  - one mart model per explicit target (or a single inferred mart when none
 *    were named).
 */
export function proposeModels(inputs: PlanInputs): ProposedModel[] {
  const models: ProposedModel[] = [];

  // --- Staging layer: one per source relation, else per source system. ----
  const stagingNames: string[] = [];
  if (inputs.sourceRelations.length > 0) {
    for (const r of inputs.sourceRelations) {
      const name = `stg_${nameFragment(r.source)}__${nameFragment(r.relation)}`;
      stagingNames.push(name);
      models.push({
        name,
        layer: "staging",
        materialization: "view",
        purpose: `Clean + rename columns from source ${r.source}.${r.relation}.`,
        upstream: [`source('${r.source}', '${r.relation}')`],
        sourced: true,
      });
    }
  } else if (inputs.sourceSystems.length > 0) {
    for (const s of inputs.sourceSystems) {
      const name = `stg_${nameFragment(s)}`;
      stagingNames.push(name);
      models.push({
        name,
        layer: "staging",
        materialization: "view",
        purpose: `Clean + rename columns from the ${s} source (specific relation TBD).`,
        upstream: [`source('${nameFragment(s)}', '<relation>')`],
        sourced: false,
      });
    }
  }

  // --- Intermediate layer: only when there is something to join. ----------
  let intermediateName: string | null = null;
  if (stagingNames.length >= 2) {
    const base = inputs.targetModels[0]
      ? nameFragment(inputs.targetModels[0].replace(/^(fct|dim|mart|rpt)_/, ""))
      : "joined_entities";
    intermediateName = `int_${base}`;
    models.push({
      name: intermediateName,
      layer: "intermediate",
      materialization: "ephemeral",
      purpose: `Join + reshape the ${stagingNames.length} staging models into the shape the mart needs.`,
      upstream: stagingNames.map((n) => `ref('${n}')`),
      ...(inputs.grain ? { grain: inputs.grain } : {}),
      sourced: false,
    });
  }

  // --- Marts layer: one per explicit target, else a single inferred mart. --
  const martUpstream = intermediateName
    ? [`ref('${intermediateName}')`]
    : stagingNames.map((n) => `ref('${n}')`);

  const isIncremental = inputs.pattern.id === "periodic_snapshot_fact";
  if (inputs.targetModels.length > 0) {
    for (const t of inputs.targetModels) {
      models.push({
        name: t,
        layer: "marts",
        materialization: isIncremental ? "incremental" : "table",
        purpose: `Final analytical model "${t}" (pattern: ${inputs.pattern.title}).`,
        upstream: martUpstream,
        ...(inputs.grain ? { grain: inputs.grain } : {}),
        sourced: true,
      });
    }
  } else {
    models.push({
      name: "mart_requested_model",
      layer: "marts",
      materialization: isIncremental ? "incremental" : "table",
      purpose: `Inferred final model (no explicit target named) — pattern: ${inputs.pattern.title}. CONFIRM the name + grain.`,
      upstream: martUpstream,
      ...(inputs.grain ? { grain: inputs.grain } : {}),
      sourced: false,
    });
  }

  return models;
}

// ---------------------------------------------------------------------------
// Test proposal.
// ---------------------------------------------------------------------------

/**
 * Propose generic schema tests. Deterministic defaults:
 *  - every staging model gets a unique+not_null on its inferred `<entity>_id`,
 *  - mart models get unique+not_null on their first key column candidate.
 */
export function proposeGenericTests(models: ProposedModel[]): ProposedTest[] {
  const tests: ProposedTest[] = [];
  for (const m of models) {
    if (m.layer === "intermediate") continue; // ephemeral, not directly tested
    const keyCol = inferKeyColumn(m);
    tests.push({
      model: m.name,
      column: keyCol,
      test: "unique",
      rationale: `Primary key candidate for ${m.layer} model ${m.name} must be unique.`,
    });
    tests.push({
      model: m.name,
      column: keyCol,
      test: "not_null",
      rationale: `Primary key candidate for ${m.layer} model ${m.name} must be populated.`,
    });
  }
  return tests;
}

/** Infer a primary-key column name from a model name (deterministic). */
export function inferKeyColumn(m: ProposedModel): string {
  // stg_salesforce__accounts → account_id ; fct_daily_active_customers → ... _id
  const tail = m.name.replace(/^(stg|int|fct|dim|mart|rpt)_/, "");
  const lastSegment = tail.split("__").pop()!;
  const singular = lastSegment.replace(/s$/, "");
  return `${singular}_id`;
}

/**
 * Propose singular tests from acceptance criteria. Each numeric / comparison /
 * reconciliation criterion becomes a custom SQL test stub the build step fills
 * in. This is how acceptance criteria get traced to a deterministic check.
 */
export function proposeSingularTests(
  acceptanceCriteria: string[],
): ProposedSingularTest[] {
  const out: ProposedSingularTest[] = [];
  acceptanceCriteria.forEach((crit, i) => {
    const lower = crit.toLowerCase();
    const testable =
      /\b(match|equal|within|count|sum|at least|no more than|greater|less|reconcile|percent|%|each|every|all)\b/.test(
        lower,
      );
    if (!testable) return;
    out.push({
      name: `assert_ac_${i + 1}_${nameFragment(crit).slice(0, 40)}`,
      assertion: crit,
      source: `acceptance_criteria.md #${i + 1}`,
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Changed-files manifest.
// ---------------------------------------------------------------------------

/**
 * Build the manifest of files the `build` step is INTENDED to create/modify.
 * Planning never writes these — it only declares them for review.
 */
export function buildChangedFiles(
  models: ProposedModel[],
  genericTests: ProposedTest[],
  singularTests: ProposedSingularTest[],
): ChangedFile[] {
  const files: ChangedFile[] = [];
  const dirFor = (layer: DbtLayer): string =>
    layer === "marts" ? "models/marts" : `models/${layer}`;

  // Per-model SQL + per-layer schema.yml (one schema.yml per layer dir).
  const schemaDirs = new Set<string>();
  for (const m of models) {
    const dir = dirFor(m.layer);
    files.push({
      path: `${dir}/${m.name}.sql`,
      change: "create",
      note: `${m.layer} model (${m.materialization}) — ${m.purpose}`,
    });
    schemaDirs.add(dir);
  }
  for (const dir of [...schemaDirs].sort()) {
    files.push({
      path: `${dir}/_schema.yml`,
      change: "create",
      note: "Model descriptions + column docs + generic tests for this layer.",
    });
  }

  // A sources.yml if any staging model reads a source().
  const usesSources = models.some((m) =>
    m.upstream.some((u) => u.startsWith("source(")),
  );
  if (usesSources) {
    files.push({
      path: "models/staging/_sources.yml",
      change: "create",
      note: "Declare raw source tables (schema + freshness) referenced by staging models.",
    });
  }

  // Singular tests.
  for (const t of singularTests) {
    files.push({
      path: `tests/${t.name}.sql`,
      change: "create",
      note: `Singular test — asserts: ${t.assertion} (from ${t.source}).`,
    });
  }

  // Note generic-test count (they live inside the schema.yml files).
  if (genericTests.length > 0) {
    // No separate file; recorded for traceability in the plan, not the manifest.
  }

  return files;
}
