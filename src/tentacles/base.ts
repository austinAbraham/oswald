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
  type OswaldState,
} from "../core/state/index.js";
import {
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
    }),
    sensitive: new SensitiveFieldDetector({
      enabled: config.policies.privacy.mask_sensitive_values,
    }),
    sanitizer: new ExternalContentSanitizer(),
    redact: redactArtifactContent,
  };

  return {
    config,
    artifacts,
    providers: options.providers ?? {},
    policy,
    approvals: new ApprovalService(),
    state,
    clock,
    logger,
    ticketId: options.ticketId ?? state.ticket.id ?? undefined,
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
}

export async function advanceWorkflow(
  ctx: TentacleContext,
  patch: AdvanceWorkflowPatch,
): Promise<OswaldState> {
  const artifactDir = ctx.config.paths.artifact_dir || DEFAULT_ARTIFACT_DIR;
  const current = await readState(ctx.artifacts.root, artifactDir);

  const next: OswaldState = {
    ...current,
    status: {
      ...current.status,
      phase: patch.phase,
      last_command: patch.lastCommand,
      next_recommended_command: recommendNextCommand(patch.phase),
      blockers: patch.blockers ?? current.status.blockers,
    },
    requirements: {
      ...current.requirements,
      ...(patch.requirements ?? {}),
    },
    artifacts: {
      ...current.artifacts,
      ...(patch.artifacts ?? {}),
    },
  };
  next.timestamps.updated_at = ctx.clock.nowIso();

  await writeState(next, artifactDir);
  ctx.state = next;
  return next;
}
