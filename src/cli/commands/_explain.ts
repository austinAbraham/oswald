/**
 * `oswald next --explain` — deterministic teach-mode output.
 *
 * Explains WHY the recommended command is next: where the workflow phase sits
 * on the linear pipeline, which input artifacts the step reads (present vs
 * missing on disk), which artifacts it writes, which blockers / unresolved open
 * questions gate it, which provider capabilities it needs vs what is recorded
 * in `state.tools`, and which consent flags its approval-gated side effects
 * would need.
 *
 * Everything is sourced from EXISTING readers only — the state file, the
 * artifact dir (via `ArtifactManager.exists`), the resolved config policies,
 * the workflow state machine, and the tentacle registry. It never writes, never
 * probes a provider, and never calls a model, so identical inputs always
 * produce identical output.
 *
 * ACCURACY RULE: the `reads` lines mirror what each step's code ACTUALLY does.
 * Tentacles resolve prior artifacts by LITERAL filename (never via
 * `state.artifacts`), so the filenames below are imported from the consumers'
 * own exported input constants — including delivery's
 * `validation_report.md → validation.md` fallback chain — and names that no
 * pipeline step currently writes are called out as exactly that.
 */
import type { ArtifactManager } from "../../core/artifacts/index.js";
import { ARTIFACT_FILES } from "../../core/artifacts/index.js";
import type { OswaldConfig } from "../../core/config/index.js";
import type { OswaldState } from "../../core/state/index.js";
import {
  WORKFLOW_STATES,
  nextState,
  recommendNextCommand,
} from "../../core/workflow/index.js";
import {
  isActionGated,
  isActionProhibited,
  policyFromConfig,
  type ApprovalAction,
  type ApprovalPolicy,
} from "../../core/approvals/index.js";
import { getTentacle } from "../../tentacles/registry.js";
import { ARTIFACT_NAMES as INTAKE_FILES } from "../../tentacles/intake/index.js";
import {
  ARTIFACT_NAMES as CLARIFY_FILES,
  INTAKE_ARTIFACTS as CLARIFY_INPUTS,
} from "../../tentacles/clarification/index.js";
import {
  ARTIFACT_NAMES as CONTEXT_FILES,
  INPUT_ARTIFACTS as CONTEXT_INPUTS,
} from "../../tentacles/context/index.js";
import { ARTIFACT_NAMES as EDA_FILES } from "../../tentacles/eda/index.js";
import {
  ARTIFACT_NAMES as DESIGN_FILES,
  INPUT_ARTIFACTS as DESIGN_INPUTS,
} from "../../tentacles/design/index.js";
import {
  ARTIFACT_NAMES as PLANNING_FILES,
  INPUT_ARTIFACTS as PLANNING_INPUTS,
} from "../../tentacles/planning/index.js";
import {
  ARTIFACT_NAMES as VALIDATION_FILES,
  ACCEPTANCE_ARTIFACT,
} from "../../tentacles/validation/index.js";
import {
  ARTIFACT_NAMES as DELIVERY_FILES,
  INPUT_ARTIFACTS as DELIVERY_INPUTS,
} from "../../tentacles/delivery/index.js";
import { BUILD_INPUT_ARTIFACTS } from "./build.js";

// ---------------------------------------------------------------------------
// Per-step teaching metadata.
// ---------------------------------------------------------------------------

/**
 * One group of inputs a step reads — LITERAL filenames, in the consumer's own
 * read order, imported from its exported input constants.
 */
interface StepInput {
  /** Human label for the input group (e.g. "implementation plan"). */
  label: string;
  /** CLI command whose step writes these files today, or null when none does. */
  producedBy: string | null;
  /** The literal filenames the step's code looks for, in its read order. */
  names: readonly string[];
  /** "each": every existing file is read; "first": the first existing wins. */
  mode: "each" | "first";
  /** The step refuses to run without this input (default: degrades gracefully). */
  required?: boolean;
}

/** An approval-gated side effect a step could perform (never by default). */
interface StepSideEffect {
  /** The approval action class (`src/core/approvals`). */
  action: ApprovalAction;
  /** The flags on the command that request + consent to the side effect. */
  flags: string;
  /** What would happen. */
  what: string;
}

/** Teaching metadata for one CLI step. */
interface StepSpec {
  /** Registry tentacle backing the step (absent for hand-written commands). */
  tentacleId?: string;
  /** One-line purpose (fallback when no tentacle description is available). */
  purpose: string;
  /** Prior-step inputs the step reads (empty → `readsNote` is shown). */
  reads: StepInput[];
  /** Shown when `reads` is empty (where the step's input really comes from). */
  readsNote?: string;
  /** Artifact filenames the step writes under the artifact dir. */
  writes: string[];
  /** Approval-gated side effects the step could perform with consent. */
  sideEffects: StepSideEffect[];
  /** Extra deterministic teaching notes. */
  notes?: string[];
}

