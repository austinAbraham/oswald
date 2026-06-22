/**
 * Deterministic model generation for `build --apply`.
 *
 * Pure functions (no I/O) that turn the planning artifacts into REAL, valid dbt
 * files: one `.sql` per model + a `_schema.yml` per layer carrying the planned
 * generic tests and docs. The build command (`build.ts`) reads the artifacts,
 * calls these, and writes the results NON-DESTRUCTIVELY (never overwrite/delete).
 *
 * Provenance: the richest signal is `model_plan.md` (a "Proposed Models" table +
 * a "Generic (schema) Tests" list). We parse those when present; otherwise we
 * fall back to model names recovered from `changed_files.md` / the implementation
 * plan, scaffolding conservative stubs with the standard unique/not_null tests.
 *
 * Everything generated is clearly marked as Oswald-generated and carries
 * `TODO(human)` markers where business logic must be supplied — we never invent
 * a metric formula. The generated SQL is select-valid (it compiles) so the
 * follow-up `dbt parse` can confirm it.
 */

export type ModelLayer = "staging" | "intermediate" | "marts";

/** A generic (schema) test on a model column. */
export interface GenericTest {
  model: string;
  column: string;
  test: "unique" | "not_null" | "relationships" | "accepted_values";
}

/** A model to generate, with its derived layer, path, grain, columns + tests. */
export interface PlannedModel {
  name: string;
  layer: ModelLayer;
  /** Repo-relative path of the `.sql` file. */
  relPath: string;
  /** Grain text from the plan (one row per ...), when known. */
  grain?: string;
  /** Short purpose/description from the plan, when known. */
  purpose?: string;
  /** Columns that carry generic tests (the only ones we can name confidently). */
  columns: Array<{ name: string; tests: GenericTest["test"][] }>;
}

/** Infer the layer from a model name or path. */
export function layerOf(nameOrPath: string): ModelLayer {
  if (/(^|[/_])stg[_/]/.test(nameOrPath) || /staging\//.test(nameOrPath)) {
    return "staging";
  }
  if (/(^|[/_])int[_/]/.test(nameOrPath) || /intermediate\//.test(nameOrPath)) {
    return "intermediate";
  }
  return "marts";
}

/** Place a model at `<model_dir>/<layer>/<name>.sql` unless the path already nests it. */
export function normalizeModelPath(
  planPath: string,
  modelDir: string,
  layer: ModelLayer,
  name: string,
): string {
  if (planPath.includes("/")) return planPath;
  return `${modelDir}/${layer}/${name}.sql`;
}

// ---------------------------------------------------------------------------
// Parsing the planning artifacts
// ---------------------------------------------------------------------------

/**
 * Parse the "Proposed Models" Markdown table out of `model_plan.md`.
 * Rows look like: `| \`stg_x\` | staging | view | one row per x | sourced | ... |`
 * Returns models keyed by name (no test columns yet — those come from the
 * generic-tests list).
 */
