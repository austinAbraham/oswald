/**
 * End-to-end pipeline test.
 *
 * Runs the entire workflow on the example retention ticket + warehouse fixtures,
 * exactly through the wired CLI, in order:
 *
 *   intake → clarify → context → eda(mock) → design → plan → build(dry-run)
 *          → validate(skip-external) → pr(draft) → update-ticket(draft)
 *
 * and asserts the cumulative `.oswald/` artifact set and the final workflow
 * state. It also proves the shipped example warehouse fixtures
 * (`examples/fixtures/*.json`) load into a MockWarehouseProvider so an EDA run
 * is fully offline and deterministic.
 *
 * No network, no live LLM, temp dirs only.
 */
import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildProgram } from "../../src/cli/index.js";
import { readState } from "../../src/core/state/index.js";
import { MockWarehouseProvider } from "../../src/tools/providers/mock/index.js";
import { buildContext } from "../../src/tentacles/base.js";
import { edaTentacle } from "../../src/tentacles/eda/index.js";
import { resolveConfig } from "../../src/cli/commands/_config.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const SAMPLE_TICKET = path.join(
  REPO_ROOT,
  "examples",
  "tickets",
  "sample-retention-ticket.md",
);
const SCHEMA_FIXTURE = path.join(
  REPO_ROOT,
  "examples",
  "fixtures",
  "snowflake-schema.json",
);
const EDA_RESULTS_FIXTURE = path.join(
  REPO_ROOT,
  "examples",
  "fixtures",
  "mock-eda-results.json",
);

const TICKET_ID = "AE-1234";
const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oswald-e2e-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  process.exitCode = 0;
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function cli(root: string, ...argv: string[]): Promise<void> {
  const program = buildProgram();
  program.exitOverride();
  const prev = process.exitCode;
  process.exitCode = 0;
  try {
    await program.parseAsync(["node", "oswald", ...argv, "--cwd", root]);
  } catch {
    /* exitOverride throws on non-zero; command already set exitCode. */
  }
  process.exitCode = prev;
}

function artifact(root: string, name: string): string {
  return path.join(root, ".oswald", name);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

describe("E2E: full pipeline on the sample retention ticket", () => {
  it("runs intake→…→update-ticket and produces the full artifact set + final state", async () => {
    const root = await makeTmpDir();

    await cli(root, "init");
    await cli(root, "intake", TICKET_ID, "--from-file", SAMPLE_TICKET);
    await cli(root, "clarify", TICKET_ID, "--draft-comment");
    await cli(root, "context", TICKET_ID, "--local-only");
    await cli(root, "eda", TICKET_ID, "--warehouse", "mock", "--dry-run");
    await cli(root, "design", TICKET_ID);
    await cli(root, "plan", TICKET_ID);
    await cli(root, "build", TICKET_ID, "--dry-run");
    await cli(root, "validate", TICKET_ID, "--skip-external");
    await cli(root, "pr", TICKET_ID, "--draft");
    await cli(root, "update-ticket", TICKET_ID, "--draft");

    // --- The cumulative artifact set every phase contributed. ---------------
    const expectedArtifacts = [
      "state.yml",
      // intake
      "intake.md",
      "requirements.md",
      "acceptance_criteria.md",
      // clarify
      "open_questions.md",
      "scope_risks.md",
      "clarification_comment.md",
      // context
      "context_pack.md",
      "source_inventory.md",
      // eda
      "eda_report.md",
      "grain_analysis.md",
      "join_analysis.md",
      "data_quality_findings.md",
      // design
      "semantic_model_plan.md",
      // plan
      "model_plan.md",
      "implementation_plan.md",
      // build (dry-run)
      "build_preview.md",
      "changed_files.json",
      // validate
      "validation_report.md",
      "test_results.md",
      // delivery (draft)
      "pr_summary.md",
      "jira_update.md",
    ];

    for (const name of expectedArtifacts) {
      expect(await exists(artifact(root, name)), `missing artifact: ${name}`).toBe(
        true,
      );
    }

    // --- Generated read-only SQL exists under sql_queries/. -----------------
    const sqlFiles = await fs.readdir(artifact(root, "sql_queries"));
    expect(sqlFiles.some((f) => f.endsWith(".sql"))).toBe(true);

    // --- No project model files were ever written (dry-run throughout). -----
    expect(await exists(path.join(root, "models"))).toBe(false);

    // --- Final state: validation deferred under --skip-external → blocked. ---
    // Delivery reads the real validation_report.md, sees the blocking failure,
    // and refuses to mark the pipeline shipped. This is the critical safety
    // property: a draft delivery on un-validated work never auto-ships.
    const state = await readState(root);
    expect(state.status.phase).toBe("blocked");
    expect(state.status.phase).not.toBe("shipped");
    expect(state.status.blockers.length).toBeGreaterThan(0);
  });

  it("the example warehouse fixtures load into a MockWarehouseProvider for offline EDA", async () => {
    const root = await makeTmpDir();
    await cli(root, "init");
    await cli(root, "intake", TICKET_ID, "--from-file", SAMPLE_TICKET);
    await cli(root, "clarify", TICKET_ID, "--draft-comment");
    await cli(root, "context", TICKET_ID, "--local-only");

    // Build the fixture-backed warehouse provider straight from the shipped JSON.
    const schemaJson = JSON.parse(await fs.readFile(SCHEMA_FIXTURE, "utf8"));
    const resultsJson = JSON.parse(await fs.readFile(EDA_RESULTS_FIXTURE, "utf8"));
    const warehouse = new MockWarehouseProvider({
      fixture: {
        schemas: schemaJson.schemas,
        cannedResults: resultsJson.cannedResults,
      },
    });

    // Sanity: the fixture exposes the retention sources.
    const schemas = await warehouse.listSchemas();
    expect(schemas).toEqual(
      expect.arrayContaining(["raw_crm", "raw_events", "raw_billing"]),
    );

    // Run EDA with --execute against the fixture provider, fully offline.
    const ctx = await buildContext({
      projectRoot: root,
      config: await resolveConfig(root),
      ticketId: TICKET_ID,
      providers: { warehouse },
      options: { execute: true },
    });
    const result = await edaTentacle.run(ctx);

    // It inspected the fixture tables and generated validated read-only SQL.
    expect(result.output?.executed).toBe(true);
    expect(result.output?.schemasInspected).toEqual(
      expect.arrayContaining(["raw_crm", "raw_events", "raw_billing"]),
    );
    expect((result.output?.queryCount ?? 0)).toBeGreaterThan(0);

    // PII-by-name columns (email, full_name) were identified and never sampled.
    expect((result.output?.sensitiveColumnCount ?? 0)).toBeGreaterThan(0);

    // No raw PII leaked into the rendered EDA artifacts.
    const quality = await fs.readFile(
      artifact(root, "data_quality_findings.md"),
      "utf8",
    );
    expect(quality).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i); // no raw email addresses
  });
});