/** Commands that take a `<ticket>` positional argument. */
const TICKET_COMMANDS = new Set([
  "clarify",
  "context",
  "eda",
  "design",
  "plan",
  "build",
  "validate",
  "pr",
  "update-ticket",
  "ship",
]);

// --- Input groups, derived from the consumers' exported constants. ----------

/** Filenames the intake step writes (the only upstream most steps consume). */
const INTAKE_WRITE_SET = new Set<string>(Object.values(INTAKE_FILES));

/** The subset of `names` that intake produces, preserving read order. */
function producedByIntake(names: readonly string[]): readonly string[] {
  return names.filter((n) => INTAKE_WRITE_SET.has(n));
}

/** The subset of `names` that NO pipeline step produces, preserving order. */
function producedByNobody(names: readonly string[]): readonly string[] {
  return names.filter((n) => !INTAKE_WRITE_SET.has(n));
}

/** Delivery backs both `pr` and `update-ticket`; both read the same inputs. */
const DELIVERY_READS: StepInput[] = [
  {
    label: "validation evidence",
    producedBy: "validate",
    names: DELIVERY_INPUTS.validation,
    mode: "first",
  },
  {
    label: "implementation plan",
    producedBy: "plan",
    names: DELIVERY_INPUTS.plan,
    mode: "first",
  },
  {
    label: "requirements",
    producedBy: "intake",
    names: DELIVERY_INPUTS.requirements,
    mode: "each",
  },
];

/**
 * The step map, keyed by the CLI command `recommendNextCommand` returns.
 *
 * `reads` filenames come from the consumers' exported input constants (the
 * literal names their code looks for); `writes` come from the producers'
 * exported `ARTIFACT_NAMES`. `tests/unit/explain.test.ts` asserts the wiring
 * stays in sync with those constants.
 */
