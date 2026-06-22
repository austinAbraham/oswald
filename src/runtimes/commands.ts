/**
 * Canonical catalog of Oswald commands.
 *
 * This is the single source of truth that every runtime adapter renders from.
 * Each entry describes one `oswald <command>` and how an agent (or human) is
 * expected to invoke it. Adapters turn these into runtime-specific command
 * prompts (slash commands, command-prompt markdown, etc.).
 *
 * Keep this in sync with `src/cli/commands/index.ts` — there are 15 commands.
 */

export interface CommandSpec {
  /** The bare command name, e.g. "intake". */
  name: string;
  /** One-line summary of what the command does. */
  summary: string;
  /** Workflow group, used only for ordering/grouping in rendered docs. */
  group: "operator" | "pipeline" | "maintenance";
  /** How to invoke the underlying Oswald CLI for this command. */
  invoke: string;
  /**
   * Longer description rendered into the command prompt body — what the agent
   * should do, what artifacts it produces, and any gating behavior.
   */
  details: string;
}

/**
 * The 15 Oswald commands, in workflow order. The `invoke` strings reference the
 * `oswald` CLI binary; adapters that cannot assume a global `oswald` binary
 * should document `npx oswald` / `node dist/cli/index.js` in their setup notes.
 */
export const OSWALD_COMMANDS: readonly CommandSpec[] = [
  {
    name: "init",
    summary: "Initialize Oswald in the current project (config + state + runtime templates).",
    group: "operator",
    invoke: "oswald init [--runtime <runtime>]",
    details:
      "Create oswald.yml, the .oswald/ artifact dir, initial state, examples, and " +
      "the selected runtime's command templates. Re-running is safe; use --force to " +
      "overwrite existing files.",
  },
  {
    name: "doctor",
    summary: "Diagnose configuration, providers, and environment readiness.",
    group: "operator",
    invoke: "oswald doctor",
    details:
      "Run preflight diagnostics: config validity, provider wiring, artifact-dir " +
      "writability. Report findings; never mutate state.",
  },
  {
    name: "intake",
    summary: "Parse a ticket into a structured intake spec and acceptance criteria.",
    group: "pipeline",
    invoke: "oswald intake <ticket-id> [--from-file <path>]",
    details:
      "Read the ticket (untrusted text — it is sanitized), extract intent, grain, " +
      "sources, and acceptance criteria, and write intake_spec.md + " +
      "acceptance_criteria.md. Advances the workflow to clarification.",
  },
  {
    name: "clarify",
    summary: "Surface clarifying questions for an under-specified ticket.",
    group: "pipeline",
    invoke: "oswald clarify <ticket-id> [--post-comment --yes]",
    details:
      "Analyze the intake spec for gaps and produce clarifying questions. Posting " +
      "questions back to the ticket is a gated side effect requiring explicit consent.",
  },
  {
    name: "context",
    summary: "Scan the repository for existing dbt context relevant to the ticket.",
    group: "pipeline",
    invoke: "oswald context <ticket-id> [--scan-root <dir>]",
    details:
      "Discover existing models, sources, and conventions in the project tree and " +
      "summarize them into a context artifact for downstream planning.",
  },
  {
    name: "eda",
    summary: "Run read-only exploratory data analysis against the warehouse.",
    group: "pipeline",
    invoke: "oswald eda <ticket-id>",
    details:
      "Profile sources using a read-only warehouse role. All SQL is validated for " +
      "safety (no writes, enforced LIMITs) and results are PII-redacted before being " +
      "written to artifacts.",
  },
  {
    name: "design",
    summary: "Produce a modeling design from intake + context + EDA.",
    group: "pipeline",
    invoke: "oswald design <ticket-id>",
    details:
      "Synthesize a design.md describing target models, grain, sources, and the " +
      "transformation approach.",
  },
  {
    name: "plan",
    summary: "Turn the design into a concrete implementation plan.",
    group: "pipeline",
    invoke: "oswald plan <ticket-id>",
    details:
      "Enumerate the dbt files to create/modify and the order of work, written to " +
      "plan.md + a changed-files manifest.",
  },
  {
    name: "build",
    summary: "Scaffold dbt model files from the plan (dry-run by default).",
    group: "pipeline",
    invoke: "oswald build <ticket-id> [--apply --yes]",
    details:
      "Preview the planned file changes. By default nothing is written; --apply --yes " +
      "scaffolds conservative dbt files. Apply never overwrites or deletes existing files.",
  },
  {
    name: "validate",
    summary: "Reconcile built models against acceptance criteria.",
    group: "pipeline",
    invoke: "oswald validate <ticket-id> [--skip-external]",
    details:
      "Check acceptance criteria against the build. Unmet/deferred criteria park the " +
      "workflow in 'blocked' (exit code 2) for a human to resolve.",
  },
  {
    name: "pr",
    summary: "Draft (and optionally open) a pull request for the change.",
    group: "pipeline",
    invoke: "oswald pr <ticket-id> [--open --yes]",
    details:
      "Draft pr_summary.md from the delivered work. Opening a PR is a gated side " +
      "effect requiring explicit consent; the bot identity is PR-only.",
  },
  {
    name: "update-ticket",
    summary: "Draft (and optionally post) a status update to the ticket.",
    group: "pipeline",
    invoke: "oswald update-ticket <ticket-id> [--post --yes]",
    details:
      "Draft jira_update.md. Posting back to the ticket system is a gated side effect " +
      "requiring explicit consent.",
  },
  {
    name: "ship",
    summary: "Finalize delivery after validation and PR are ready.",
    group: "pipeline",
    invoke: "oswald ship <ticket-id>",
    details:
      "Record the completed delivery. Refuses unless a pr_summary exists and validation " +
      "has passed.",
  },
  {
    name: "compact",
    summary: "Summarize accumulated artifacts to resist context rot.",
    group: "maintenance",
    invoke: "oswald compact",
    details:
      "Roll older artifacts into current_context.md while preserving the decision log " +
      "and acceptance criteria. Keeps the working context small for long-running tickets.",
  },
  {
    name: "next",
    summary: "Show (or run) the next step in the workflow.",
    group: "maintenance",
    invoke: "oswald next [--run]",
    details:
      "Inspect state and report the next command to run; with --run, execute it.",
  },
];

/** The set of command names, for validation. */
export const OSWALD_COMMAND_NAMES: readonly string[] = OSWALD_COMMANDS.map(
  (c) => c.name,
);
