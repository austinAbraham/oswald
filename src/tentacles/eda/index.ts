/**
 * Warehouse Discovery & EDA tentacle.
 *
 * Safely inspects candidate warehouse sources (Snowflake reference; mock mode
 * for the MVP via MockWarehouseProvider). It GENERATES read-only SQL to:
 *   - discover schemas / tables / columns,
 *   - profile row counts, null rates, distinct counts (uniqueness),
 *   - infer grain (candidate key uniqueness),
 *   - measure date ranges / freshness,
 *   - detect duplicate keys,
 *   - identify PII columns by name pattern,
 *   - probe join paths and compare row counts.
 *
 * SAFETY INVARIANTS (enforced here, not just hoped for):
 *   - EVERY generated query is re-validated through `ctx.policy.sql` before it is
 *     written or executed. Anything that does not pass the read-only gate is
 *     dropped and surfaced as a warning (this should never happen for our own
 *     generated SQL, but it is defense in depth).
 *   - We PREFER aggregates over raw rows; sensitive (PII-by-name) columns are
 *     profiled only by aggregate and are NEVER selected as raw values.
 *   - Rendered artifacts are run through the sensitive-value redactor before
 *     persisting, so no raw PII can land in the repo.
 *   - `--execute` actually runs the queries ONLY when a warehouse provider
 *     exists AND warehouse reads are allowed by policy; otherwise this is a
 *     dry-run that writes the SQL files + an EDA plan.
 *
 * Outputs (under the artifact dir):
 *   - eda_report.md            — overview: sources inspected, queries, exec mode
 *   - grain_analysis.md        — candidate grain + uniqueness verdicts
 *   - join_analysis.md         — inferred join paths + coverage
 *   - data_quality_findings.md — null rates, duplicates, freshness, PII columns
 *   - sql_queries/<name>.sql   — every validated read-only query
 * and advances `.oswald/state.yml` to the `design` phase.
 *
 * No live LLM: all heuristics are deterministic (see `./sql.ts`). Warehouse
 * column/table NAMES are treated as untrusted identifiers (always quoted) and
 * returned VALUES are never trusted as instructions.
 */
import { z } from "zod";
import {
  type Tentacle,
  type TentacleContext,
  type TentacleResult,
  type EvidenceItem,
  markEvidence,
  renderEvidenceTable,
  advanceWorkflow,
} from "../base.js";
import type {
  TableInfo,
  WarehouseProvider,
  QueryResult,
} from "../../tools/index.js";
import {
  type EdaQuery,
  type GrainVerdict,
  type JoinCandidate,
  buildSchemaDiscoveryQuery,
  buildRowCountQuery,
  buildColumnProfileQuery,
  buildGrainQuery,
  buildFreshnessQuery,
  buildDuplicatesQuery,
  buildJoinQuery,
  inferCandidateKey,
  inferJoinCandidates,
  dateColumns,
  sensitiveColumns,
  interpretGrain,
  slug,
} from "./sql.js";

export const ARTIFACT_NAMES = {
  report: "eda_report.md",
  grain: "grain_analysis.md",
  join: "join_analysis.md",
  quality: "data_quality_findings.md",
  /** Directory (relative to artifact dir) holding the generated `.sql` files. */
  sqlDir: "sql_queries",
} as const;

// --- I/O schemas -----------------------------------------------------------

export const EdaInputSchema = z.object({
  /** Restrict EDA to these schemas; default = all schemas the provider lists. */
  schemas: z.array(z.string()).optional(),
  /** Actually run the read-only queries (requires a provider + read policy). */
  execute: z.boolean().optional(),
});
export type EdaInput = z.infer<typeof EdaInputSchema>;

export const EdaTableProfileSchema = z.object({
  schema: z.string(),
  name: z.string(),
  rowCountEstimate: z.number().nullable(),
  candidateKey: z.array(z.string()),
  dateColumns: z.array(z.string()),
  sensitiveColumns: z.array(z.string()),
});

export const EdaOutputSchema = z.object({
  executed: z.boolean(),
  schemasInspected: z.array(z.string()),
  tablesInspected: z.array(EdaTableProfileSchema),
  queryCount: z.number(),
  sqlFiles: z.array(z.string()),
  joinCandidates: z.number(),
  sensitiveColumnCount: z.number(),
  openQuestions: z.array(z.string()),
});
export type EdaOutput = z.infer<typeof EdaOutputSchema>;

// --- helpers ---------------------------------------------------------------

interface ExecutedQuery {
  query: EdaQuery;
  /** First result row (aggregate queries return one row), if executed. */
  row?: Record<string, unknown> | undefined;
  /** Execution error, if any. */
  error?: string | undefined;
}

