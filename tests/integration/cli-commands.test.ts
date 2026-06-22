/**
 * Integration tests for the wired CLI command surface.
 *
 * These drive the shared runner + program directly against a temp project,
 * proving each pipeline command builds a context, runs its tentacle, writes
 * artifacts, advances state, and returns the right exit code — and that the
 * non-tentacle commands (build/ship/compact) and `next --run` behave.
 *
 * Deterministic: temp dirs, no network, no live LLM. Logger output is captured
 * so the assertions never depend on console formatting.
 */
import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runTentacleCommand, resolveConsent } from "../../src/cli/commands/_run.js";
import { buildProgram } from "../../src/cli/index.js";
import { selectProviders } from "../../src/cli/commands/_providers.js";
import { createInitialState, writeState, readState } from "../../src/core/state/index.js";
import { createLogger, type Logger } from "../../src/core/logging/index.js";
import { systemClock } from "../../src/utils/time.js";

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oswald-cli-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

const TICKET = `# Build a daily active customers model

## Background
Finance needs a daily report of active customers sourced from Salesforce and Stripe.

## Requirements
- Produce a dbt model fct_daily_active_customers
- Grain: one row per customer per day
- Read from salesforce.accounts and stripe.charges

## Acceptance criteria
- [ ] Model builds cleanly in the sandbox
- [ ] Row count matches the legacy report within 1%
`;

/** A logger that records every line for assertions. */
function captureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = createLogger({
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
  });
  return { logger, lines };
}

async function seedState(root: string, ticketId?: string): Promise<void> {
  const state = createInitialState({
    projectName: "cli-test",
    projectRoot: root,
    clock: systemClock,
    ...(ticketId ? { ticket: { id: ticketId, provider: null, url: null } } : {}),
  });
  await fs.mkdir(path.join(root, ".oswald"), { recursive: true });
  await writeState(state, ".oswald");
}

describe("CLI: resolveConsent", () => {
  it("draft always forces draft-only even with other consent flags", () => {
    expect(resolveConsent({ draft: true, yes: true })).toBe(false);
    expect(resolveConsent({ draft: true, post: true })).toBe(false);
  });

  it("any of yes/post/open/apply grants consent", () => {
    expect(resolveConsent({ yes: true })).toBe(true);
    expect(resolveConsent({ post: true })).toBe(true);
    expect(resolveConsent({ open: true })).toBe(true);
    expect(resolveConsent({ apply: true })).toBe(true);
    expect(resolveConsent({})).toBe(false);
  });
});

describe("CLI: selectProviders", () => {
  it("localOnly drops every provider", () => {
    const p = selectProviders({ cwd: "/tmp", localOnly: true, ticket: true, repo: true });
    expect(p.ticket).toBeUndefined();
    expect(p.repo).toBeUndefined();
    expect(p.warehouse).toBeUndefined();
  });

  it("wires only the requested providers", () => {
    const p = selectProviders({ cwd: "/tmp", warehouse: "mock", repo: true });
    expect(p.warehouse).toBeDefined();
    expect(p.repo).toBeDefined();
    expect(p.ticket).toBeUndefined();
    expect(p.document).toBeUndefined();
  });
});