const STEP_SPECS: Record<string, StepSpec> = {
  init: {
    purpose:
      "initialize Oswald in this project — config check, initial state, runtime templates",
    reads: [],
    readsNote: "nothing — this is the first step in an empty project",
    writes: [ARTIFACT_FILES.state],
    sideEffects: [],
  },
  intake: {
    tentacleId: "intake",
    reads: [],
    readsNote:
      "no prior artifacts — the ticket itself (via --from-file or a ticket provider) is the input",
    purpose: "ingest the ticket and draft structured requirements",
    writes: Object.values(INTAKE_FILES),
    sideEffects: [],
  },
  clarify: {
    tentacleId: "clarification",
    purpose: "triage open questions and draft a clarification comment",
    reads: [
      {
        label: "intake outputs",
        producedBy: "intake",
        names: Object.values(CLARIFY_INPUTS),
        mode: "each",
      },
    ],
    writes: Object.values(CLARIFY_FILES),
    sideEffects: [
      {
        action: "ticket_update",
        flags: "--post-comment plus -y/--yes",
        what: "post the clarification comment to the ticket",
      },
      {
        action: "create_ticket",
        flags: "-y/--yes",
        what: "create a follow-up ticket for unresolved questions",
      },
    ],
  },
  context: {
    tentacleId: "context",
    purpose: "gather existing warehouse/repo/doc context",
    reads: [
      {
        label: "intake outputs",
        producedBy: "intake",
        names: CONTEXT_INPUTS,
        mode: "each",
      },
    ],
    writes: Object.values(CONTEXT_FILES),
    sideEffects: [],
    notes: [
      "the real subject is the project tree itself — the repo scan needs no prior artifacts; the intake text only seeds the similarity query",
    ],
  },
  eda: {
    tentacleId: "eda",
    purpose: "generate (and optionally run) read-only EDA SQL",
    reads: [],
    readsNote:
      "nothing from the artifact dir — EDA profiles the warehouse through the provider; it does not consume prior artifacts",
    writes: [
      EDA_FILES.report,
      EDA_FILES.grain,
      EDA_FILES.join,
      EDA_FILES.quality,
      `${EDA_FILES.sqlDir}/*.sql`,
    ],
    sideEffects: [],
    notes: [
      "'--execute' stays READ-ONLY: every query passes the SQL safety validator and is LIMIT-capped",
    ],
  },
  design: {
    tentacleId: "design",
    purpose: "convert business language into precise metric/semantic definitions",
    reads: [
      {
        label: "intake outputs",
        producedBy: "intake",
        names: producedByIntake(DESIGN_INPUTS),
        mode: "each",
      },
      {
        label: "extra design sources (legacy names)",
        producedBy: null,
        names: producedByNobody(DESIGN_INPUTS),
        mode: "each",
      },
    ],
    writes: Object.values(DESIGN_FILES),
    sideEffects: [],
    notes: [
      "'oswald eda' writes eda_report.md, which design does NOT read — EDA findings reach the design only via a hand-written eda.md today",
    ],
  },
  plan: {
    tentacleId: "planning",
    purpose: "plan layered dbt models + tests and an intended-changes manifest",
    reads: [
      {
        label: "design/eda summaries (legacy names)",
        producedBy: null,
        names: producedByNobody(Object.values(PLANNING_INPUTS)),
        mode: "each",
      },
      {
        label: "intake outputs",
        producedBy: "intake",
        names: producedByIntake(Object.values(PLANNING_INPUTS)),
        mode: "each",
      },
    ],
    writes: Object.values(PLANNING_FILES),
    sideEffects: [],
    notes: [
      "'oswald design' writes metric_spec.yml/semantic_model_plan.md, which plan does NOT read — without a hand-written design.md the plan derives from the intake artifacts (and warns)",
    ],
  },
  build: {
    purpose:
      "turn the implementation plan into a change preview (default) or conservative dbt scaffolding (--apply)",
    reads: [
      {
        label: "implementation plan",
        producedBy: "plan",
        names: [BUILD_INPUT_ARTIFACTS.implementationPlan],
        mode: "each",
        required: true,
      },
      {
        label: "planning detail",
        producedBy: "plan",
        names: [BUILD_INPUT_ARTIFACTS.modelPlan, BUILD_INPUT_ARTIFACTS.changedFiles],
        mode: "each",
      },
    ],
    writes: ["build_preview.md", "changed_files.json"],
    sideEffects: [
      {
        action: "commit",
        flags: "--apply plus -y/--yes",
        what: "write dbt model/schema scaffolding under the configured model dir",
      },
    ],
    notes: [
      "the default is a dry-run preview; without --apply AND consent no project file is touched",
    ],
  },
  validate: {
    tentacleId: "validate",
    purpose: "verify generated work against the acceptance criteria",
    reads: [
      {
        label: "acceptance criteria",
        producedBy: "intake",
        names: [ACCEPTANCE_ARTIFACT],
        mode: "each",
      },
    ],
    writes: Object.values(VALIDATION_FILES),
    sideEffects: [],
    notes: [
      "build outputs (build_preview.md/changed_files.json) are NOT read — validation re-derives evidence from the acceptance criteria (and dbt, when a project is configured)",
      "a failed gate parks the workflow in 'blocked' (exit 2) until it is resolved and re-run",
    ],
  },
  pr: {
    tentacleId: "delivery",
    purpose: "package the change into a PR summary (draft by default)",
    reads: DELIVERY_READS,
    writes: Object.values(DELIVERY_FILES),
    sideEffects: [
      {
        action: "create_branch",
        flags: "--open plus -y/--yes",
        what: "create the feature branch",
      },
      {
        action: "open_pull_request",
        flags: "--open plus -y/--yes",
        what: "open the pull request",
      },
    ],
    notes: ["'--draft' always forces draft-only, even when consent flags are set"],
  },
  "update-ticket": {
    tentacleId: "delivery",
    purpose: "write results back to the ticket (draft by default)",
    // The same delivery tentacle backs both verbs: it re-reads the validation/
    // plan/requirements evidence (never pr_summary.md) and re-renders all of
    // its artifacts.
    reads: DELIVERY_READS,
    writes: Object.values(DELIVERY_FILES),
    sideEffects: [
      {
        action: "ticket_update",
        flags: "--post plus -y/--yes",
        what: "post the update to the ticket",
      },
    ],
    notes: ["'--draft' always forces draft-only, even when consent flags are set"],
  },
};

/**
 * The literal input filenames the explain output reports for a command, in
 * read order (test hook: `tests/unit/explain.test.ts` asserts these match the
 * consumers' exported input constants so future drift fails CI).
 */
export function explainedReads(command: string): readonly string[] {
  const spec = STEP_SPECS[command];
  if (!spec) return [];
  return spec.reads.flatMap((input) => [...input.names]);
}

// ---------------------------------------------------------------------------
// Explain composer.
// ---------------------------------------------------------------------------

export interface ExplainNextStepOptions {
  state: OswaldState;
  config: OswaldConfig;
  artifacts: ArtifactManager;
}