export function parseProposedModels(
  modelPlanMd: string,
  modelDir: string,
): Map<string, PlannedModel> {
  const out = new Map<string, PlannedModel>();
  const lines = modelPlanMd.split(/\r?\n/);
  let inSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    const heading = line.match(/^#{2,6}\s+(.*)$/);
    if (heading) {
      inSection = /proposed models/i.test(heading[1]!);
      continue;
    }
    if (!inSection) continue;
    if (!line.startsWith("|")) continue;
    // Skip the header + separator rows.
    if (/^\|\s*model\s*\|/i.test(line)) continue;
    if (/^\|\s*-+/.test(line) || /^\|(\s*-+\s*\|)+$/.test(line)) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 2) continue;
    const name = cells[0]!.replace(/`/g, "").trim();
    if (!name) continue;
    const layer = (cells[1]?.toLowerCase() as ModelLayer) || layerOf(name);
    const grain = cells[3] && cells[3] !== "—" ? cells[3] : undefined;
    const purpose = cells[5] || cells[cells.length - 1] || undefined;
    const normLayer: ModelLayer = ["staging", "intermediate", "marts"].includes(
      layer,
    )
      ? layer
      : layerOf(name);
    out.set(name, {
      name,
      layer: normLayer,
      relPath: normalizeModelPath(`${name}.sql`, modelDir, normLayer, name),
      ...(grain ? { grain } : {}),
      ...(purpose ? { purpose } : {}),
      columns: [],
    });
  }
  return out;
}

/**
 * Parse the "Generic (schema) Tests" list out of `model_plan.md`.
 * Lines look like: `- \`stg_x.id\` → **unique** — rationale`
 */
export function parseGenericTests(modelPlanMd: string): GenericTest[] {
  const out: GenericTest[] = [];
  const lines = modelPlanMd.split(/\r?\n/);
  let inSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    const heading = line.match(/^#{2,6}\s+(.*)$/);
    if (heading) {
      inSection = /generic.*tests|schema.*tests/i.test(heading[1]!);
      continue;
    }
    if (!inSection) continue;
    const m = line.match(
      /`([a-z0-9_]+)\.([a-z0-9_]+)`\s*(?:→|->)\s*\*\*(unique|not_null|relationships|accepted_values)\*\*/i,
    );
    if (m) {
      out.push({
        model: m[1]!,
        column: m[2]!,
        test: m[3]!.toLowerCase() as GenericTest["test"],
      });
    }
  }
  return out;
}

/**
 * Recover model names from `changed_files.md` (authoritative manifest) and the
 * implementation plan (fallback). Used when no `model_plan.md` is present.
 */
export function deriveModelNames(
  changedFilesMd: string | null,
  implementationMd: string,
  modelDir: string,
): Map<string, PlannedModel> {
  const out = new Map<string, PlannedModel>();
  if (changedFilesMd) {
    const re = /`([^`]+\.sql)`/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(changedFilesMd)) !== null) {
      const p = m[1]!;
      if (/(^|\/)tests\//.test(p)) continue; // skip singular test sql
      const name = p.split("/").pop()!.replace(/\.sql$/, "");
      const layer = layerOf(p);
      out.set(name, {
        name,
        layer,
        relPath: normalizeModelPath(p, modelDir, layer, name),
        columns: [],
      });
    }
  }
  if (out.size === 0) {
    const re = /`(stg_[a-z0-9_]+|int_[a-z0-9_]+|fct_[a-z0-9_]+|dim_[a-z0-9_]+)`/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(implementationMd)) !== null) {
      const name = m[1]!.toLowerCase();
      const layer = layerOf(name);
      out.set(name, {
        name,
        layer,
        relPath: normalizeModelPath(`${name}.sql`, modelDir, layer, name),
        columns: [],
      });
    }
  }
  return out;
}

/**
 * Assemble the final ordered list of {@link PlannedModel}s from the artifacts,
 * folding each model's generic tests onto its columns. Prefers `model_plan.md`;
 * falls back to name recovery. Models are ordered staging → intermediate → marts
 * then by path, so the build order is reviewable and deterministic.
 */
export function planModels(args: {
  modelPlanMd: string | null;
  changedFilesMd: string | null;
  implementationMd: string;
  modelDir: string;
}): PlannedModel[] {
  const { modelPlanMd, changedFilesMd, implementationMd, modelDir } = args;
  const models =
    modelPlanMd && /proposed models/i.test(modelPlanMd)
      ? parseProposedModels(modelPlanMd, modelDir)
      : deriveModelNames(changedFilesMd, implementationMd, modelDir);

  // Fold generic tests onto columns.
  const genericTests = modelPlanMd ? parseGenericTests(modelPlanMd) : [];
  for (const gt of genericTests) {
    const model = models.get(gt.model);
    if (!model) continue;
    let col = model.columns.find((c) => c.name === gt.column);
    if (!col) {
      col = { name: gt.column, tests: [] };
      model.columns.push(col);
    }
    if (!col.tests.includes(gt.test)) col.tests.push(gt.test);
  }

  const layerRank: Record<ModelLayer, number> = {
    staging: 0,
    intermediate: 1,
    marts: 2,
  };
  return [...models.values()].sort(
    (a, b) =>
      layerRank[a.layer] - layerRank[b.layer] ||
      a.relPath.localeCompare(b.relPath),
  );
}

// ---------------------------------------------------------------------------
// Rendering real dbt files
// ---------------------------------------------------------------------------

/**
 * Generate a model `.sql` body. The SQL is intentionally structural and
 * conservative: staging is a source passthrough; marts pass through an upstream
 * ref. Business logic is left as a clearly-marked TODO — Oswald never fabricates
 * a metric formula, a source, or an upstream ref.
 *
 * NOTE: because provenance is never fabricated, the generated bodies carry
 * `source('TODO_source', 'TODO_table')` / `ref('TODO_upstream')` placeholders.
 * These are deliberately UNRESOLVED, so `dbt parse` on freshly-generated output
 * will fail with a "source/model not found" compilation error until a human
 * fills in the TODO(human) markers. `build --apply` runs `dbt parse` precisely
 * to surface those markers; the command warns and leaves the files for review
 * rather than treating the parse failure as fatal.
 */
export function renderModelSql(model: PlannedModel): string {
  const header = [
    `-- ${model.name} (${model.layer}) — generated by \`oswald build --apply\`.`,
    model.grain ? `-- Grain: ${model.grain}` : null,
    model.purpose ? `-- Purpose: ${model.purpose}` : null,
  ].filter(Boolean);

  if (model.layer === "staging") {
    return [
      ...header,
      "-- Staging: 1:1 with the source — rename + cast only, no business logic.",
      "-- TODO(human): point source() at the real source/table and enumerate columns.",
      "with source as (",
      "    select * from {{ source('TODO_source', 'TODO_table') }}",
      "),",
      "",
      "renamed as (",
      "    select",
      "        *  -- TODO(human): replace select-star with explicit renamed/cast columns",
      "    from source",
      ")",
      "",
      "select * from renamed",
      "",
    ].join("\n");
  }

  // intermediate / marts: pass through an upstream ref, leave logic as TODO.
  return [
    ...header,
    model.layer === "marts"
      ? "-- Mart: apply business logic + enforce the grain above."
      : "-- Intermediate: joins + reshaping toward the mart's shape.",
    "-- TODO(human): replace ref('TODO_upstream') and implement the confirmed logic.",
    "with upstream as (",
    "    select * from {{ ref('TODO_upstream') }}",
    ")",
    "",
    "select * from upstream",
    "",
  ].join("\n");
}

