/**
 * Status report — the read-only, at-a-glance run dashboard behind `oswald
 * status`.
 *
 * Pure composition of existing readers: state (`readState`), the workflow
 * state machine (`recommendNextCommand` / `nextState`), the canonical artifact
 * registry (`ARTIFACT_FILES` + `ArtifactManager.exists`), and the same
 * provider-health probes `doctor` uses. No new state, no writes, no side
 * effects — pure data in / data out so it can be unit-tested without touching
 * argv or the process exit code. The `snow` CLI probe is injected by the
 * caller (the CLI passes `detectSnow()`); this module never spawns anything.
 */
import * as path from "node:path";
import { readState, StateError } from "../state/index.js";
import {
  recommendNextCommand,
  nextState,
  type WorkflowState,
} from "../workflow/index.js";
import {
  ArtifactManager,
  ARTIFACT_FILES,
  type ArtifactKey,
} from "../artifacts/index.js";
import type { HealthReport, ToolProvider } from "../../tools/providers/types.js";
import type { SnowDetection } from "../../tools/snowflake/index.js";

/** Presence of one canonical artifact from the {@link ARTIFACT_FILES} registry. */
export interface StatusArtifact {
  key: ArtifactKey;
  file: string;
  exists: boolean;
}

/** Health snapshot for one wired provider (same probe `doctor` runs). */
export interface StatusProviderHealth {
  name: string;
  kind: string;
  health: HealthReport;
}

export interface StatusReport {
  /** True when `.oswald/state.yml` exists and parses. */
  initialized: boolean;
  /** Why state could not be read (missing / invalid) when not initialized. */
  stateDetail: string | null;
  project: { name: string } | null;
  phase: WorkflowState | null;
  ticket: { id: string | null; provider: string | null; url: string | null };
  requirements: {
    /** 0..1 completeness score from state. */
    completeness: number;
    unresolvedQuestions: number;
    acceptanceCriteriaFound: boolean;
  } | null;
  blockers: string[];
  /** Canonical artifacts, in registry order: which exist vs are missing. */
  artifacts: StatusArtifact[];
  /** Provider health, in the order the providers were supplied. */
  providers: StatusProviderHealth[];
  /** Result of the injected `snow` CLI probe; null when the probe was skipped. */
  snow: SnowDetection | null;
  /** Command that advances out of the current phase (null = terminal/unknown). */
  nextCommand: string | null;
  /** The phase that command advances toward. */
  nextPhase: WorkflowState | null;
  /** The command after that — the successor from the linear state machine. */
  thenCommand: string | null;
  /** Human hint when the project is not initialized. */
  hint: string | null;
}

export interface StatusOptions {
  cwd: string;
  /** Providers to health-check (the same set `doctor` wires). */
  providers?: ToolProvider[];
  /** Pre-computed `snow` CLI probe (pass `detectSnow()`); omit to skip it. */
  snow?: SnowDetection;
  /** Artifact dir (defaults to `.oswald`). */
  artifactDir?: string;
}

/**
 * Render a 0..1 completeness score as a plain deterministic progress bar,
 * e.g. `[######----] 60%`. Out-of-range input is clamped.
 */
export function renderProgress(completeness: number, width = 10): string {
  const clamped = Number.isFinite(completeness)
    ? Math.min(1, Math.max(0, completeness))
    : 0;
  const filled = Math.round(clamped * width);
  const pct = Math.round(clamped * 100);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}] ${pct}%`;
}

/** Build the full status report. Read-only; never throws on missing state. */
export async function buildStatusReport(
  options: StatusOptions,
): Promise<StatusReport> {
  const root = path.resolve(options.cwd);

  // --- Canonical artifacts (registry order). ------------------------------
  const manager = options.artifactDir
    ? new ArtifactManager(root, { artifactDir: options.artifactDir })
    : new ArtifactManager(root);
  const artifacts: StatusArtifact[] = [];
  for (const [key, file] of Object.entries(ARTIFACT_FILES)) {
    artifacts.push({
      key: key as ArtifactKey,
      file,
      exists: await manager.exists(file),
    });
  }

  // --- Provider health (same probe doctor runs; never throws). ------------
  const providers: StatusProviderHealth[] = [];
  for (const p of options.providers ?? []) {
    let health: HealthReport;
    try {
      health = await p.health();
    } catch (err) {
      health = { state: "unavailable", detail: String(err) };
    }
    providers.push({ name: p.name, kind: p.kind, health });
  }

  const base = {
    artifacts,
    providers,
    snow: options.snow ?? null,
  };

  // --- State (degrade gracefully when missing or invalid). ----------------
  try {
    const state = await readState(root, options.artifactDir);
    const phase = state.status.phase;
    const nextCommand = recommendNextCommand(phase);
    const nextPhase = nextState(phase);
    const thenCommand = nextPhase ? recommendNextCommand(nextPhase) : null;
    return {
      ...base,
      initialized: true,
      stateDetail: null,
      project: { name: state.project.name },
      phase,
      ticket: state.ticket,
      requirements: {
        completeness: state.requirements.completeness,
        unresolvedQuestions: state.requirements.unresolved_questions.length,
        acceptanceCriteriaFound: state.requirements.acceptance_criteria_found,
      },
      blockers: state.status.blockers,
      nextCommand,
      nextPhase,
      thenCommand,
      hint: null,
    };
  } catch (err) {
    if (!(err instanceof StateError)) throw err;
    return {
      ...base,
      initialized: false,
      stateDetail: err.message,
      project: null,
      phase: null,
      ticket: { id: null, provider: null, url: null },
      requirements: null,
      blockers: [],
      nextCommand: null,
      nextPhase: null,
      thenCommand: null,
      hint: "Run 'oswald init' to initialize, then 'oswald intake <ticket>' to start a run.",
    };
  }
}
