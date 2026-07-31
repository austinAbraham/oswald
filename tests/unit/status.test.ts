import { describe, it, expect, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildProgram } from "../../src/cli/index.js";
import {
  buildStatusReport,
  renderProgress,
  type StatusReport,
} from "../../src/core/status/index.js";
import { ARTIFACT_FILES } from "../../src/core/artifacts/index.js";
import {
  createInitialState,
  writeState,
  type OswaldState,
} from "../../src/core/state/index.js";
import {
  MockWarehouseProvider,
  MockDocumentProvider,
} from "../../src/tools/providers/mock/index.js";
import { fixedClock } from "../../src/utils/time.js";

// Mock the `snow` CLI probe so the CLI-level tests below never spawn a real
// subprocess: `detectSnow` runs `snow --version`, which is slow (and
// machine-dependent) when the Snowflake CLI is installed. Everything else in
// the module stays real.
vi.mock("../../src/tools/snowflake/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/tools/snowflake/index.js")>();
  return {
    ...actual,
    detectSnow: vi.fn(() => ({ available: false })),
  };
});

const tmpDirs: string[] = [];
async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oswald-status-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (tmpDirs.length) {
    await fs.rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

const T0 = "2026-06-22T00:00:00.000Z";

async function seedState(
  root: string,
  mutate?: (s: OswaldState) => void,
  artifactDir?: string,
): Promise<OswaldState> {
  const state = createInitialState({
    projectName: "status-test",
    projectRoot: root,
    clock: fixedClock(T0),
  });
  mutate?.(state);
  if (artifactDir) {
    await writeState(state, artifactDir);
  } else {
    await writeState(state);
  }
  return state;
}

describe("renderProgress", () => {
  it("renders a deterministic plain-text bar", () => {
    expect(renderProgress(0)).toBe("[----------] 0%");
    expect(renderProgress(0.5)).toBe("[#####-----] 50%");
    expect(renderProgress(1)).toBe("[##########] 100%");
  });

  it("clamps out-of-range and non-finite input", () => {
    expect(renderProgress(-1)).toBe("[----------] 0%");
    expect(renderProgress(2)).toBe("[##########] 100%");
    expect(renderProgress(Number.NaN)).toBe("[----------] 0%");
  });
});

describe("buildStatusReport: uninitialized project", () => {
  it("degrades gracefully when .oswald/state.yml is missing", async () => {
    const dir = await makeTmpDir();
    const report = await buildStatusReport({ cwd: dir });

    expect(report.initialized).toBe(false);
    expect(report.phase).toBeNull();
    expect(report.project).toBeNull();
    expect(report.requirements).toBeNull();
    expect(report.blockers).toEqual([]);
    expect(report.nextCommand).toBeNull();
    expect(report.thenCommand).toBeNull();
    expect(report.stateDetail).toMatch(/oswald init/);
    expect(report.hint).toMatch(/oswald init/);
    expect(report.hint).toMatch(/oswald intake/);

    // Every canonical artifact is reported, all missing.
    expect(report.artifacts.length).toBe(Object.keys(ARTIFACT_FILES).length);
    expect(report.artifacts.every((a) => !a.exists)).toBe(true);
  });

  it("degrades gracefully when state.yml exists but is invalid", async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(path.join(dir, ".oswald"), { recursive: true });
    await fs.writeFile(path.join(dir, ".oswald", "state.yml"), "version: 1\n", "utf8");

    const report = await buildStatusReport({ cwd: dir });
    expect(report.initialized).toBe(false);
    expect(report.stateDetail).toMatch(/Invalid Oswald state/);
    // The state file itself exists, so the registry marks it present.
    expect(report.artifacts.find((a) => a.key === "state")?.exists).toBe(true);
  });
});

describe("buildStatusReport: initialized project", () => {
  it("surfaces phase, ticket, requirements, and the next + successor command", async () => {
    const dir = await makeTmpDir();
    await seedState(dir, (s) => {
      s.status.phase = "eda";
      s.ticket = { id: "TICKET-42", provider: "mock", url: null };
      s.requirements.completeness = 0.6;
      s.requirements.unresolved_questions = ["What is the grain?", "Which source?"];
      s.requirements.acceptance_criteria_found = true;
    });

    const report = await buildStatusReport({ cwd: dir });
    expect(report.initialized).toBe(true);
    expect(report.project?.name).toBe("status-test");
    expect(report.phase).toBe("eda");
    expect(report.ticket.id).toBe("TICKET-42");
    expect(report.ticket.provider).toBe("mock");
    expect(report.requirements).toEqual({
      completeness: 0.6,
      unresolvedQuestions: 2,
      acceptanceCriteriaFound: true,
    });
    expect(report.blockers).toEqual([]);

    // eda phase → run `oswald eda`, which advances toward design → `oswald design`.
    expect(report.nextCommand).toBe("eda");
    expect(report.nextPhase).toBe("design");
    expect(report.thenCommand).toBe("design");
    expect(report.hint).toBeNull();
  });

  it("reports which canonical artifacts exist vs are missing", async () => {
    const dir = await makeTmpDir();
    await seedState(dir);
    await fs.writeFile(path.join(dir, ".oswald", "intake.md"), "# Intake\n", "utf8");

    const report = await buildStatusReport({ cwd: dir });
    const byKey = new Map(report.artifacts.map((a) => [a.key, a]));
    expect(byKey.get("state")?.exists).toBe(true);
    expect(byKey.get("intake")?.exists).toBe(true);
    expect(byKey.get("intake")?.file).toBe("intake.md");
    expect(byKey.get("eda")?.exists).toBe(false);
    expect(report.artifacts.filter((a) => a.exists).length).toBe(2);
  });

  it("surfaces blockers and stops recommending a command when blocked", async () => {
    const dir = await makeTmpDir();
    await seedState(dir, (s) => {
      s.status.phase = "blocked";
      s.status.blockers = ["validation gate failed: row counts diverge"];
    });

    const report = await buildStatusReport({ cwd: dir });
    expect(report.phase).toBe("blocked");
    expect(report.blockers).toEqual(["validation gate failed: row counts diverge"]);
    expect(report.nextCommand).toBeNull();
    expect(report.thenCommand).toBeNull();
  });

  it("treats shipped as terminal (no next or successor command)", async () => {
    const dir = await makeTmpDir();
    await seedState(dir, (s) => {
      s.status.phase = "shipped";
    });

    const report = await buildStatusReport({ cwd: dir });
    expect(report.phase).toBe("shipped");
    expect(report.nextCommand).toBeNull();
    expect(report.nextPhase).toBeNull();
    expect(report.thenCommand).toBeNull();
  });
});