/**
 * Render a `_schema.yml` for the models in one layer, carrying their planned
 * generic tests + docs. Models with no planned test columns still get a
 * documented entry with a `TODO_key` placeholder carrying unique/not_null, so
 * the standards "tests + docs for new models" rule is satisfied.
 */
export function renderSchemaYml(models: PlannedModel[]): string {
  const lines = ["version: 2", "", "models:"];
  for (const m of models) {
    lines.push(`  - name: ${m.name}`);
    const desc =
      m.purpose?.replace(/"/g, "'") ??
      `TODO(human): describe ${m.name} (${m.layer}).`;
    lines.push(`    description: "${desc}"`);
    lines.push("    columns:");
    const cols =
      m.columns.length > 0
        ? m.columns
        : [{ name: "TODO_key", tests: ["unique", "not_null"] as GenericTest["test"][] }];
    for (const c of cols) {
      lines.push(`      - name: ${c.name}`);
      lines.push(
        `        description: "TODO(human): describe ${c.name}."`,
      );
      if (c.tests.length > 0) {
        lines.push("        tests:");
        for (const t of c.tests) {
          if (t === "accepted_values") {
            lines.push("          - accepted_values:");
            lines.push("              values: [TODO_value]  # TODO(human): list the allowed values");
          } else if (t === "relationships") {
            lines.push("          - relationships:");
            lines.push("              to: ref('TODO_parent')  # TODO(human): the referenced model");
            lines.push("              field: TODO_key");
          } else {
            lines.push(`          - ${t}`);
          }
        }
      }
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Group models by layer for one `_schema.yml` per layer. Returns the
 * `<model_dir>/<layer>/_schema.yml` relative path keyed to its models.
 */
export function schemaFilesFor(
  models: PlannedModel[],
  modelDir: string,
): Array<{ relPath: string; models: PlannedModel[] }> {
  const byLayer = new Map<ModelLayer, PlannedModel[]>();
  for (const m of models) {
    const arr = byLayer.get(m.layer) ?? [];
    arr.push(m);
    byLayer.set(m.layer, arr);
  }
  const out: Array<{ relPath: string; models: PlannedModel[] }> = [];
  for (const layer of ["staging", "intermediate", "marts"] as ModelLayer[]) {
    const arr = byLayer.get(layer);
    if (arr && arr.length) {
      out.push({ relPath: `${modelDir}/${layer}/_schema.yml`, models: arr });
    }
  }
  return out;
}