describe("CLI: runTentacleCommand", () => {
  it("runs intake from a markdown fixture, writes artifacts, advances state, exit 0", async () => {
    const root = await makeTmpDir();
    const fixture = path.join(root, "ticket.md");
    await fs.writeFile(fixture, TICKET, "utf8");
    const { logger, lines } = captureLogger();

    const outcome = await runTentacleCommand({
      id: "intake",
      command: "intake",
      cwd: root,
      ticketId: "CLI-1",
      options: { fromFile: fixture },
      initStateIfMissing: true,
      logger,
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.artifactsWritten.length).toBeGreaterThan(0);
    for (const p of outcome.artifactsWritten) {
      await expect(fs.access(p)).resolves.toBeUndefined();
    }
    // Standard output block elements are present.
    expect(lines.some((l) => l.includes("intake:"))).toBe(true);
    expect(lines.some((l) => l.includes("artifacts"))).toBe(true);
    expect(lines.some((l) => l.includes("next:"))).toBe(true);

    // State advanced + ticket id persisted by the runner.
    const state = await readState(root);
    expect(state.status.phase).toBe("clarification");
    expect(state.ticket.id).toBe("CLI-1");
  });

  it("returns exit code 2 when validation parks the workflow in blocked", async () => {
    const root = await makeTmpDir();
    const fixture = path.join(root, "ticket.md");
    await fs.writeFile(fixture, TICKET, "utf8");
    const { logger } = captureLogger();

    await runTentacleCommand({
      id: "intake",
      command: "intake",
      cwd: root,
      ticketId: "CLI-2",
      options: { fromFile: fixture },
      initStateIfMissing: true,
      logger,
    });

    const outcome = await runTentacleCommand({
      id: "validate",
      command: "validate",
      cwd: root,
      ticketId: "CLI-2",
      options: { skipExternal: true },
      logger,
    });

    // Deferred (skipped) acceptance checks block → exit 2, state blocked.
    expect(outcome.exitCode).toBe(2);
    const state = await readState(root);
    expect(state.status.phase).toBe("blocked");
  });

  it("returns exit code 1 for an unknown tentacle id", async () => {
    const root = await makeTmpDir();
    await seedState(root);
    const { logger } = captureLogger();
    const outcome = await runTentacleCommand({
      id: "does-not-exist",
      command: "nope",
      cwd: root,
      logger,
    });
    expect(outcome.exitCode).toBe(1);
  });
});

describe("CLI: build / ship / compact via the program", () => {
  /** Run a pipeline far enough that build + delivery have inputs. */
  async function runToPlan(root: string): Promise<void> {
    const fixture = path.join(root, "ticket.md");
    await fs.writeFile(fixture, TICKET, "utf8");
    await seedState(root, "CLI-3");
    await runTentacleCommand({ id: "intake", command: "intake", cwd: root, ticketId: "CLI-3", options: { fromFile: fixture }, initStateIfMissing: true });
    await runTentacleCommand({ id: "context", command: "context", cwd: root, ticketId: "CLI-3", options: { scanRoot: root } });
    await runTentacleCommand({ id: "design", command: "design", cwd: root, ticketId: "CLI-3" });
    await runTentacleCommand({ id: "planning", command: "plan", cwd: root, ticketId: "CLI-3" });
  }

  it("build --dry-run writes a preview + manifest and never touches the project tree", async () => {
    const root = await makeTmpDir();
    await runToPlan(root);

    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync([
      "node", "oswald", "build", "CLI-3", "--cwd", root,
    ]);

    const preview = path.join(root, ".oswald", "build_preview.md");
    const manifest = path.join(root, ".oswald", "changed_files.json");
    await expect(fs.access(preview)).resolves.toBeUndefined();
    await expect(fs.access(manifest)).resolves.toBeUndefined();
    // No project model files were created in dry-run.
    await expect(fs.access(path.join(root, "models"))).rejects.toBeTruthy();
  });

  it("build --apply --yes generates real dbt SQL + schema.yml; --apply alone does not", async () => {
    const root = await makeTmpDir();
    await runToPlan(root);

    // --apply WITHOUT consent → degrades to dry-run, no project files.
    const p1 = buildProgram();
    p1.exitOverride();
    await p1.parseAsync(["node", "oswald", "build", "CLI-3", "--apply", "--cwd", root]);
    await expect(fs.access(path.join(root, "models"))).rejects.toBeTruthy();

    // --apply WITH consent → real model SQL + per-layer schema.yml appear.
    const p2 = buildProgram();
    p2.exitOverride();
    await p2.parseAsync(["node", "oswald", "build", "CLI-3", "--apply", "--yes", "--cwd", root]);
    const modelFiles = (await fs.readdir(path.join(root, "models"), {
      recursive: true,
    } as { recursive: true })) as string[];
    const names = modelFiles.map(String);
    expect(names.some((f) => f.endsWith(".sql"))).toBe(true);
    expect(names.some((f) => f.endsWith("_schema.yml"))).toBe(true);

    // The generated SQL is real + carries TODO(human) markers (no fabricated logic).
    const sqlRel = names.find((f) => f.endsWith(".sql"))!;
    const sql = await fs.readFile(path.join(root, "models", sqlRel), "utf8");
    expect(sql).toMatch(/generated by `oswald build --apply`/);
    expect(sql).toMatch(/TODO\(human\)/);
    expect(sql).toMatch(/\{\{ (source|ref)\(/);

    // The schema.yml is valid dbt v2 with model entries + tests.
    const ymlRel = names.find((f) => f.endsWith("_schema.yml"))!;
    const yml = await fs.readFile(path.join(root, "models", ymlRel), "utf8");
    expect(yml).toMatch(/^version: 2/);
    expect(yml).toMatch(/models:/);
    expect(yml).toMatch(/tests:/);
  });

  it("build --apply is NON-destructive: an existing model is left intact (writes .new)", async () => {
    const root = await makeTmpDir();
    await runToPlan(root);

    // First apply creates the files.
    const p1 = buildProgram();
    p1.exitOverride();
    await p1.parseAsync(["node", "oswald", "build", "CLI-3", "--apply", "--yes", "--cwd", root]);
    const modelFiles = (await fs.readdir(path.join(root, "models"), {
      recursive: true,
    } as { recursive: true })) as string[];
    const sqlRel = modelFiles.map(String).find((f) => f.endsWith(".sql"))!;
    const abs = path.join(root, "models", sqlRel);
    // Tamper the existing file so we can prove it is preserved.
    await fs.writeFile(abs, "-- HUMAN EDITED, DO NOT TOUCH\n", "utf8");

    // Second apply must NOT overwrite — it writes a .new alongside.
    const p2 = buildProgram();
    p2.exitOverride();
    await p2.parseAsync(["node", "oswald", "build", "CLI-3", "--apply", "--yes", "--cwd", root]);

    const preserved = await fs.readFile(abs, "utf8");
    expect(preserved).toBe("-- HUMAN EDITED, DO NOT TOUCH\n");
    await expect(fs.access(`${abs}.new`)).resolves.toBeUndefined();
  });

  it("ship refuses (exit code via thrown override) when no pr_summary exists", async () => {
    const root = await makeTmpDir();
    await runToPlan(root);
    await runTentacleCommand({ id: "validate", command: "validate", cwd: root, ticketId: "CLI-3", options: { skipExternal: true } });

    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(["node", "oswald", "ship", "CLI-3", "--cwd", root]);
    // ship sets process.exitCode = 1 on refusal; no ship_record written.
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    await expect(
      fs.access(path.join(root, ".oswald", "ship_record.md")),
    ).rejects.toBeTruthy();
  });

  it("compact summarizes artifacts into current_context.md", async () => {
    const root = await makeTmpDir();
    await runToPlan(root);

    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(["node", "oswald", "compact", "--cwd", root]);

    const cc = path.join(root, ".oswald", "current_context.md");
    await expect(fs.access(cc)).resolves.toBeUndefined();
    const body = await fs.readFile(cc, "utf8");
    expect(body).toContain("Current Context");
    // Decision log + acceptance criteria are PRESERVED (not archived).
    // (acceptance_criteria.md is written by intake and must survive compaction.)
    await expect(
      fs.access(path.join(root, ".oswald", "acceptance_criteria.md")),
    ).resolves.toBeUndefined();
  });
});
