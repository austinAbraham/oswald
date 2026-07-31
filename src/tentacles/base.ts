/**
 * Tentacle base contract.
 *
 * A *tentacle* is a first-class, self-contained pipeline module (intake, eda,
 * design, plan, build, validate, pr, ...). Each one:
 *   - declares its identity + I/O schemas (zod),
 *   - declares which provider capabilities it wants (required vs optional),
 *   - declares the quality checklist it self-applies,
 *   - degrades gracefully when providers / prior artifacts are missing,
 *   - reads only the artifacts it needs, does DETERMINISTIC work (no live LLM in
 *     the library — tentacles emit prompts/templates + deterministic scaffolding
 *     + artifacts), writes its output artifacts, advances `.oswald/state.yml`,
 *     and returns a compact result.
 *
 * The LLM lives in the host agent runtime, not here. Tentacles produce the
 * structured evidence and the next-step prompts; they never call a model.
 */
import { z } from "zod";
import type { OswaldConfig } from "../core/config/index.js";
import { loadConfig, DEFAULT_CONFIG_FILENAME } from "../core/config/index.js";
import { ArtifactManager } from "../core/artifacts/index.js";
import {
  readState,
  createInitialState,
  writeState,
  DEFAULT_ARTIFACT_DIR,
  type BlockedMode,
  type OswaldState,
} from "../core/state/index.js";
import {
  assertLegalTransition,
  recommendNextCommand,
  type WorkflowState,
} from "../core/workflow/index.js";
import { SqlSafetyValidator } from "../core/policy/sql-safety.js";
import {
  SensitiveFieldDetector,
  redactArtifactContent,
} from "../core/policy/sensitive.js";
import { ExternalContentSanitizer } from "../core/policy/external-content.js";
import { ApprovalService } from "../core/approvals/index.js";
import { AuditLedger } from "../core/audit/index.js";
import {
  type TicketProvider,
  type WarehouseProvider,
  type RepoProvider,
  type DocumentProvider,
} from "../tools/index.js";
import { systemClock, type Clock } from "../utils/time.js";
import { logger as defaultLogger, type Logger } from "../core/logging/index.js";

// ---------------------------------------------------------------------------
// Evidence tagging — the analytical-engineering quality rule.
// ---------------------------------------------------------------------------

/**
 * Every business rule / metric / grain / filter that a tentacle records MUST be
 * tagged with how it was established. Unsourced items are `assumption` or
 * `open_question`, never silently asserted as fact.
 */
export const EVIDENCE_TAGS = [
  "confirmed", // explicitly stated in a sourced artifact / ticket
  "inferred", // derived deterministically from sourced evidence
  "assumption", // a default the tentacle chose; needs human confirmation
  "open_question", // unknown; a human must answer before proceeding
] as const;

export type EvidenceTag = (typeof EVIDENCE_TAGS)[number];

export interface EvidenceItem {
  /** Short label for the thing being established (e.g. "grain", "metric"). */
  label: string;
  /** The value / statement itself. */
  value: string;
  tag: EvidenceTag;
  /** Where this came from (artifact name, ticket id, doc id, "default"). */
  source?: string;
}

/**
 * Construct a tagged evidence item. Centralizing this keeps the tagging
 * vocabulary consistent across all tentacles and makes the quality rule
 * enforceable in one place.
 */
export function markEvidence(
  label: string,
  value: string,
  tag: EvidenceTag,
  source?: string,
): EvidenceItem {
  return source === undefined
    ? { label, value, tag }
    : { label, value, tag, source };
}