/**
 * Compose the deterministic `--explain` lines for the current workflow state.
 *
 * Read-only: consults state / config / registry / artifact existence only.
 * Returns plain-text lines for the CLI to print (no logger prefixes).
 */
export async function explainNextStep(
  options: ExplainNextStepOptions,
): Promise<string[]> {
  const { state, config, artifacts } = options;
  const phase = state.status.phase;

  if (phase === "blocked") {
    return explainBlocked(state);
  }

  const command = recommendNextCommand(phase);
  if (!command) {
    // Only `shipped` remains terminal once `blocked` is handled above.
    return [
      "explain: phase 'shipped' is terminal — this ticket's pipeline is complete",
      "  nothing to run; the artifact dir remains the durable record of what shipped",
      "  start the next ticket with 'oswald intake <ticket>' (or 'oswald compact' to tidy artifacts first)",
    ];
  }

  const spec = STEP_SPECS[command];
  const lines: string[] = [`explain: why 'oswald ${command}' is next`];

  // --- Phase position on the linear pipeline. ------------------------------
  const linear = WORKFLOW_STATES.filter((s) => s !== "blocked");
  const position = linear.indexOf(phase) + 1;
  lines.push(
    `  phase: '${phase}' — step ${position} of ${linear.length} on the linear pipeline (uninitialized → shipped)`,
  );

  const tentacle = spec?.tentacleId ? getTentacle(spec.tentacleId) : undefined;
  const purpose = tentacle?.description ?? spec?.purpose;
  if (purpose) {
    lines.push(`  does:  ${purpose}`);
  }
  const successor = nextState(phase);
  if (successor) {
    lines.push(`  then:  on success the workflow advances toward phase '${successor}'`);
  }

  if (!spec) {
    // Defensive: an unmapped command still gets the phase/blocker context.
    lines.push(...gateLines(state, command));
    return lines;
  }

  // --- Inputs (present vs missing on disk). --------------------------------
  lines.push("  reads:");
  if (spec.reads.length === 0) {
    lines.push(`    - ${spec.readsNote ?? "no prior artifacts"}`);
  }
  for (const input of spec.reads) {
    lines.push(await describeInput(input, artifacts));
  }

  // --- Outputs. -------------------------------------------------------------
  const artifactDir = config.paths.artifact_dir || ".oswald";
  lines.push(`  writes (under '${artifactDir}/'): ${spec.writes.join(", ")}`);

  // --- Gates: blockers + unresolved open questions. -------------------------
  lines.push(...gateLines(state, command));

  // --- Provider capabilities vs what is wired. ------------------------------
  lines.push(...toolLines(spec, tentacle?.requiredTools, tentacle?.optionalTools, state));

  // --- Consent flags for approval-gated side effects. -----------------------
  lines.push(...consentLines(spec, policyFromConfig(config.policies)));

  for (const note of spec.notes ?? []) {
    lines.push(`  note:  ${note}`);
  }

  return lines;
}

/** Render one input group: literal names with on-disk presence + hints. */
async function describeInput(
  input: StepInput,
  artifacts: ArtifactManager,
): Promise<string> {
  const parts: string[] = [];
  let anyPresent = false;
  let anyMissing = false;
  for (const name of input.names) {
    const present = await artifacts.exists(name);
    if (present) anyPresent = true;
    else anyMissing = true;
    parts.push(`${name} (${present ? "present" : "missing"})`);
  }

  const hints: string[] = [];
  if (input.mode === "first" && input.names.length > 1) {
    hints.push("the first existing file is used");
  }
  // A fallback chain is only "missing" when NO name in it exists.
  const effectivelyMissing = input.mode === "first" ? !anyPresent : anyMissing;
  if (effectivelyMissing) {
    if (input.producedBy === null) {
      hints.push(
        "no pipeline step currently writes these names (missing is normal); the step reads them only when supplied by hand",
      );
    } else if (input.required && !anyPresent) {
      hints.push(
        `REQUIRED — the step stops without it; 'oswald ${input.producedBy}' produces it`,
      );
    } else {
      hints.push(
        `missing inputs degrade gracefully; 'oswald ${input.producedBy}' produces them`,
      );
    }
  }

  const from = input.producedBy ? ` [from 'oswald ${input.producedBy}']` : "";
  const suffix = hints.length ? ` — ${hints.join("; ")}` : "";
  return `    - ${input.label}${from}: ${parts.join(", ")}${suffix}`;
}

