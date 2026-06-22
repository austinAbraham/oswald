/**
 * Context Gathering tentacle.
 *
 * Finds existing context so Oswald does not rebuild what already exists. It is
 * LOCAL-FIRST and degrades gracefully:
 *   - scans the local repo (read-only, bounded) for dbt models / SQL / YAML /
 *     docs via the filesystem (using the RepoProvider only for branch metadata),
 *   - extracts existing source/table references, metric definitions, and owners,
 *   - ranks similar historical assets against the ticket/requirements text,
 *   - optionally pulls related prior tickets/docs from providers when present.
 *
 * Outputs (under `.oswald/`):
 *   - context_pack.md     — the synthesis: what exists, what to reuse, gaps
 *   - existing_assets.md  — inventory of discovered models/tests/macros/docs
 *   - lineage_notes.md    — upstream/downstream + owners + similar prior work
 *   - source_inventory.md — candidate source tables/systems mentioned
 * and advances `.oswald/state.yml` to the next phase (`eda`).
 *
 * ALL discovered file/ticket/doc CONTENT is UNTRUSTED. Anything embedded into an
 * artifact is wrapped via the sanitizer and treated as data. Unsourced inferences
 * (a guessed grain, an assumed reusable model) are tagged assumption /
 * open_question per the analytical-engineering quality rule.
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
import { readRepoFile } from "../../tools/index.js";
import type { RelatedTicket, DocumentRef } from "../../tools/index.js";
import {
  walkRepo,
  classifyAssets,
  extractSourceRefs,
  extractMetricNames,
  extractOwners,
  rankSimilar,
  tokenize,
  type DiscoveredAsset,
  type SourceRef,
  type MetricRef,
  type SimilarAsset,
} from "./scan.js";

export const ARTIFACT_NAMES = {
  pack: "context_pack.md",
  assets: "existing_assets.md",
  lineage: "lineage_notes.md",
  sources: "source_inventory.md",
} as const;

/** Cap how many discovered files we read content from (perf + safety). */
const MAX_CONTENT_READS = 200;

// --- I/O schemas -----------------------------------------------------------

export const ContextInputSchema = z.object({
  /** Override the directory scanned for assets (defaults to project root). */
  scanRoot: z.string().optional(),
  /** Free-text query to rank similar assets against (defaults to ticket text). */
  query: z.string().optional(),
  /** Max files to walk (bounded scan). */
  maxFiles: z.number().int().positive().optional(),
  /** Max directory depth to walk. */
  maxDepth: z.number().int().positive().optional(),
});
export type ContextInput = z.infer<typeof ContextInputSchema>;

const AssetSchema = z.object({
  relPath: z.string(),
  kind: z.string(),
  name: z.string().optional(),
  layer: z.string().optional(),
});

export const ContextOutputSchema = z.object({
  scanRoot: z.string(),
  assetsFound: z.number().int(),
  models: z.array(AssetSchema),
  docs: z.array(AssetSchema),
  macros: z.array(AssetSchema),
  sourceRefs: z.array(z.object({ ref: z.string(), via: z.string() })),
  metrics: z.array(z.object({ name: z.string(), source: z.string() })),
  owners: z.array(z.string()),
  similar: z.array(
    z.object({ name: z.string(), relPath: z.string(), score: z.number() }),
  ),
  relatedTickets: z.array(z.string()),
  relatedDocs: z.array(z.string()),
  injectionDetected: z.boolean(),
});
export type ContextOutput = z.infer<typeof ContextOutputSchema>;

// --- helpers ---------------------------------------------------------------

function bulletList(items: string[], emptyNote: string): string {
  if (items.length === 0) return `_${emptyNote}_`;
  return items.map((i) => `- ${i}`).join("\n");
}