/** Render evidence items as a Markdown table (deterministic ordering). */
export function renderEvidenceTable(items: EvidenceItem[]): string {
  if (items.length === 0) {
    return "_No evidence recorded._";
  }
  const rows = items.map(
    (e) =>
      `| ${escapeCell(e.label)} | ${escapeCell(e.value)} | \`${e.tag}\` | ${escapeCell(
        e.source ?? "—",
      )} |`,
  );
  return [
    "| Item | Value | Tag | Source |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function escapeCell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

// ---------------------------------------------------------------------------
// Tentacle context + result.
// ---------------------------------------------------------------------------

/** The bundle of capabilities a tentacle's `run` receives. */
export interface TentacleProviders {
  ticket?: TicketProvider | undefined;
  warehouse?: WarehouseProvider | undefined;
  repo?: RepoProvider | undefined;
  document?: DocumentProvider | undefined;
}

/** The policy toolkit (safety gates) handed to every tentacle. */
export interface TentaclePolicy {
  /** Read-only SQL gate. */
  sql: SqlSafetyValidator;
  /** Sensitive-value detector / redactor. */
  sensitive: SensitiveFieldDetector;
  /** Untrusted external-content sanitizer (prompt-injection neutralizer). */
  sanitizer: ExternalContentSanitizer;
  /** Convenience: redact free-form artifact content before persisting. */
  redact: typeof redactArtifactContent;
}

/** Everything a tentacle needs to do deterministic work. */
export interface TentacleContext {
  config: OswaldConfig;
  artifacts: ArtifactManager;
  providers: TentacleProviders;
  policy: TentaclePolicy;
  approvals: ApprovalService;
  /** The persistent, tamper-evident audit ledger for this project. */
  audit: AuditLedger;
  state: OswaldState;
  clock: Clock;
  logger: Logger;
  /** The ticket id this run targets, if any. */
  ticketId?: string | undefined;
  /** Free-form per-run options (e.g. `{ fromFile: "..." }`, `{ yes: true }`). */
  options: Record<string, unknown>;
}

/** Compact result returned by `run`. */
export interface TentacleResult<Output = unknown> {
  /** Absolute paths of artifacts written this run. */
  artifactsWritten: string[];
  /** One-line human summary. */
  summary: string;
  /** Questions a human must answer before the pipeline can safely proceed. */
  openQuestions?: string[];
  /** Non-fatal warnings (degraded providers, missing optional inputs, ...). */
  warnings?: string[];
  /** The tentacle's validated structured output (matches `outputSchema`). */
  output?: Output;
}

/** The shared contract every tentacle implements. */
export interface Tentacle<
  Input extends z.ZodTypeAny = z.ZodTypeAny,
  Output extends z.ZodTypeAny = z.ZodTypeAny,
> {
  /** Stable id; also the workflow phase / CLI verb it owns. */
  readonly id: string;
  readonly title: string;
  readonly description: string;

  /**
   * The phase a successful run advances the workflow into (the `phase` its
   * `advanceWorkflow` patch carries on the success path — failure paths may
   * land in `blocked`, which is reachable from every non-terminal phase).
   * The CLI pre-flights `canTransition(current, advancesTo)` against this
   * BEFORE running the tentacle, so an out-of-order command refuses without
   * committing any side effect.
   */
  readonly advancesTo: WorkflowState;

  /** Validates the per-run options/input. */
  readonly inputSchema: Input;
  /** Validates the structured output payload (separate from the artifacts). */
  readonly outputSchema: Output;

  /** Provider capabilities required to run at full fidelity. */
  readonly requiredTools: string[];
  /** Provider capabilities that improve the result but are optional. */
  readonly optionalTools: string[];

  /** Self-applied quality checks (rendered into artifacts / audit). */
  readonly checklist: string[];

  /** The deterministic worker. */
  run(ctx: TentacleContext): Promise<TentacleResult<z.infer<Output>>>;
}

// ---------------------------------------------------------------------------
// buildContext factory.
// ---------------------------------------------------------------------------

export interface BuildContextOptions {
  /** Project root (where `.oswald/` lives). Defaults to cwd. */
  projectRoot?: string;
  /** Explicit path to `oswald.yml`. Defaults to `<root>/oswald.yml`. */
  configPath?: string;
  /** Pre-loaded config (skips disk read; useful in tests). */
  config?: OswaldConfig;
  /** Provider overrides. Anything omitted is left undefined (degrade). */
  providers?: TentacleProviders;
  /** Ticket id this run targets. */
  ticketId?: string;
  /** Per-run options forwarded to the tentacle. */
  options?: Record<string, unknown>;
  /** Injected clock (tests pass a fixed clock). Defaults to systemClock. */
  clock?: Clock;
  /** Injected logger. Defaults to the shared logger. */
  logger?: Logger;
  /**
   * Injected audit ledger. Defaults to the project's `.oswald/audit.jsonl`
   * ledger. Callers that already hold a ledger (e.g. the CLI recording
   * provider-selection events) pass it in so one instance owns the hash chain.
   */
  audit?: AuditLedger;
  /**
   * If true and no state file exists yet, seed an in-memory initial state and
   * persist it rather than throwing. Intake (the first tentacle) needs this.
   */
  initStateIfMissing?: boolean;
}

/**
 * Assemble a fully-wired {@link TentacleContext} from a project root.
 *
 * Reads config + state from disk (or accepts injected ones), constructs the
 * policy toolkit from `config.policies`, and threads in providers + clock +
 * logger. This is the single place tentacles (and the CLI) build their context,
 * so every tentacle sees an identically-configured world.
 */
export async function buildContext(
  options: BuildContextOptions = {},
): Promise<TentacleContext> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? defaultLogger;

  const config =
    options.config ??
    (await loadConfig(options.configPath ?? defaultConfigPath(projectRoot)));

  const artifactDir = config.paths.artifact_dir || DEFAULT_ARTIFACT_DIR;
  const artifacts = new ArtifactManager(projectRoot, { artifactDir, clock });
  const audit =
    options.audit ?? new AuditLedger(projectRoot, { artifactDir, clock, logger });

  // State: read existing, or (optionally) seed a fresh one.
  let state: OswaldState;
  try {
    state = await readState(projectRoot, artifactDir);
  } catch (err) {
    if (!options.initStateIfMissing) throw err;
    state = createInitialState({
      projectName: config.project.name,
      projectRoot,
      clock,
      ...(options.ticketId
        ? { ticket: { id: options.ticketId, provider: null, url: null } }
        : {}),
    });
    await artifacts.ensureArtifactDir();
    await writeState(state, artifactDir);
  }

  const policy: TentaclePolicy = {
    sql: new SqlSafetyValidator({
      maxResultRows: config.policies.warehouse.max_result_rows,
      audit,
    }),
    // The detector is the LIVE redaction seam (every tentacle/command persists
    // artifacts through it), so its hits land in the audit ledger too.
    sensitive: new SensitiveFieldDetector({
      enabled: config.policies.privacy.mask_sensitive_values,
      audit,
    }),
    sanitizer: new ExternalContentSanitizer({ audit }),
    // Same signature as redactArtifactContent, but redaction hits land in the
    // audit ledger (counts by kind only — never the redacted values).
    redact: (content: string) => {
      const result = redactArtifactContent(content);
      if (result.report.count > 0) {
        audit.record("redaction_applied", {
          count: result.report.count,
          by_kind: result.report.byKind,
        });
      }
      return result;
    },
  };

  const ticketId = options.ticketId ?? state.ticket.id ?? undefined;

  return {
    config,
    artifacts,
    providers: options.providers ?? {},
    policy,
    approvals: new ApprovalService({
      audit,
      ...(ticketId ? { ticketId } : {}),
    }),
    audit,
    state,
    clock,
    logger,
    ticketId,
    options: options.options ?? {},
  };
}

function defaultConfigPath(projectRoot: string): string {
  return `${projectRoot.replace(/\/+$/, "")}/${DEFAULT_CONFIG_FILENAME}`;
}

// ---------------------------------------------------------------------------
// State-advance helper.
// ---------------------------------------------------------------------------

/**
 * Persist a phase transition + next-recommended-command in `.oswald/state.yml`.
 *
 * Tentacles call this at the end of `run` to advance the workflow. It re-reads
 * state from disk, applies the phase + command + optional requirements/artifact
 * patches, and writes it back (stamping `updated_at` from the injected clock).
 *
 * The state machine is ENFORCED here as the backstop: the patch may keep the
 * current phase (an idempotent re-run of the phase's command) or make a move
 * `canTransition` allows. Anything else throws a `WorkflowTransitionError`
 * before any mutation, leaving state on disk untouched. Commands additionally
 * PRE-FLIGHT the same assertion (via each tentacle's `advancesTo`) before any
 * side effect runs, so an out-of-order command refuses before — not after —
 * external posts or project-tree writes happen.
 */
export interface AdvanceWorkflowPatch {
  /** The phase to move into (this tentacle's completed phase output). */
  phase: WorkflowState;
  /** The command that produced this transition (for `last_command`). */
  lastCommand: string;
  /** Map of artifact key → filename to record under `state.artifacts`. */
  artifacts?: Record<string, string>;
  /** Requirements patch (completeness, unresolved questions, ...). */
  requirements?: Partial<OswaldState["requirements"]>;
  /** Blockers to set (e.g. unresolved open questions that gate progress). */
  blockers?: string[];
  /**
   * Fidelity of the run producing a `blocked` transition: `external` when real
   * external checks executed (dbt build/test, injected validation commands),
   * `local` when only offline classification ran. Only meaningful with
   * `phase: "blocked"`; omit when the blocking run's fidelity is unknown
   * (e.g. delivery re-reading a validation signal) — the recorded mode is then
   * left untouched.
   */
  blockedMode?: BlockedMode;
}

export async function advanceWorkflow(
  ctx: TentacleContext,
  patch: AdvanceWorkflowPatch,
): Promise<OswaldState> {
  const artifactDir = ctx.config.paths.artifact_dir || DEFAULT_ARTIFACT_DIR;
  const current = await readState(ctx.artifacts.root, artifactDir);

  // Enforce state-machine legality BEFORE any bookkeeping: an illegal
  // transition must leave state untouched.
  assertLegalTransition(current.status.phase, patch.phase);

  // Persist content-hash baselines for every artifact written this run (the
  // drift checker's input). A rewrite with IDENTICAL content keeps its
  // original written_at, so an upstream no-op re-run never registers as a
  // change for its downstream consumers.
  const artifactHashes = { ...current.artifact_hashes };
  for (const [name, rec] of Object.entries(ctx.artifacts.recordedHashes())) {
    const prev = artifactHashes[name];
    artifactHashes[name] = prev && prev.sha256 === rec.sha256 ? prev : rec;
  }

  // Record when this phase last ran, keyed by its command verb and INDEPENDENT
  // of artifact content: deterministic tentacles often rewrite byte-identical
  // outputs, and a re-run must still clear a stale-drift finding.
  const stamp = ctx.clock.nowIso();
  const phaseRuns = { ...current.phase_runs, [patch.lastCommand]: stamp };

  const status: OswaldState["status"] = {
    ...current.status,
    phase: patch.phase,
    last_command: patch.lastCommand,
    next_recommended_command: recommendNextCommand(patch.phase),
    blockers: patch.blockers ?? current.status.blockers,
  };
  // Record where the workflow was when it entered `blocked` — and at what
  // fidelity the blocking run executed — so `oswald resume` can recover it
  // (and refuse to clear a REAL external block with a local-only re-run).
  // Re-blocking while already blocked preserves the original origin and never
  // DOWNGRADES an `external` mode to `local` (an external failure can only be
  // cleared by an external re-run); leaving `blocked` clears both markers.
  if (patch.phase === "blocked") {
    const freshlyBlocked = current.status.phase !== "blocked";
    if (freshlyBlocked) {
      status.blocked_from = current.status.phase;
    }
    if (
      patch.blockedMode &&
      (freshlyBlocked || current.status.blocked_mode !== "external")
    ) {
      status.blocked_mode = patch.blockedMode;
    }
  } else {
    delete status.blocked_from;
    delete status.blocked_mode;
  }

  const next: OswaldState = {
    ...current,
    status,
    requirements: {
      ...current.requirements,
      ...(patch.requirements ?? {}),
    },
    artifacts: {
      ...current.artifacts,
      ...(patch.artifacts ?? {}),
    },
    artifact_hashes: artifactHashes,
    phase_runs: phaseRuns,
  };
  next.timestamps.updated_at = stamp;

  await writeState(next, artifactDir);
  ctx.state = next;
  return next;
}
