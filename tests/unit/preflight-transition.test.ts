/**
 * Pre-flight transition enforcement — out-of-order commands refuse BEFORE any
 * side effect runs.
 *
 * The enforced state machine is asserted twice: the CLI pre-flights the rule
 * (current phase → the command's target phase) before dispatching a tentacle
 * or writing anything, and `advanceWorkflow` re-asserts it afterwards as the
 * backstop. These tests pin the pre-flight half of that contract: an
 * out-of-order command exits 1 having posted nothing to any provider, written
 * no artifacts or project files, and left state untouched — while idempotent
 * re-runs and sanctioned resumes still pass.
 *
 * Deterministic: temp dirs, no network, no live LLM.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildProgram } from "../../src/cli/index.js";
import { runTentacleCommand } from "../../src/cli/commands/_run.js";
import { readState, updateState } from "../../src/core/state/index.js";
import { createLogger, type Logger } from "../../src/core/logging/index.js";
import { MockTicketProvider } from "../../src/tools/index.js";
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oswald-preflight-"));
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

/** A logger that records every line for assertions. */
function captureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = createLogger({
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
  });
  return { logger, lines };
}

/** Init + intake from the sample fixture — phase lands in `clarification`. */
async function initAndIntake(root: string): Promise<void> {
  await cli(root, "init");
  await cli(root, "intake", TICKET_ID, "--from-file", SAMPLE_TICKET);
}

async function seedPhase(
  root: string,
  phase: "planning" | "eda" | "context",
): Promise<void> {
  await updateState(
    root,
    (s) => ({ ...s, status: { ...s.status, phase } }),
    { clock: CLOCK },
  );
}

describe("pre-flight: an out-of-order tentacle command refuses before side effects", () => {
  it("clarify with post consent from 'planning' never reaches the ticket provider", async () => {
    const root = await makeTmpDir();
    await initAndIntake(root);
    await seedPhase(root, "planning");
    const provider = new MockTicketProvider();
    const getSpy = vi.spyOn(provider, "getTicket");
    const postSpy = vi.spyOn(provider, "postComment");
    const { logger, lines } = captureLogger();

    const outcome = await runTentacleCommand({
      id: "clarification",
      command: "clarify",
      cwd: root,
      ticketId: TICKET_ID,
      providers: { ticket: provider },
      approval: { yes: true, post: true },
      logger,
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.artifactsWritten).toEqual([]);
    expect(getSpy).not.toHaveBeenCalled();
    expect(postSpy).not.toHaveBeenCalled();
    expect(
      lines.some((l) =>
        l.includes("Illegal workflow transition 'planning' → 'context'"),
      ),
    ).toBe(true);
    for (const f of [
      "open_questions.md",
      "scope_risks.md",
      "clarification_comment.md",
    ]) {
      expect(await exists(path.join(root, ".oswald", f)), `wrote ${f}`).toBe(false);
    }
    const state = await readState(root);
    expect(state.status.phase).toBe("planning");
  });
});

describe("pre-flight: build refuses out-of-order before touching the project tree", () => {
  it("build --apply --yes from 'planning' exits 1 with no files written", async () => {
    const root = await makeTmpDir();
    await initAndIntake(root);
    await cli(root, "clarify", TICKET_ID, "--draft-comment");
    await cli(root, "context", TICKET_ID, "--local-only");
    await cli(root, "eda", TICKET_ID, "--warehouse", "mock", "--dry-run");
    await cli(root, "design", TICKET_ID);
    await cli(root, "plan", TICKET_ID);
    await seedPhase(root, "planning");

    const code = await cli(root, "build", TICKET_ID, "--apply", "--yes");

    expect(code).toBe(1);
    expect(allOutput()).toContain(
      "Illegal workflow transition 'planning' → 'validating'",
    );
    expect(await exists(path.join(root, "models"))).toBe(false);
    expect(await exists(path.join(root, ".oswald", "build_preview.md"))).toBe(false);
    expect(await exists(path.join(root, ".oswald", "changed_files.json"))).toBe(false);
    const state = await readState(root);
    expect(state.status.phase).toBe("planning");
  });
});

describe("pre-flight: sanctioned transitions still pass", () => {
  it("allows an idempotent re-run of the phase's own command", async () => {
    const root = await makeTmpDir();
    await initAndIntake(root);
    await cli(root, "clarify", TICKET_ID, "--draft-comment");

    const code = await cli(root, "clarify", TICKET_ID, "--draft-comment");

    expect(code).toBe(0);
    const state = await readState(root);
    expect(state.status.phase).toBe("context");
  });

  it("allows resuming out of blocked into a non-terminal phase", async () => {
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

    const code = await cli(root, "design", TICKET_ID);

    expect(code).toBe(0);
    const state = await readState(root);
    expect(state.status.phase).toBe("planning");
  });
});