describe("buildStatusReport: configured artifact dir", () => {
  it("reads state and artifacts from a non-default artifactDir", async () => {
    const dir = await makeTmpDir();
    await seedState(
      dir,
      (s) => {
        s.status.phase = "eda";
      },
      ".oz",
    );
    await fs.writeFile(path.join(dir, ".oz", "intake.md"), "# Intake\n", "utf8");

    const report = await buildStatusReport({ cwd: dir, artifactDir: ".oz" });
    expect(report.initialized).toBe(true);
    expect(report.phase).toBe("eda");
    expect(report.nextCommand).toBe("eda");
    const byKey = new Map(report.artifacts.map((a) => [a.key, a]));
    expect(byKey.get("state")?.exists).toBe(true);
    expect(byKey.get("intake")?.exists).toBe(true);

    // Sanity: the same project through the DEFAULT dir sees none of it.
    const viaDefault = await buildStatusReport({ cwd: dir });
    expect(viaDefault.initialized).toBe(false);
    expect(viaDefault.artifacts.every((a) => !a.exists)).toBe(true);
  });
});

describe("oswald status CLI: config resolution", () => {
  /** Run `oswald status --json` through the real CLI and parse stdout. */
  async function statusJson(root: string): Promise<StatusReport> {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const prevExit = process.exitCode;
    try {
      const program = buildProgram();
      program.exitOverride();
      await program.parseAsync([
        "node",
        "oswald",
        "status",
        "--cwd",
        root,
        "--json",
      ]);
      const out = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      return JSON.parse(out) as StatusReport;
    } finally {
      logSpy.mockRestore();
      process.exitCode = prevExit;
    }
  }

  it("honors paths.artifact_dir from oswald.yml (the dir the pipeline writes)", async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(
      path.join(dir, "oswald.yml"),
      "project:\n  name: status-test\npaths:\n  artifact_dir: .oz\n",
      "utf8",
    );
    await seedState(
      dir,
      (s) => {
        s.status.phase = "eda";
        s.ticket = { id: "TICKET-7", provider: "mock", url: null };
      },
      ".oz",
    );

    const report = await statusJson(dir);
    expect(report.initialized).toBe(true);
    expect(report.phase).toBe("eda");
    expect(report.ticket.id).toBe("TICKET-7");
    expect(report.artifacts.find((a) => a.key === "state")?.exists).toBe(true);
  });

  it("falls back to the default artifact dir when oswald.yml is invalid", async () => {
    const dir = await makeTmpDir();
    // Fails schema validation: project.name must not be empty.
    await fs.writeFile(
      path.join(dir, "oswald.yml"),
      "project:\n  name: ''\n",
      "utf8",
    );
    await seedState(dir); // default .oswald

    // The read-only dashboard still renders (from .oswald) instead of crashing;
    // `doctor` is the tool that reports the config problem.
    const report = await statusJson(dir);
    expect(report.initialized).toBe(true);
    expect(report.project?.name).toBe("status-test");
  });
});

describe("buildStatusReport: tool health", () => {
  it("includes provider health via the same probe doctor runs", async () => {
    const dir = await makeTmpDir();
    const report = await buildStatusReport({
      cwd: dir,
      providers: [new MockWarehouseProvider(), new MockDocumentProvider()],
    });

    expect(report.providers.length).toBe(2);
    expect(report.providers[0]?.kind).toBe("warehouse");
    expect(report.providers[0]?.health.state).toBeDefined();
  });

  it("passes the injected snow detection through verbatim and defaults to null", async () => {
    const dir = await makeTmpDir();
    const withSnow = await buildStatusReport({
      cwd: dir,
      snow: { available: false },
    });
    expect(withSnow.snow).toEqual({ available: false });

    const withoutSnow = await buildStatusReport({ cwd: dir });
    expect(withoutSnow.snow).toBeNull();
  });

  it("never throws when a provider health check throws", async () => {
    const dir = await makeTmpDir();
    const broken = new MockWarehouseProvider();
    broken.health = async () => {
      throw new Error("boom");
    };

    const report = await buildStatusReport({ cwd: dir, providers: [broken] });
    expect(report.providers[0]?.health.state).toBe("unavailable");
    expect(report.providers[0]?.health.detail).toMatch(/boom/);
  });
});