/** Render the blockers / unresolved-open-questions gate section. */
function gateLines(state: OswaldState, command: string): string[] {
  const lines: string[] = ["  gates:"];

  const blockers = state.status.blockers;
  if (blockers.length === 0) {
    lines.push("    - blockers: none");
  } else {
    lines.push(`    - blockers (${blockers.length}):`);
    for (const b of blockers) lines.push(`        - ${b}`);
  }

  const questions = state.requirements.unresolved_questions;
  if (questions.length === 0) {
    lines.push("    - unresolved open questions: none");
  } else {
    lines.push(
      `    - unresolved open questions (${questions.length}) — they do not stop 'oswald ${command}', but need answers before shipping:`,
    );
    for (const q of questions) lines.push(`        - ${q}`);
  }

  return lines;
}

/** Render required/optional provider capabilities vs `state.tools`. */
function toolLines(
  spec: StepSpec,
  requiredTools: string[] | undefined,
  optionalTools: string[] | undefined,
  state: OswaldState,
): string[] {
  const lines: string[] = ["  tools:"];

  if (!spec.tentacleId) {
    lines.push(
      "    - none declared — this is a hand-written command, not a tentacle; it needs no provider",
    );
    return lines;
  }

  const required = requiredTools ?? [];
  const optional = optionalTools ?? [];

  if (required.length === 0) {
    lines.push("    - required: none — the step runs even with zero providers wired");
  } else {
    lines.push(`    - required (${required.length}):`);
    for (const cap of required) lines.push(`        - ${describeCapability(cap, state)}`);
  }

  if (optional.length > 0) {
    lines.push(
      `    - optional (${optional.length}, improve fidelity; the step degrades gracefully without them):`,
    );
    for (const cap of optional) lines.push(`        - ${describeCapability(cap, state)}`);
  }

  return lines;
}

/** Render one capability with its wiring status from `state.tools`. */
function describeCapability(capability: string, state: OswaldState): string {
  const provider = capability.split(".")[0] ?? capability;
  const status =
    state.tools[capability]?.status ?? state.tools[provider]?.status;
  const wiring =
    status !== undefined
      ? `${provider}: ${status} per state.tools`
      : `${provider}: not recorded in state.tools — 'oswald doctor' probes providers`;
  return `${capability} (${wiring})`;
}

/** Render the consent section from the step's approval action classes. */
function consentLines(spec: StepSpec, policy: ApprovalPolicy): string[] {
  if (spec.sideEffects.length === 0) {
    return [
      "  consent: none needed — this step never writes outside the artifact dir",
    ];
  }

  const lines: string[] = [
    "  consent (side effects are default-deny; the policy must also permit):",
  ];
  for (const effect of spec.sideEffects) {
    const policyNote = isActionProhibited(effect.action, policy)
      ? "PROHIBITED by policies.prohibit — this side effect can never run"
      : isActionGated(effect.action, policy)
        ? "gated by policies.require_approval_for"
        : "not explicitly gated (still default-deny without consent)";
    lines.push(
      `    - ${effect.what} → action '${effect.action}': pass ${effect.flags}; policy: ${policyNote}`,
    );
  }
  return lines;
}

/** The blocked dead-end: list the blockers and say exactly what to re-run. */
function explainBlocked(state: OswaldState): string[] {
  const last = state.status.last_command;
  const lines: string[] = [
    "explain: the workflow is BLOCKED — a gate failed and needs a human",
    `  phase: 'blocked'${last ? ` (parked by 'oswald ${last}')` : ""}`,
  ];

  const blockers = state.status.blockers;
  if (blockers.length === 0) {
    lines.push("  blockers: none recorded in state — check the latest validation artifacts");
  } else {
    lines.push(`  blockers (${blockers.length}):`);
    for (const b of blockers) lines.push(`    - ${b}`);
  }

  const questions = state.requirements.unresolved_questions;
  if (questions.length > 0) {
    lines.push(`  unresolved open questions (${questions.length}):`);
    for (const q of questions) lines.push(`    - ${q}`);
  }

  // Re-run the command that parked us when it is a real CLI verb (tentacles
  // that back two verbs record their id, e.g. 'delivery'); otherwise fall back
  // to 'validate' — the same guidance the standard output block gives.
  const rerun = last && last !== "init" && STEP_SPECS[last] ? last : "validate";
  const ticket = state.ticket.id;
  const ticketArg = TICKET_COMMANDS.has(rerun) && ticket ? ` ${ticket}` : "";
  lines.push(
    `  to resume: resolve the blocker(s) above, then re-run: oswald ${rerun}${ticketArg}`,
  );
  lines.push(
    "    (a successful re-run clears 'blocked' and moves the workflow forward)",
  );
  return lines;
}
