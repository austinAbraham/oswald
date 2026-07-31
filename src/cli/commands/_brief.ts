/**
 * Pure, deterministic helpers for the `brief` command.
 *
 * No I/O, no LLM, no clock — every function here is a referentially-transparent
 * string/array transform (mirroring `src/tentacles/delivery/parse.ts`) so it can
 * be unit-tested in isolation. The command's action orchestrates these against
 * the artifacts it reads.
 */
import { EVIDENCE_TAGS, type EvidenceTag } from "../../tentacles/base.js";
import type { WorkflowState } from "../../core/workflow/index.js";

// ---------------------------------------------------------------------------
// Fenced-code-block awareness.
//
// Artifacts embed raw wrapped ticket text inside ``` fences (e.g. intake.md's
// "Untrusted Source (wrapped)" section), and later artifacts re-embed fenced
// copies of earlier ones (pr_summary.md's "Validation Evidence" quotes
// validation_report.md). Fenced content is therefore either untrusted or a
// duplicate — it must never feed tallies or section extraction.
// ---------------------------------------------------------------------------

/** Opening/closing code-fence marker: three or more backticks or tildes. */
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

/**
 * Split a markdown body into its lines OUTSIDE fenced code blocks. The fence
 * marker lines themselves are excluded too. Tracks the fence character so a
 * block opened with backticks is only closed by backticks (and vice versa).
 * Pure.
 */
export function linesOutsideFences(body: string): string[] {
  const out: string[] = [];
  let fenceChar: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    const m = FENCE_RE.exec(line);
    if (m) {
      const char = m[1]![0]!;
      if (fenceChar === null) fenceChar = char;
      else if (fenceChar === char) fenceChar = null;
      continue;
    }
    if (fenceChar === null) out.push(line);
  }
  return out;
}

/**
 * A markdown body with every fenced code block (and the fence markers) removed.
 * Null passes through so callers can keep their missing-artifact degradation.
 */
export function stripFencedBlocks(body: string | null): string | null {
  if (body === null) return null;
  return linesOutsideFences(body).join("\n");
}

// ---------------------------------------------------------------------------
// Evidence-ledger tallies.
// ---------------------------------------------------------------------------

/** Count of evidence-ledger rows per tag across the artifacts scanned. */
export type EvidenceTally = Record<EvidenceTag, number>;

/** A tally with every tag at zero. */
export function emptyTally(): EvidenceTally {
  return { confirmed: 0, inferred: 0, assumption: 0, open_question: 0 };
}

const TAG_CELL_RE = new RegExp(`\\|\\s*\`(${EVIDENCE_TAGS.join("|")})\`\\s*\\|`);

/**
 * Tally evidence tags from a markdown body by scanning evidence-ledger table
 * rows (as rendered by `renderEvidenceTable`: a backticked tag in its own
 * cell). Prose mentions of the tag words are deliberately NOT counted — only
 * ledger rows are evidence — and lines inside fenced code blocks are skipped
 * entirely, so pasted tables in the wrapped ticket text cannot forge or
 * inflate the tallies (and fenced re-quotes of earlier artifacts are not
 * double-counted). Null/empty bodies tally to zero.
 */
export function tallyEvidenceTags(body: string | null): EvidenceTally {
  const tally = emptyTally();
  if (!body) return tally;
  for (const line of linesOutsideFences(body)) {
    if (!/^\s*\|/.test(line)) continue;
    const m = TAG_CELL_RE.exec(line);
    if (m) tally[m[1] as EvidenceTag] += 1;
  }
  return tally;
}

/** Sum two tallies (pure; neither input is mutated). */
export function addTallies(a: EvidenceTally, b: EvidenceTally): EvidenceTally {
  const out = emptyTally();
  for (const tag of EVIDENCE_TAGS) out[tag] = a[tag] + b[tag];
  return out;
}

/** Total rows across all tags. */
export function totalTally(t: EvidenceTally): number {
  return EVIDENCE_TAGS.reduce((sum, tag) => sum + t[tag], 0);
}

/**
 * Render a tally as one plain-business-language sentence. No jargon: tags are
 * translated into what they mean for a stakeholder.
 */
export function describeEvidence(t: EvidenceTally): string {
  if (totalTally(t) === 0) {
    return "Nothing has been established yet — no evidence has been recorded.";
  }
  const part = (n: number, singular: string, plural: string): string =>
    `${n} ${n === 1 ? singular : plural}`;
  return [
    `${part(t.confirmed, "fact is", "facts are")} confirmed from source material`,
    `${part(t.inferred, "finding was", "findings were")} derived from that evidence`,
    `${part(t.assumption, "working assumption needs", "working assumptions need")} sign-off`,
    `${part(t.open_question, "question is", "questions are")} awaiting an answer`,
  ].join(", ") + ".";
}

// ---------------------------------------------------------------------------
// Stakeholders.
// ---------------------------------------------------------------------------

/** Routing markers rendered by the clarification tentacle: `_(→ owner)_`. */
const ROUTE_RE = /_\(→\s*([^)]+?)\s*\)_/g;

/**
 * Extract the people/teams needed to unblock the work from the intake brief's
 * "Stakeholders" bullets plus the clarification routing markers in
 * `open_questions.md`. Deduplicated case-insensitively (first spelling wins,
 * input order preserved); the "unassigned" routing placeholder is dropped
 * because it names nobody.
 */
export function extractStakeholders(
  intakeStakeholders: string[],
  openQuestionsBody: string | null,
): string[] {
  const candidates = [...intakeStakeholders];
  if (openQuestionsBody) {
    for (const m of openQuestionsBody.matchAll(ROUTE_RE)) {
      candidates.push(m[1]!);
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of candidates) {
    const s = raw.trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (key === "unassigned" || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Phase → business language.
// ---------------------------------------------------------------------------

/**
 * What each workflow phase means in business terms — one plain sentence per
 * phase, no pipeline jargon. Exhaustive over {@link WorkflowState} so a new
 * phase fails typecheck until it gets a description.
 */
const PHASE_DESCRIPTIONS: Record<WorkflowState, string> = {
  uninitialized:
    "Not started — the work has not been set up yet.",
  intake:
    "Capturing the request — turning the ticket into structured requirements.",
  clarification:
    "Confirming scope — open questions are being routed to the right people.",
  context:
    "Reviewing what already exists so no work is duplicated.",
  eda:
    "Profiling the source data (read-only) to confirm it can support the request.",
  design:
    "Translating business language into precise metric definitions.",
  planning:
    "Laying out the implementation plan and the changes it will require.",
  building:
    "Building the data models from the agreed plan.",
  validating:
    "Checking the finished work against the agreed acceptance criteria.",
  ready_for_pr:
    "Work is packaged and awaiting human review.",
  ready_for_ticket_update:
    "Review passed — results are being reported back on the ticket.",
  shipped:
    "Done — the work has been delivered.",
  blocked:
    "Paused — progress is stopped until the blockers below are resolved.",
};

/** Plain-language description of a workflow phase for a business reader. */
export function describePhase(phase: WorkflowState): string {
  return PHASE_DESCRIPTIONS[phase];
}