function bulletList(items: string[], emptyNote: string): string {
  if (items.length === 0) return `_${emptyNote}_`;
  return items.map((i) => `- ${i}`).join("\n");
}

/** Whether the policy + a present provider permit running read queries. */
function canExecute(ctx: TentacleContext): boolean {
  const provider = ctx.providers.warehouse;
  if (!provider) return false;
  // Reads are allowed when the warehouse is read-only-by-default (our queries
  // are all validated read-only). If a deployment turned that off entirely we
  // still only ever issue read SQL, but we honor the explicit policy flag.
  return ctx.config.policies.warehouse.read_only_by_default !== false;
}

/** Discover the schemas to inspect (input override → provider → none). */
async function resolveSchemas(
  ctx: TentacleContext,
  input: EdaInput,
  warnings: string[],
): Promise<string[]> {
  if (input.schemas && input.schemas.length > 0) return input.schemas;
  const provider = ctx.providers.warehouse;
  if (!provider) {
    warnings.push(
      "No warehouse provider available; EDA runs in dry-run plan-only mode against no live schema.",
    );
    return [];
  }
  try {
    return await provider.listSchemas();
  } catch (err) {
    warnings.push(`Failed to list schemas: ${asMessage(err)}`);
    return [];
  }
}

/** Collect TableInfo for every table in the given schemas. */
async function collectTables(
  provider: WarehouseProvider,
  schemas: string[],
  warnings: string[],
): Promise<TableInfo[]> {
  const out: TableInfo[] = [];
  for (const schema of schemas) {
    try {
      const tables = await provider.listTables(schema);
      out.push(...tables);
    } catch (err) {
      warnings.push(`Failed to list tables for schema ${schema}: ${asMessage(err)}`);
    }
  }
  return out;
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** First row of a QueryResult, or undefined. */
function firstRow(result: QueryResult): Record<string, unknown> | undefined {
  return result.rows.length > 0 ? result.rows[0] : undefined;
}

// --- the tentacle ----------------------------------------------------------

export const edaTentacle: Tentacle<typeof EdaInputSchema, typeof EdaOutputSchema> = {
  id: "eda",
  title: "Warehouse Discovery & EDA",
  description:
    "Generate and (optionally) run read-only SQL to discover candidate warehouse sources, profile data quality, infer grain, probe join paths, and identify PII — preferring aggregates over raw rows and never leaking sensitive values.",

  inputSchema: EdaInputSchema,
  outputSchema: EdaOutputSchema,

  requiredTools: [],
  optionalTools: [
    "warehouse.listSchemas",
    "warehouse.listTables",
    "warehouse.describeTable",
    "warehouse.executeReadOnlySql",
  ],

  checklist: [
    "Candidate schemas/tables discovered (or dry-run plan emitted)",
    "Every generated query passes the read-only SQL safety gate",
    "Row counts / null rates / distinct counts profiled by aggregate",
    "Candidate grain inferred and uniqueness probed",
    "Date ranges / freshness measured for date columns",
    "Duplicate-key probes generated",
    "Join paths inferred and coverage probed",
    "PII columns identified by name pattern and never sampled raw",
    "No raw sensitive values written to any artifact (redacted)",
    "Every inferred grain/join/quality rule tagged assumption/inferred/open_question",
  ],

  async run(ctx: TentacleContext): Promise<TentacleResult<EdaOutput>> {
    const input = EdaInputSchema.parse({
      schemas: ctx.options.schemas as string[] | undefined,
      execute: ctx.options.execute as boolean | undefined,
    });

    const warnings: string[] = [];
    const openQuestions: string[] = [];
    const provider = ctx.providers.warehouse;

    // --- Execution mode decision. -----------------------------------------
    const executeRequested = input.execute === true;
    const executeAllowed = canExecute(ctx);
    const willExecute = executeRequested && executeAllowed;
    if (executeRequested && !provider) {
      warnings.push(
        "--execute requested but no warehouse provider is configured; falling back to dry-run (SQL + plan only).",
      );
    } else if (executeRequested && !executeAllowed) {
      warnings.push(
        "--execute requested but warehouse reads are not permitted by policy; falling back to dry-run.",
      );
    }

    // --- Discover schemas + tables. ---------------------------------------
    const schemas = await resolveSchemas(ctx, input, warnings);
    const tables =
      provider && schemas.length > 0
        ? await collectTables(provider, schemas, warnings)
        : [];

    if (schemas.length === 0) {
      openQuestions.push(
        "No warehouse schemas available — connect a warehouse provider or specify --schemas to run EDA against live sources.",
      );
    } else if (tables.length === 0) {
      openQuestions.push(
        "No tables found in the inspected schema(s) — confirm the candidate sources and grants.",
      );
    }

    // --- Generate the read-only query set. --------------------------------
    const generated: EdaQuery[] = [];

    // Schema discovery queries (one per schema).
    for (const schema of schemas) {
      generated.push(buildSchemaDiscoveryQuery(schema));
    }

    // Per-table profiling.
    const grainQueries = new Map<string, { table: TableInfo; keyCols: string[] }>();
    for (const table of tables) {
      generated.push(buildRowCountQuery(table));
      generated.push(buildColumnProfileQuery(table));

      const keyCols = inferCandidateKey(table);
      const grainQ = buildGrainQuery(table, keyCols);
      if (grainQ) {
        generated.push(grainQ);
        grainQueries.set(grainQ.name, { table, keyCols });
      } else {
        openQuestions.push(
          `No candidate key found for ${table.schema}.${table.name} — grain must be confirmed manually.`,
        );
      }

      const dupQ = buildDuplicatesQuery(table, keyCols);
      if (dupQ) generated.push(dupQ);

      for (const dc of dateColumns(table)) {
        generated.push(buildFreshnessQuery(table, dc));
      }
    }

    // Join-path probes across the inspected tables.
    const joinCandidates: JoinCandidate[] = inferJoinCandidates(tables);
    for (const jc of joinCandidates) {
      generated.push(buildJoinQuery(jc));
    }

    // --- Re-validate EVERY query through the safety gate. ------------------
    const safe: EdaQuery[] = [];
    for (const q of generated) {
      const verdict = ctx.policy.sql.validate(q.sql);
      if (!verdict.allowed) {
        warnings.push(
          `Dropped generated query "${q.name}" — failed SQL safety gate: ${verdict.reason}`,
        );
        continue;
      }
      // Persist/execute the normalized (LIMIT-capped) form.
      safe.push({ ...q, sql: verdict.normalizedSql ?? q.sql });
    }

    // --- Write the .sql files. --------------------------------------------
    const written: string[] = [];
    const sqlFiles: string[] = [];
    for (const q of safe) {
      const rel = `${ARTIFACT_NAMES.sqlDir}/${q.name}.sql`;
      const header = `-- ${q.description}\n-- kind: ${q.kind} | read-only (validated) | generated by Oswald EDA\n`;
      const path = await ctx.artifacts.write(rel, `${header}${q.sql}\n`);
      written.push(path);
      sqlFiles.push(rel);
    }

    // --- Optionally execute. ----------------------------------------------
    const executed: ExecutedQuery[] = [];
    if (willExecute && provider) {
      for (const q of safe) {
        try {
          const res = await provider.executeReadOnlySql(q.sql);
          if (res.ok && res.data) {
            executed.push({ query: q, row: firstRow(res.data) });
          } else {
            executed.push({ query: q, error: res.error ?? "unknown error" });
            warnings.push(`Query "${q.name}" failed to execute: ${res.error ?? "unknown error"}`);
          }
        } catch (err) {
          executed.push({ query: q, error: asMessage(err) });
          warnings.push(`Query "${q.name}" threw: ${asMessage(err)}`);
        }
      }
    }
    const executedByName = new Map(executed.map((e) => [e.query.name, e]));

    // --- Interpret grain verdicts (only when executed). -------------------
    const grainVerdicts: GrainVerdict[] = [];
    for (const [name, { table, keyCols }] of grainQueries) {
      const exec = executedByName.get(name);
      const verdict = interpretGrain(table, keyCols, exec?.row);
      grainVerdicts.push(verdict);
      if (verdict.status === "duplicates") {
        openQuestions.push(
          `Candidate grain (${keyCols.join(", ")}) for ${verdict.table} is NOT unique (${verdict.distinctKeys}/${verdict.totalRows}) — resolve duplicates or revise the grain.`,
        );
      }
    }

    // --- Sensitive (PII) column inventory. --------------------------------
    const sensitiveByTable = new Map<string, string[]>();
    let sensitiveCount = 0;
    for (const table of tables) {
      const cols = sensitiveColumns(table, (n) => ctx.policy.sensitive.isSensitiveColumn(n));
      if (cols.length > 0) {
        sensitiveByTable.set(`${table.schema}.${table.name}`, cols);
        sensitiveCount += cols.length;
      }
    }

    // --- Evidence ledger (the quality rule). ------------------------------
    const evidence: EvidenceItem[] = [];
    evidence.push(
      markEvidence(
        "execution_mode",
        willExecute ? "executed (read-only)" : "dry-run (SQL + plan only)",
        "confirmed",
        provider ? provider.name : "no provider",
      ),
    );
    for (const schema of schemas) {
      evidence.push(markEvidence("schema", schema, "confirmed", provider?.name ?? "input"));
    }
    if (schemas.length === 0) {
      evidence.push(markEvidence("schema", "unknown", "open_question", "—"));
    }
    for (const v of grainVerdicts) {
      evidence.push(
        markEvidence(
          `grain:${v.table}`,
          v.keyCols.length ? v.keyCols.join(", ") : "none inferred",
          v.status === "unique"
            ? "confirmed"
            : v.status === "duplicates"
              ? "open_question"
              : "inferred",
          willExecute ? "profiled" : "name-heuristic (unverified)",
        ),
      );
    }
    for (const [tbl, cols] of sensitiveByTable) {
      evidence.push(
        markEvidence(`pii:${tbl}`, cols.join(", "), "inferred", "name-pattern match"),
      );
    }

    // --- Render + persist artifacts (redacting any leaked PII). ------------
    const reportMd = ctx.artifacts.renderMarkdown({
      title: "EDA Report",
      summary: willExecute
        ? "Read-only EDA executed against the warehouse. Results below are aggregates only; raw sensitive values were never selected."
        : "Dry-run EDA: read-only SQL and an inspection plan were generated. Run with `--execute` (and a warehouse provider) to populate results.",
      sections: [
        {
          heading: "Overview",
          body: [
            `- **Execution mode:** ${willExecute ? "executed (read-only)" : "dry-run (plan only)"}`,
            `- **Provider:** ${provider ? provider.name : "_none — degraded_"}`,
            `- **Schemas inspected:** ${schemas.length ? schemas.join(", ") : "_none_"}`,
            `- **Tables inspected:** ${tables.length}`,
            `- **Queries generated (validated read-only):** ${safe.length}`,
            `- **Join candidates:** ${joinCandidates.length}`,
            `- **PII columns identified:** ${sensitiveCount}`,
          ].join("\n"),
        },
        {
          heading: "Tables",
          body:
            tables.length > 0
              ? tables
                  .map((t) => {
                    const key = inferCandidateKey(t);
                    return `- **${t.schema}.${t.name}** (${t.columns.length} cols${
                      t.rowCountEstimate != null ? `, ~${t.rowCountEstimate} rows` : ""
                    }) — candidate key: ${key.length ? key.join(", ") : "_none_"}`;
                  })
                  .join("\n")
              : "_No tables inspected._",
        },
        {
          heading: "Generated Queries",
          body:
            safe.length > 0
              ? safe.map((q) => `- \`${ARTIFACT_NAMES.sqlDir}/${q.name}.sql\` — ${q.description}`).join("\n")
              : "_No queries generated._",
        },
        { heading: "Evidence Ledger", body: renderEvidenceTable(evidence) },
        {
          heading: "Open Questions",
          body: bulletList(openQuestions, "none — EDA assumptions appear sound"),
        },
      ],
    });

    const grainMd = ctx.artifacts.renderMarkdown({
      title: "Grain Analysis",
      summary:
        "Candidate grain inferred from column naming heuristics. Uniqueness is confirmed only when EDA is executed; otherwise it is an unverified inference.",
      sections: [
        {
          heading: "Candidate Grains",
          body:
            grainVerdicts.length > 0
              ? [
                  "| Table | Candidate Key | Status | Distinct / Total |",
                  "| --- | --- | --- | --- |",
                  ...grainVerdicts.map(
                    (v) =>
                      `| ${v.table} | ${v.keyCols.join(", ") || "—"} | \`${v.status}\` | ${
                        v.distinctKeys ?? "?"
                      } / ${v.totalRows ?? "?"} |`,
                  ),
                ].join("\n")
              : "_No candidate grains inferred — confirm grain manually for each source._",
        },
        {
          heading: "Notes",
          body:
            "A grain is `unique` only when distinct key count equals total rows in an executed profile. `duplicates` means the key is not unique and must be resolved. `unknown` means EDA was not executed (dry-run).",
        },
      ],
    });

    const joinMd = ctx.artifacts.renderMarkdown({
      title: "Join Analysis",
      summary:
        "Join paths inferred from shared id-like column names across the inspected tables. Coverage is measured by the generated LEFT JOIN probes when executed.",
      sections: [
        {
          heading: "Inferred Join Paths",
          body:
            joinCandidates.length > 0
              ? joinCandidates
                  .map((j) => {
                    const exec = executedByName.get(
                      `join__${slug(j.left.name)}__${slug(j.right.name)}__${slug(j.column)}`,
                    );
                    const cov =
                      exec?.row && exec.row["left_keys"] != null
                        ? ` — matched ${exec.row["matched_keys"]}/${exec.row["left_keys"]} keys`
                        : "";
                    return `- **${j.left.schema}.${j.left.name}** → **${j.right.schema}.${j.right.name}** on \`${j.column}\`${cov} _(inferred from shared column name — verify FK semantics)_`;
                  })
                  .join("\n")
              : "_No join paths inferred — no id-like columns are shared across the inspected tables._",
        },
      ],
    });

    const qualityMd = ctx.artifacts.renderMarkdown({
      title: "Data Quality Findings",
      summary: willExecute
        ? "Null rates, distinct counts, freshness, and duplicate probes were executed (aggregates only)."
        : "Data-quality probes were generated but not executed (dry-run). PII columns are identified by name regardless of execution.",
      sections: [
        {
          heading: "PII / Sensitive Columns (by name)",
          body:
            sensitiveByTable.size > 0
              ? [...sensitiveByTable.entries()]
                  .map(([tbl, cols]) => `- **${tbl}:** ${cols.join(", ")}`)
                  .join("\n")
              : "_No PII columns detected by name pattern (does not guarantee absence — review samples manually)._",
        },
        {
          heading: "Duplicate / Uniqueness Risks",
          body: bulletList(
            grainVerdicts
              .filter((v) => v.status === "duplicates")
              .map((v) => `${v.table}: key (${v.keyCols.join(", ")}) has duplicates (${v.distinctKeys}/${v.totalRows}).`),
            willExecute ? "no duplicate-key violations found" : "not evaluated (dry-run)",
          ),
        },
        {
          heading: "Freshness / Date Coverage",
          body: bulletList(
            tables.flatMap((t) =>
              dateColumns(t).map((dc) => `${t.schema}.${t.name}.${dc} — freshness probe generated`),
            ),
            "no date columns detected",
          ),
        },
        {
          heading: "Open Questions",
          body: bulletList(openQuestions, "none"),
        },
      ],
    });

    for (const [name, md] of [
      [ARTIFACT_NAMES.report, reportMd],
      [ARTIFACT_NAMES.grain, grainMd],
      [ARTIFACT_NAMES.join, joinMd],
      [ARTIFACT_NAMES.quality, qualityMd],
    ] as const) {
      const { content } = ctx.policy.sensitive.redactArtifactContent(md);
      const path = await ctx.artifacts.write(name, content);
      written.push(path);
    }

    // --- Advance workflow state. ------------------------------------------
    // EDA complete → move the pipeline into `design` so `oswald next` → `design`.
    await advanceWorkflow(ctx, {
      phase: "design",
      lastCommand: "eda",
      artifacts: {
        eda: ARTIFACT_NAMES.report,
        grain_analysis: ARTIFACT_NAMES.grain,
        join_analysis: ARTIFACT_NAMES.join,
        data_quality_findings: ARTIFACT_NAMES.quality,
      },
      requirements: {
        unresolved_questions: openQuestions,
      },
    });

    // --- Structured output. -----------------------------------------------
    const output: EdaOutput = EdaOutputSchema.parse({
      executed: willExecute,
      schemasInspected: schemas,
      tablesInspected: tables.map((t) => ({
        schema: t.schema,
        name: t.name,
        rowCountEstimate: t.rowCountEstimate ?? null,
        candidateKey: inferCandidateKey(t),
        dateColumns: dateColumns(t),
        sensitiveColumns: sensitiveColumns(t, (n) =>
          ctx.policy.sensitive.isSensitiveColumn(n),
        ),
      })),
      queryCount: safe.length,
      sqlFiles,
      joinCandidates: joinCandidates.length,
      sensitiveColumnCount: sensitiveCount,
      openQuestions,
    });

    ctx.logger.info(
      `eda: ${willExecute ? "executed" : "dry-run"} — ${tables.length} table(s), ${safe.length} read-only query(ies), ${sensitiveCount} PII column(s), ${openQuestions.length} open question(s)`,
    );

    return {
      artifactsWritten: written,
      summary: `EDA ${willExecute ? "executed" : "dry-run"}: ${tables.length} table(s), ${safe.length} read-only query(ies), ${joinCandidates.length} join path(s), ${sensitiveCount} PII column(s).`,
      output,
      ...(openQuestions.length ? { openQuestions } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  },
};