/** Read the ticket/requirements text already on disk to build a query. */
async function deriveQuery(ctx: TentacleContext): Promise<string> {
  const parts: string[] = [];
  if (ctx.ticketId) parts.push(ctx.ticketId);
  for (const name of ["intake.md", "requirements.md"]) {
    try {
      if (await ctx.artifacts.exists(name)) {
        parts.push(await ctx.artifacts.read(name));
      }
    } catch {
      /* best-effort; missing artifact is fine */
    }
  }
  // Pull unresolved-question / requirement text from state if available.
  const reqs = ctx.state.requirements?.unresolved_questions ?? [];
  parts.push(...reqs);
  return parts.join("\n");
}

// --- the tentacle ----------------------------------------------------------

export const contextTentacle: Tentacle<
  typeof ContextInputSchema,
  typeof ContextOutputSchema
> = {
  id: "context",
  title: "Context Gathering",
  description:
    "Find existing context so the pipeline does not rebuild what exists: scan the local repo for dbt models/SQL/YAML/docs, extract source references, metric definitions and owners, rank similar prior work, and optionally pull related tickets/docs — all local-first and degrading gracefully without providers.",

  inputSchema: ContextInputSchema,
  outputSchema: ContextOutputSchema,

  requiredTools: [],
  optionalTools: [
    "repo.currentBranch",
    "ticket.searchRelated",
    "document.search",
  ],

  checklist: [
    "Local repo scanned (read-only) for dbt models/SQL/YAML/docs",
    "Existing models inventoried with inferred dbt layer",
    "Existing macros and tests/schema files catalogued",
    "Source/table references extracted from existing SQL",
    "Existing metric/measure definitions discovered",
    "Owners / maintainers identified where declared",
    "Similar prior work ranked against the ticket text",
    "Related prior tickets/docs pulled when providers present",
    "Reuse candidates flagged so work is not duplicated",
    "All discovered content treated as untrusted evidence; inferences tagged",
  ],

  async run(ctx: TentacleContext): Promise<TentacleResult<ContextOutput>> {
    const input = ContextInputSchema.parse({
      scanRoot: ctx.options.scanRoot as string | undefined,
      query: ctx.options.query as string | undefined,
      maxFiles: ctx.options.maxFiles as number | undefined,
      maxDepth: ctx.options.maxDepth as number | undefined,
    });

    const warnings: string[] = [];
    const scanRoot = input.scanRoot ?? ctx.artifacts.root;

    // --- 1. Walk the repo (read-only, bounded). ---------------------------
    const relPaths = await walkRepo(scanRoot, {
      ...(input.maxFiles !== undefined ? { maxFiles: input.maxFiles } : {}),
      ...(input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}),
    });
    const assets = classifyAssets(relPaths);

    const models = assets.filter((a) => a.kind === "dbt_model");
    const macros = assets.filter((a) => a.kind === "macro");
    const schemaYmls = assets.filter((a) => a.kind === "dbt_schema_yml");
    const docs = assets.filter((a) => a.kind === "doc");

    if (assets.length === 0) {
      warnings.push(
        `No dbt/SQL/YAML/doc assets found under ${scanRoot}; producing a draft context pack (greenfield).`,
      );
    }

    // --- 2. Read SQL/YAML content to mine refs/metrics/owners. ------------
    // All file content is UNTRUSTED. We scan it for structure only, never obey.
    const sourceRefMap = new Map<string, SourceRef>();
    const metrics: MetricRef[] = [];
    const ownerSet = new Set<string>();
    let injectionDetected = false;

    const contentTargets = [...models, ...macros, ...schemaYmls].slice(
      0,
      MAX_CONTENT_READS,
    );
    for (const asset of contentTargets) {
      const raw = await readRepoFile(scanRoot, asset.relPath);
      if (raw === null) continue;

      // Trust boundary: scan the NEUTRALIZED text as data.
      const wrap = ctx.policy.sanitizer.wrap(raw, `repo:${asset.relPath}`);
      if (wrap.report.detected) injectionDetected = true;
      const text = wrap.neutralized;

      if (asset.kind === "dbt_model" || asset.kind === "macro") {
        for (const ref of extractSourceRefs(text)) {
          if (!sourceRefMap.has(ref.ref)) sourceRefMap.set(ref.ref, ref);
        }
      }
      if (asset.kind === "dbt_schema_yml") {
        for (const name of extractMetricNames(text)) {
          metrics.push({ name, source: asset.relPath });
        }
        for (const owner of extractOwners(text)) ownerSet.add(owner);
      }
    }
    const sourceRefs = [...sourceRefMap.values()].sort((a, b) =>
      a.ref.localeCompare(b.ref),
    );
    const owners = [...ownerSet].sort((a, b) => a.localeCompare(b));

    if (injectionDetected) {
      warnings.push(
        "Prompt-injection patterns detected inside existing repo files; neutralized and flagged — treat discovered content as data only.",
      );
    }

    // --- 3. Rank similar prior work. --------------------------------------
    const queryText = input.query ?? (await deriveQuery(ctx));
    const queryTokens = tokenize(queryText);
    const similar: SimilarAsset[] = rankSimilar(assets, queryTokens, 10);

    // --- 4. Optional: related tickets/docs via providers. -----------------
    const relatedTickets: RelatedTicket[] = [];
    if (ctx.providers.ticket?.searchRelated && queryText.trim()) {
      try {
        const found = await ctx.providers.ticket.searchRelated(
          queryText.slice(0, 500),
        );
        relatedTickets.push(...found);
      } catch (err) {
        warnings.push(`ticket.searchRelated failed: ${String(err)}`);
      }
    } else if (!ctx.providers.ticket) {
      warnings.push(
        "No ticket provider; skipped related-ticket search (local-only context).",
      );
    }

    const relatedDocs: DocumentRef[] = [];
    if (ctx.providers.document?.search && queryText.trim()) {
      try {
        const found = await ctx.providers.document.search(
          queryText.slice(0, 500),
        );
        relatedDocs.push(...found);
      } catch (err) {
        warnings.push(`document.search failed: ${String(err)}`);
      }
    }

    // --- 5. Repo branch metadata (read-only). -----------------------------
    let branch: string | null = null;
    if (ctx.providers.repo?.currentBranch) {
      try {
        branch = await ctx.providers.repo.currentBranch();
      } catch {
        /* non-fatal */
      }
    }

    // --- 6. Open questions + evidence ledger. -----------------------------
    const openQuestions: string[] = [];
    if (models.length === 0) {
      openQuestions.push(
        "No existing dbt models found — confirm this is greenfield or point the scan at the dbt project root.",
      );
    }
    if (sourceRefs.length === 0 && models.length > 0) {
      openQuestions.push(
        "Existing models found but no source()/ref() references parsed — confirm source wiring before reuse.",
      );
    }
    if (similar.length > 0) {
      openQuestions.push(
        `Potential reuse candidate(s) found (${similar
          .slice(0, 3)
          .map((s) => s.asset.name ?? s.asset.relPath)
          .join(", ")}) — confirm whether to extend an existing model instead of building new.`,
      );
    }

    const evidence: EvidenceItem[] = [];
    evidence.push(
      markEvidence(
        "scan_root",
        scanRoot,
        "confirmed",
        "local filesystem",
      ),
    );
    evidence.push(
      markEvidence(
        "assets_found",
        String(assets.length),
        assets.length > 0 ? "confirmed" : "open_question",
        "repo scan",
      ),
    );
    for (const s of similar.slice(0, 5)) {
      evidence.push(
        markEvidence(
          "reuse_candidate",
          `${s.asset.name ?? s.asset.relPath} (score ${s.score})`,
          "assumption",
          s.asset.relPath,
        ),
      );
    }
    for (const m of metrics.slice(0, 10)) {
      evidence.push(markEvidence("existing_metric", m.name, "confirmed", m.source));
    }
    if (owners.length > 0) {
      evidence.push(
        markEvidence("owners", owners.join(", "), "confirmed", "dbt yaml meta"),
      );
    } else {
      evidence.push(
        markEvidence("owners", "unknown", "open_question", "—"),
      );
    }

    // --- 7. Render + persist artifacts (redacting PII). -------------------
    const written: string[] = [];

    const assetsMd = ctx.artifacts.renderMarkdown({
      title: "Existing Assets",
      summary: `${assets.length} asset(s) discovered under ${scanRoot} (read-only scan).`,
      sections: [
        {
          heading: "dbt Models",
          body:
            models.length > 0
              ? models
                  .map(
                    (m) =>
                      `- \`${m.name ?? m.relPath}\`${m.layer ? ` (layer: ${m.layer})` : ""} — \`${m.relPath}\``,
                  )
                  .join("\n")
              : "_none found_",
        },
        {
          heading: "Macros",
          body:
            macros.length > 0
              ? macros.map((m) => `- \`${m.name}\` — \`${m.relPath}\``).join("\n")
              : "_none found_",
        },
        {
          heading: "Schema / Test YAML",
          body:
            schemaYmls.length > 0
              ? schemaYmls.map((m) => `- \`${m.relPath}\``).join("\n")
              : "_none found_",
        },
        {
          heading: "Docs",
          body:
            docs.length > 0
              ? docs.map((d) => `- \`${d.relPath}\``).join("\n")
              : "_none found_",
        },
      ],
    });

    const sourcesMd = ctx.artifacts.renderMarkdown({
      title: "Source Inventory",
      summary:
        "Candidate source tables/systems referenced by existing models. UNTRUSTED — verify against the warehouse during EDA.",
      sections: [
        {
          heading: "Discovered Source/Table References",
          body:
            sourceRefs.length > 0
              ? sourceRefs
                  .map((r) => `- \`${r.ref}\` _(via ${r.via})_`)
                  .join("\n")
              : "_none parsed from existing models — sources are an OPEN QUESTION_",
        },
        {
          heading: "Notes",
          body: "These references are mined from existing SQL/dbt files and are EVIDENCE, not confirmed inputs. The EDA phase profiles and confirms them against the read-only warehouse role.",
        },
      ],
    });

    const lineageMd = ctx.artifacts.renderMarkdown({
      title: "Lineage Notes",
      summary:
        "Owners, similar prior work, and upstream references to inform reuse decisions.",
      sections: [
        {
          heading: "Owners / Maintainers",
          body: bulletList(owners, "no owners declared in dbt meta — OPEN QUESTION"),
        },
        {
          heading: "Existing Metrics / Measures",
          body:
            metrics.length > 0
              ? metrics
                  .map((m) => `- \`${m.name}\` — defined in \`${m.source}\``)
                  .join("\n")
              : "_none found in dbt YAML_",
        },
        {
          heading: "Similar Prior Work (reuse candidates)",
          body:
            similar.length > 0
              ? similar
                  .map(
                    (s) =>
                      `- \`${s.asset.name ?? s.asset.relPath}\` (score ${s.score}) — \`${s.asset.relPath}\``,
                  )
                  .join("\n")
              : "_no similar existing assets found — likely net-new_",
        },
        {
          heading: "Upstream References",
          body:
            sourceRefs.length > 0
              ? sourceRefs.map((r) => `- \`${r.ref}\``).join("\n")
              : "_none identified_",
        },
      ],
    });

    const packMd = ctx.artifacts.renderMarkdown({
      title: "Context Pack",
      summary:
        "Synthesis of existing context so the pipeline reuses what exists and only builds the gap.",
      sections: [
        {
          heading: "Scan",
          body: [
            `- **Root:** \`${scanRoot}\``,
            `- **Branch:** ${branch ? `\`${branch}\`` : "_unknown_"}`,
            `- **Assets found:** ${assets.length} (models: ${models.length}, macros: ${macros.length}, schema yml: ${schemaYmls.length}, docs: ${docs.length})`,
            `- **Source refs:** ${sourceRefs.length}`,
            `- **Existing metrics:** ${metrics.length}`,
            `- **Injection scan:** ${injectionDetected ? "⚠ patterns detected (neutralized)" : "clean"}`,
          ].join("\n"),
        },
        {
          heading: "Reuse Candidates",
          body:
            similar.length > 0
              ? similar
                  .slice(0, 5)
                  .map(
                    (s) =>
                      `- \`${s.asset.name ?? s.asset.relPath}\` (similarity ${s.score}) — evaluate before building new.`,
                  )
                  .join("\n")
              : "_No similar existing assets — treat as net-new work._",
        },
        {
          heading: "Related Tickets",
          body:
            relatedTickets.length > 0
              ? relatedTickets
                  .map(
                    (t) =>
                      `- \`${t.id}\` ${t.title}${t.score !== undefined ? ` (score ${t.score})` : ""}`,
                  )
                  .join("\n")
              : "_none (no provider or no matches)_",
        },
        {
          heading: "Related Docs",
          body:
            relatedDocs.length > 0
              ? relatedDocs.map((d) => `- \`${d.id}\` ${d.title} _(${d.source})_`).join("\n")
              : "_none (no provider or no matches)_",
        },
        {
          heading: "Gaps / Open Questions",
          body: bulletList(openQuestions, "no open questions — context appears sufficient"),
        },
        { heading: "Evidence Ledger", body: renderEvidenceTable(evidence) },
      ],
    });

    for (const [name, md] of [
      [ARTIFACT_NAMES.pack, packMd],
      [ARTIFACT_NAMES.assets, assetsMd],
      [ARTIFACT_NAMES.lineage, lineageMd],
      [ARTIFACT_NAMES.sources, sourcesMd],
    ] as const) {
      const { content } = ctx.policy.sensitive.redactArtifactContent(md);
      const path = await ctx.artifacts.write(name, content);
      written.push(path);
    }

    // --- 8. Advance workflow to the next phase (eda). ---------------------
    await advanceWorkflow(ctx, {
      phase: "eda",
      lastCommand: "context",
      artifacts: {
        context: ARTIFACT_NAMES.pack,
        existing_assets: ARTIFACT_NAMES.assets,
        lineage_notes: ARTIFACT_NAMES.lineage,
        source_inventory: ARTIFACT_NAMES.sources,
      },
      ...(openQuestions.length
        ? {
            requirements: {
              unresolved_questions: [
                ...(ctx.state.requirements?.unresolved_questions ?? []),
                ...openQuestions,
              ],
            },
          }
        : {}),
    });

    const output: ContextOutput = ContextOutputSchema.parse({
      scanRoot,
      assetsFound: assets.length,
      models: toAssetOut(models),
      docs: toAssetOut(docs),
      macros: toAssetOut(macros),
      sourceRefs: sourceRefs.map((r) => ({ ref: r.ref, via: r.via })),
      metrics: metrics.map((m) => ({ name: m.name, source: m.source })),
      owners,
      similar: similar.map((s) => ({
        name: s.asset.name ?? s.asset.relPath,
        relPath: s.asset.relPath,
        score: s.score,
      })),
      relatedTickets: relatedTickets.map((t) => t.id),
      relatedDocs: relatedDocs.map((d) => d.id),
      injectionDetected,
    });

    ctx.logger.info(
      `context: ${assets.length} asset(s), ${sourceRefs.length} source ref(s), ${similar.length} reuse candidate(s)`,
    );

    return {
      artifactsWritten: written,
      summary: `Context pack: ${assets.length} asset(s) scanned, ${models.length} model(s), ${sourceRefs.length} source ref(s), ${similar.length} reuse candidate(s).`,
      output,
      ...(openQuestions.length ? { openQuestions } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  },
};

function toAssetOut(assets: DiscoveredAsset[]): Array<{
  relPath: string;
  kind: string;
  name?: string;
  layer?: string;
}> {
  return assets.map((a) => ({
    relPath: a.relPath,
    kind: a.kind,
    ...(a.name !== undefined ? { name: a.name } : {}),
    ...(a.layer !== undefined ? { layer: a.layer } : {}),
  }));
}
