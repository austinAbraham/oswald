/**
 * Integration tests: per-command dry-run / draft behavior through the real CLI.
 *
 * Each test drives the wired `commander` program exactly as a user would
 * (`oswald <cmd> <ticket> --cwd <tmp>`) against a fresh temp project seeded
 * with the example retention ticket + warehouse fixtures. We assert that every
 * command:
 *   - writes the expected `.oswald/` artifacts,
 *   - degrades to draft/dry-run (no external writes, no project-tree edits),
 *   - advances workflow state, and
 *   - that `oswald next` recommends the correct successor from state.
 *
 * Deterministic: temp dirs, no network, no live LLM. The mock providers the CLI
 * wires in are fully offline.
 */
import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildProgram } from "../../src/cli/index.js";
import { readState } from "../../src/core/state/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const SAMPLE_TICKET = path.join(
  REPO_ROOT,
  "examples",
  "tickets",
  "sample-retention-ticket.md",
);

const TICKET_ID = "AE-1234";
const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oswald-pipe-"));
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

/** Run one CLI invocation against the temp project; never throws on exit. */
async function cli(root: string, ...argv: string[]): Promise<number> {
  const program = buildProgram();
  program.exitOverride();
  // Silence the global logger by swapping its sink — output is captured per-test
  // where needed via captureCli().
  const prev = process.exitCode;
  process.exitCode = 0;
  try {
    await program.parseAsync(["node", "oswald", ...argv, "--cwd", root]);
  } catch {
    // exitOverride throws on non-zero/help; the command already set exitCode.
  }
  const code = typeof process.exitCode === "number" ? process.exitCode : 0;
  process.exitCode = prev;
  return code;
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

/** Init + intake from the sample fixture — the precondition for most commands. */
async function initAndIntake(root: string): Promise<void> {
  await cli(root, "init");
  await cli(root, "intake", TICKET_ID, "--from-file", SAMPLE_TICKET);
}

describe("CLI integration: init + intake from a local fixture", () => {
  it("init creates state and intake writes the intake artifact set", async () => {
    const root = await makeTmpDir();

    await cli(root, "init");
    expect(await exists(artifact(root, "state.yml"))).toBe(true);

    await cli(root, "intake", TICKET_ID, "--from-file", SAMPLE_TICKET);

    for (const f of ["intake.md", "requirements.md", "acceptance_criteria.md"]) {
      expect(await exists(artifact(root, f))).toBe(true);
    }

    const state = await readState(root);
    expect(state.ticket.id).toBe(TICKET_ID);
    expect(state.status.phase).toBe("clarification");

    // The retention ticket's acceptance criteria were parsed.
    const ac = await fs.readFile(artifact(root, "acceptance_criteria.md"), "utf8");
    expect(ac.toLowerCase()).toContain("unique");
  });

  it("intake works with NO providers configured (local file only)", async () => {
    const root = await makeTmpDir();
    await cli(root, "init");
    const code = await cli(root, "intake", TICKET_ID, "--from-file", SAMPLE_TICKET);
    expect(code).toBe(0);
    expect(await exists(artifact(root, "intake.md"))).toBe(true);
  });
});

describe("CLI integration: clarify --draft-comment", () => {
  it("drafts a clarification comment without posting (no provider needed)", async () => {
    const root = await makeTmpDir();
    await initAndIntake(root);

    await cli(root, "clarify", TICKET_ID, "--draft-comment");

    expect(await exists(artifact(root, "clarification_comment.md"))).toBe(true);
    expect(await exists(artifact(root, "open_questions.md"))).toBe(true);

    const state = await readState(root);
    expect(state.status.phase).toBe("context");
  });
});

describe("CLI integration: context --local-only", () => {
  it("scans the local repo only and writes the context pack", async () => {
    const root = await makeTmpDir();
    await initAndIntake(root);
    await cli(root, "clarify", TICKET_ID, "--draft-comment");

    await cli(root, "context", TICKET_ID, "--local-only");

    expect(await exists(artifact(root, "context_pack.md"))).toBe(true);
    expect(await exists(artifact(root, "source_inventory.md"))).toBe(true);

    const state = await readState(root);
    expect(state.status.phase).toBe("eda");
  });
});

describe("CLI integration: eda --warehouse mock --dry-run", () => {
  it("generates read-only SQL + reports without executing", async () => {
    const root = await makeTmpDir();
    await initAndIntake(root);
    await cli(root, "clarify", TICKET_ID, "--draft-comment");
    await cli(root, "context", TICKET_ID, "--local-only");

    await cli(root, "eda", TICKET_ID, "--warehouse", "mock", "--dry-run");

    expect(await exists(artifact(root, "eda_report.md"))).toBe(true);
    expect(await exists(artifact(root, "grain_analysis.md"))).toBe(true);
    expect(await exists(artifact(root, "data_quality_findings.md"))).toBe(true);

    // SQL files were generated under sql_queries/.
    const sqlDir = artifact(root, "sql_queries");
    expect(await exists(sqlDir)).toBe(true);
    const sqlFiles = await fs.readdir(sqlDir);
    expect(sqlFiles.some((f) => f.endsWith(".sql"))).toBe(true);

    // Dry-run: the report records plan-only mode, not executed.
    const report = await fs.readFile(artifact(root, "eda_report.md"), "utf8");
    expect(report.toLowerCase()).toContain("dry-run");

    const state = await readState(root);
    expect(state.status.phase).toBe("design");
  });
});

describe("CLI integration: design + plan", () => {
  it("design writes metric/semantic artifacts and advances to planning", async () => {
    const root = await makeTmpDir();
    await initAndIntake(root);
    await cli(root, "clarify", TICKET_ID, "--draft-comment");
    await cli(root, "context", TICKET_ID, "--local-only");
    await cli(root, "eda", TICKET_ID, "--warehouse", "mock", "--dry-run");

    await cli(root, "design", TICKET_ID);

    expect(await exists(artifact(root, "semantic_model_plan.md"))).toBe(true);
    const state = await readState(root);
    expect(state.status.phase).toBe("planning");
  });

  it("plan writes model + implementation plans and DOES NOT touch project files", async () => {
    const root = await makeTmpDir();
    await initAndIntake(root);
    await cli(root, "clarify", TICKET_ID, "--draft-comment");
    await cli(root, "context", TICKET_ID, "--local-only");
    await cli(root, "eda", TICKET_ID, "--warehouse", "mock", "--dry-run");
    await cli(root, "design", TICKET_ID);

    await cli(root, "plan", TICKET_ID);

    expect(await exists(artifact(root, "model_plan.md"))).toBe(true);
    expect(await exists(artifact(root, "implementation_plan.md"))).toBe(true);
    // Planning never writes project model files.
    expect(await exists(path.join(root, "models"))).toBe(false);

    const state = await readState(root);
    expect(state.status.phase).toBe("building");
  });
});

describe("CLI integration: build --dry-run", () => {
  it("writes a change preview + manifest and never creates project files", async () => {
    const root = await makeTmpDir();
    await initAndIntake(root);
    await cli(root, "clarify", TICKET_ID, "--draft-comment");
    await cli(root, "context", TICKET_ID, "--local-only");
    await cli(root, "eda", TICKET_ID, "--warehouse", "mock", "--dry-run");
    await cli(root, "design", TICKET_ID);
    await cli(root, "plan", TICKET_ID);

    await cli(root, "build", TICKET_ID, "--dry-run");

    expect(await exists(artifact(root, "build_preview.md"))).toBe(true);
    expect(await exists(artifact(root, "changed_files.json"))).toBe(true);
    // Dry-run never writes the project tree.
    expect(await exists(path.join(root, "models"))).toBe(false);

    const preview = await fs.readFile(artifact(root, "build_preview.md"), "utf8");
    expect(preview.toLowerCase()).toContain("dry-run");

    const state = await readState(root);
    expect(state.status.phase).toBe("validating");
  });
});

describe("CLI integration: validate --skip-external", () => {
  it("stays local, writes validation artifacts, and blocks on deferred checks", async () => {
    const root = await makeTmpDir();
    await initAndIntake(root);
    await cli(root, "clarify", TICKET_ID, "--draft-comment");
    await cli(root, "context", TICKET_ID, "--local-only");
    await cli(root, "eda", TICKET_ID, "--warehouse", "mock", "--dry-run");
    await cli(root, "design", TICKET_ID);
    await cli(root, "plan", TICKET_ID);
    await cli(root, "build", TICKET_ID, "--dry-run");

    const code = await cli(root, "validate", TICKET_ID, "--skip-external");

    expect(await exists(artifact(root, "validation_report.md"))).toBe(true);
    expect(await exists(artifact(root, "test_results.md"))).toBe(true);

    // Deferred acceptance checks (cannot be reconciled locally) → blocked,
    // and a blocked workflow exits non-zero. The pipeline is never marked ready.
    expect(code).toBe(2);
    const state = await readState(root);
    expect(state.status.phase).toBe("blocked");
  });
});

describe("CLI integration: pr --draft and update-ticket --draft", () => {
  /**
   * Drive the pipeline to the delivery stage. Validation blocks under
   * --skip-external (no reconciliation possible offline); delivery still drafts
   * its artifacts (draft is never gated), which is exactly the degraded path we
   * want to prove writes locally with no external side effects.
   */
  async function driveToDelivery(root: string): Promise<void> {
    await initAndIntake(root);
    await cli(root, "clarify", TICKET_ID, "--draft-comment");
    await cli(root, "context", TICKET_ID, "--local-only");
    await cli(root, "eda", TICKET_ID, "--warehouse", "mock", "--dry-run");
    await cli(root, "design", TICKET_ID);
    await cli(root, "plan", TICKET_ID);
    await cli(root, "build", TICKET_ID, "--dry-run");
    await cli(root, "validate", TICKET_ID, "--skip-external");
  }

  it("pr --draft writes pr_summary.md only (no PR opened)", async () => {
    const root = await makeTmpDir();
    await driveToDelivery(root);

    await cli(root, "pr", TICKET_ID, "--draft");

    expect(await exists(artifact(root, "pr_summary.md"))).toBe(true);
  });

  it("update-ticket --draft writes jira_update.md only (no post)", async () => {
    const root = await makeTmpDir();
    await driveToDelivery(root);

    await cli(root, "update-ticket", TICKET_ID, "--draft");

    expect(await exists(artifact(root, "jira_update.md"))).toBe(true);
  });
});

describe("CLI integration: next recommends the correct step from state", () => {
  it("recommends clarify after intake, eda after context", async () => {
    const root = await makeTmpDir();

    // After intake → phase clarification → recommend `clarify`.
    await initAndIntake(root);
    let s = await readState(root);
    expect(s.status.phase).toBe("clarification");
    expect(s.status.next_recommended_command).toContain("clarify");

    // After context → phase eda → recommend `eda`.
    await cli(root, "clarify", TICKET_ID, "--draft-comment");
    await cli(root, "context", TICKET_ID, "--local-only");
    s = await readState(root);
    expect(s.status.phase).toBe("eda");
    expect(s.status.next_recommended_command).toContain("eda");
  });

  it("next --run executes the recommended command using the ticket id in state", async () => {
    const root = await makeTmpDir();
    await initAndIntake(root); // phase = clarification, ticket recorded

    // `next --run` should dispatch `clarify AE-1234` and advance to context.
    await cli(root, "next", "--run");

    const s = await readState(root);
    expect(s.status.phase).toBe("context");
    expect(await exists(artifact(root, "clarification_comment.md"))).toBe(true);
  });
});
