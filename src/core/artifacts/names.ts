/**
 * Canonical artifact filenames produced across the Oswald pipeline.
 *
 * Each phase emits a structured artifact under the configured artifact dir
 * (default `.oswald`). Keeping the set centralized lets the CLI and tooling
 * reference them by stable key rather than scattering string literals.
 */
export const ARTIFACT_FILES = {
  state: "state.yml",
  intake: "intake.md",
  clarifications: "clarifications.md",
  context: "context.md",
  eda: "eda.md",
  design: "design.md",
  plan: "plan.md",
  build: "build.md",
  validation: "validation.md",
  pr: "pr.md",
  ticketUpdate: "ticket-update.md",
  ship: "ship.md",
  audit: "audit.log",
} as const;

export type ArtifactKey = keyof typeof ARTIFACT_FILES;

/** All canonical artifact filenames as a flat list. */
export const ARTIFACT_FILENAMES: readonly string[] =
  Object.values(ARTIFACT_FILES);
