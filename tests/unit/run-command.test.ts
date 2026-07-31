/**
 * Unit tests for `oswald run <ticket> [--auto]` — the single-command pipeline
 * driver.
 *
 * Each test drives the wired `commander` program exactly as a user would
 * (`oswald run <ticket> --cwd <tmp>`) against a fresh temp project seeded with
 * the example retention ticket. The contract under test:
 *   - without `--auto`: exactly ONE recommended step executes (like next --run);
 *   - with `--auto`: steps loop until a terminal phase, a blocked workflow
 *     (exit 2), an approval gate (exit 3 — consent is NEVER synthesized), or
 *     the --max-steps cap;
 *   - hard-error edges (not initialized, no intake yet, ticket mismatch) exit 1.
 *
 * Deterministic: temp dirs, no network, no live LLM.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildProgram } from "../../src/cli/index.js";
import { readState, updateState } from "../../src/core/state/index.js";
import { fixedClock } from "../../src/utils/time.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const SAMPLE_TICKET = path.join(
  REPO_ROOT,
  "examples",
  "tickets",
  "sample-retention-ticket.md",
);

const TICKET_ID = "AE-1234";
const CLOCK = fixedClock("2026-06-22T00:00:00.000Z");
const tmpDirs: string[] = [];

let stdoutLines: string[] = [];
let stderrLines: string[] = [];

beforeEach(() => {
  stdoutLines = [];
  stderrLines = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    stdoutLines.push(String(line));
  });
  vi.spyOn(console, "error").mockImplementation((line: unknown) => {
    stderrLines.push(String(line));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oswald-run-"));
  tmpDirs.push(dir);
  return dir;
}

/** Run one CLI invocation against the temp project; never throws on exit. */
async function cli(root: string, ...argv: string[]): Promise<number> {
  const program = buildProgram();
  program.exitOverride();
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

function allOutput(): string {
  return [...stdoutLines, ...stderrLines].join("\n");
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Init + intake from the sample fixture — phase lands in `clarification`. */
async function initAndIntake(root: string): Promise<void> {
  await cli(root, "init");
  await cli(root, "intake", TICKET_ID, "--from-file", SAMPLE_TICKET);
}

async function seedPhase(
  root: string,
  phase:
    | "clarification"
    | "ready_for_pr"
    | "ready_for_ticket_update"
    | "shipped",
): Promise<void> {
  await updateState(
    root,
    (s) => ({ ...s, status: { ...s.status, phase } }),
    { clock: CLOCK },
  );
}

describe("run: single-step mode (no --auto)", () => {
  it("executes exactly one recommended step and stops", async () => {
    const root = await makeTmpDir();
    await initAndIntake(root);

    const code = await cli(root, "run", TICKET_ID);

    expect(code).toBe(0);
    const state = await readState(root);
    expect(state.status.phase).toBe("context");
    expect(await exists(path.join(root, ".oswald", "clarification_comment.md"))).toBe(true);
    expect(await exists(path.join(root, ".oswald", "context_pack.md"))).toBe(false);
  });

  it("executes a gated step draft/dry-run only (build never writes models)", async () => {
    const root = await makeTmpDir();
    await initAndIntake(root);
    await cli(root, "clarify", TICKET_ID, "--draft-comment");
    await cli(root, "context", TICKET_ID, "--local-only");
    await cli(root, "eda", TICKET_ID, "--warehouse", "mock", "--dry-run");
    await cli(root, "design", TICKET_ID);
    await cli(root, "plan", TICKET_ID);

    const code = await cli(root, "run", TICKET_ID);

    expect(code).toBe(0);
    const state = await readState(root);
    expect(state.status.phase).toBe("validating");
    expect(await exists(path.join(root, ".oswald", "build_preview.md"))).toBe(true);
    expect(await exists(path.join(root, "models"))).toBe(false);
  });
});

describe("run --auto: loops and parks at the first approval gate", () => {
  it("drives clarify → … → plan, then parks before build with exit 3", async () => {
    const root = await makeTmpDir();
    await initAndIntake(root);

    const code = await cli(root, "run", TICKET_ID, "--auto");

    expect(code).toBe(3);
    const state = await readState(root);
    expect(state.status.phase).toBe("building");

    // The analysis phases all ran…
    for (const f of [
      "clarification_comment.md",
      "context_pack.md",
      "eda_report.md",
      "semantic_model_plan.md",
      "implementation_plan.md",
    ]) {
      expect(await exists(path.join(root, ".oswald", f)), `missing ${f}`).toBe(true);
    }

    // …but the gated step did NOT: no consent was synthesized, no project
    // files were written, and the run tells the human how to proceed.
    expect(await exists(path.join(root, ".oswald", "build_preview.md"))).toBe(false);
    expect(await exists(path.join(root, "models"))).toBe(false);
    expect(allOutput()).toContain("awaiting approval for");
    expect(allOutput()).toContain(`oswald build ${TICKET_ID} --apply --yes`);
  });

  it("parks before pr with the open_pull_request action named", async () => {
    const root = await makeTmpDir();
    await initAndIntake(root);
    await seedPhase(root, "ready_for_pr");

    const code = await cli(root, "run", TICKET_ID, "--auto");

    expect(code).toBe(3);
    expect(allOutput()).toContain("awaiting approval for open_pull_request");
    expect(allOutput()).toContain(`oswald pr ${TICKET_ID} --open --yes`);
    expect(await exists(path.join(root, ".oswald", "pr_summary.md"))).toBe(false);
    const state = await readState(root);
    expect(state.status.phase).toBe("ready_for_pr");
  });

  it("parks before update-ticket with the ticket_update action named", async () => {
    const root = await makeTmpDir();
    await initAndIntake(root);
    await seedPhase(root, "ready_for_ticket_update");

    const code = await cli(root, "run", TICKET_ID, "--auto");

    expect(code).toBe(3);
    expect(allOutput()).toContain("awaiting approval for ticket_update");
    expect(allOutput()).toContain(`oswald update-ticket ${TICKET_ID} --post --yes`);
  });

  it("propagates exit 2 when a step parks the workflow in blocked", async () => {
    const root = await makeTmpDir();
    await initAndIntake(root);
    await cli(root, "clarify", TICKET_ID, "--draft-comment");
    await cli(root, "context", TICKET_ID, "--local-only");
    await cli(root, "eda", TICKET_ID, "--warehouse", "mock", "--dry-run");
    await cli(root, "design", TICKET_ID);
    await cli(root, "plan", TICKET_ID);
    await cli(root, "build", TICKET_ID, "--dry-run");

    // validate is the next step; offline it defers checks and blocks.
    const code = await cli(root, "run", TICKET_ID, "--auto");

    expect(code).toBe(2);
    const state = await readState(root);
    expect(state.status.phase).toBe("blocked");
  });

  it("stops at --max-steps with a non-zero code before a terminal phase", async () => {
    const root = await makeTmpDir();
    await initAndIntake(root);

    const code = await cli(root, "run", TICKET_ID, "--auto", "--max-steps", "2");

    expect(code).toBe(1);
    expect(allOutput()).toContain("--max-steps (2)");
    const state = await readState(root);
    expect(state.status.phase).toBe("eda");
  });
});

describe("run: terminal and already-blocked states", () => {
  it("exits 0 when the pipeline is already complete", async () => {
    const root = await makeTmpDir();
    await initAndIntake(root);
    await seedPhase(root, "shipped");

    const code = await cli(root, "run", TICKET_ID);

    expect(code).toBe(0);
    expect(allOutput()).toContain("pipeline complete");
  });

  it("exits 2 and surfaces blockers when already blocked", async () => {
    const root = await makeTmpDir();
    await initAndIntake(root);
    await updateState(
      root,
      (s) => ({
        ...s,
        status: { ...s.status, phase: "blocked", blockers: ["deferred checks"] },
      }),
      { clock: CLOCK },
    );

    const code = await cli(root, "run", TICKET_ID);

    expect(code).toBe(2);
    expect(allOutput()).toContain("BLOCKED");
    expect(allOutput()).toContain("deferred checks");
  });
});

describe("run: hard-error edges", () => {
  it("exits 1 when Oswald is not initialized", async () => {
    const root = await makeTmpDir();

    const code = await cli(root, "run", TICKET_ID);

    expect(code).toBe(1);
    expect(allOutput()).toContain("not initialized");
  });

  it("exits 1 before intake and points at the intake command", async () => {
    const root = await makeTmpDir();
    await cli(root, "init");

    const code = await cli(root, "run", TICKET_ID);

    expect(code).toBe(1);
    expect(allOutput()).toContain(`oswald intake ${TICKET_ID}`);
  });

  it("refuses to drive a ticket other than the one recorded in state", async () => {
    const root = await makeTmpDir();
    await initAndIntake(root);

    const code = await cli(root, "run", "ZZ-999");

    expect(code).toBe(1);
    expect(allOutput()).toContain("refusing to mix tickets");
    const state = await readState(root);
    expect(state.status.phase).toBe("clarification");
  });
});
