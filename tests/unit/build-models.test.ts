/**
 * Unit tests for `build --apply` model generation (pure functions in
 * `_build_models.ts`). Asserts the planner reads `model_plan.md` (models + their
 * generic tests), renders valid-looking dbt SQL + `_schema.yml`, and that the
 * fallback path recovers model names from `changed_files.md`.
 */
import { describe, it, expect } from "vitest";
import {
  planModels,
  parseProposedModels,
  parseGenericTests,
  renderModelSql,
  renderSchemaYml,
  schemaFilesFor,
  layerOf,
  normalizeModelPath,
} from "../../src/cli/commands/_build_models.js";

const MODEL_PLAN = `# Model Plan

## Proposed Models

| Model | Layer | Materialization | Grain | Provenance | Purpose |
| --- | --- | --- | --- | --- | --- |
| \`stg_crm_customers\` | staging | view | one row per customer | sourced | Clean CRM customers. |
| \`fct_customer_retention\` | marts | table | one row per customer per month | sourced | Monthly retention mart. |

## Generic (schema) Tests

- \`stg_crm_customers.customer_id\` → **unique** — natural key
- \`stg_crm_customers.customer_id\` → **not_null** — natural key
- \`fct_customer_retention.customer_id\` → **not_null** — required dimension
- \`fct_customer_retention.retention_status\` → **accepted_values** — bounded enum

## Singular Tests

- \`tests/assert_grain.sql\` — asserts: grain is unique _(traces to AC-1)_
`;

describe("layerOf / normalizeModelPath", () => {
  it("infers layer from name + path", () => {
    expect(layerOf("stg_x")).toBe("staging");
    expect(layerOf("models/staging/stg_x.sql")).toBe("staging");
    expect(layerOf("int_x")).toBe("intermediate");
    expect(layerOf("fct_x")).toBe("marts");
    expect(layerOf("dim_x")).toBe("marts");
  });

  it("nests a bare name under <model_dir>/<layer>/", () => {
    expect(normalizeModelPath("stg_x.sql", "models", "staging", "stg_x")).toBe(
      "models/staging/stg_x.sql",
    );
    // An already-nested plan path is preserved.
    expect(
      normalizeModelPath("models/marts/fct_x.sql", "models", "marts", "fct_x"),
    ).toBe("models/marts/fct_x.sql");
  });
});

describe("parseProposedModels + parseGenericTests", () => {
  it("parses models with layer/grain/purpose", () => {
    const models = parseProposedModels(MODEL_PLAN, "models");
    expect([...models.keys()].sort()).toEqual([
      "fct_customer_retention",
      "stg_crm_customers",
    ]);
    const fct = models.get("fct_customer_retention")!;
    expect(fct.layer).toBe("marts");
    expect(fct.relPath).toBe("models/marts/fct_customer_retention.sql");
    expect(fct.grain).toMatch(/per customer per month/);
  });

  it("parses generic tests into (model, column, test) triples", () => {
    const tests = parseGenericTests(MODEL_PLAN);
    expect(tests).toContainEqual({
      model: "stg_crm_customers",
      column: "customer_id",
      test: "unique",
    });
    expect(tests).toContainEqual({
      model: "fct_customer_retention",
      column: "retention_status",
      test: "accepted_values",
    });
  });
});

describe("planModels — model_plan.md path", () => {
  it("folds tests onto model columns and orders staging→marts", () => {
    const models = planModels({
      modelPlanMd: MODEL_PLAN,
      changedFilesMd: null,
      implementationMd: "",
      modelDir: "models",
    });
    expect(models.map((m) => m.name)).toEqual([
      "stg_crm_customers",
      "fct_customer_retention",
    ]);
    const stg = models[0]!;
    const idCol = stg.columns.find((c) => c.name === "customer_id")!;
    expect(idCol.tests.sort()).toEqual(["not_null", "unique"]);
  });
});

describe("planModels — fallback (changed_files.md)", () => {
  it("recovers model names when no model_plan.md is present", () => {
    const changed = [
      "| Path | Change | Note |",
      "| `models/staging/stg_orders.sql` | create | new |",
      "| `models/marts/fct_orders.sql` | create | new |",
      "| `tests/assert_x.sql` | create | singular test (ignored) |",
    ].join("\n");
    const models = planModels({
      modelPlanMd: null,
      changedFilesMd: changed,
      implementationMd: "",
      modelDir: "models",
    });
    expect(models.map((m) => m.name)).toEqual(["stg_orders", "fct_orders"]);
    // The singular test sql under tests/ is NOT treated as a model.
    expect(models.some((m) => m.name.startsWith("assert"))).toBe(false);
  });
});

describe("renderModelSql", () => {
  it("staging model is a valid-shaped source passthrough with TODO markers", () => {
    const sql = renderModelSql({
      name: "stg_x",
      layer: "staging",
      relPath: "models/staging/stg_x.sql",
      columns: [],
    });
    expect(sql).toMatch(/source\('TODO_source', 'TODO_table'\)/);
    expect(sql).toMatch(/select \* from renamed/);
    expect(sql).toMatch(/TODO\(human\)/);
  });

  it("mart model passes through a ref and notes business logic TODO", () => {
    const sql = renderModelSql({
      name: "fct_x",
      layer: "marts",
      relPath: "models/marts/fct_x.sql",
      grain: "one row per x",
      columns: [],
    });
    expect(sql).toMatch(/ref\('TODO_upstream'\)/);
    expect(sql).toMatch(/Grain: one row per x/);
  });
});

describe("renderSchemaYml", () => {
  it("emits version 2 + model docs + generic tests for planned columns", () => {
    const yml = renderSchemaYml([
      {
        name: "stg_x",
        layer: "staging",
        relPath: "models/staging/stg_x.sql",
        purpose: "Clean x.",
        columns: [
          { name: "id", tests: ["unique", "not_null"] },
          { name: "status", tests: ["accepted_values"] },
        ],
      },
    ]);
    expect(yml).toMatch(/^version: 2/);
    expect(yml).toMatch(/- name: stg_x/);
    expect(yml).toMatch(/- name: id/);
    expect(yml).toMatch(/- unique/);
    expect(yml).toMatch(/- not_null/);
    expect(yml).toMatch(/accepted_values:/);
  });

  it("a model with no planned tests still gets a documented TODO_key entry", () => {
    const yml = renderSchemaYml([
      { name: "fct_x", layer: "marts", relPath: "models/marts/fct_x.sql", columns: [] },
    ]);
    expect(yml).toMatch(/- name: TODO_key/);
    expect(yml).toMatch(/- unique/);
    expect(yml).toMatch(/- not_null/);
  });
});

describe("schemaFilesFor", () => {
  it("groups models into one _schema.yml per layer", () => {
    const files = schemaFilesFor(
      [
        { name: "stg_a", layer: "staging", relPath: "models/staging/stg_a.sql", columns: [] },
        { name: "stg_b", layer: "staging", relPath: "models/staging/stg_b.sql", columns: [] },
        { name: "fct_c", layer: "marts", relPath: "models/marts/fct_c.sql", columns: [] },
      ],
      "models",
    );
    expect(files.map((f) => f.relPath)).toEqual([
      "models/staging/_schema.yml",
      "models/marts/_schema.yml",
    ]);
    expect(files[0]!.models).toHaveLength(2);
    expect(files[1]!.models).toHaveLength(1);
  });
});
