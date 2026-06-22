/**
 * Re-read prior intake artifacts into the structured evidence the clarification
 * heuristics need.
 *
 * The clarification tentacle is a CONSUMER of intake's outputs. It reads the
 * committed artifacts (`intake.md`, `requirements.md`, `acceptance_criteria.md`)
 * from `.oswald/` and re-derives the structured fields deterministically using
 * intake's own pure extractors (imported read-only — never mutated).
 *
 * The artifacts were already trust-wrapped + redacted at intake time, so the
 * content here is safe-as-evidence. We still treat it strictly as data.
 */
import {
  splitSections,
  extractRequirements,
  extractAcceptanceCriteria,
  detectSourceSystems,
  detectTargets,
  detectStakeholders,
  detectDependencies,
} from "../intake/parse.js";
import { detectAmbiguousTerms } from "./analyze.js";

/** The structured evidence the clarification heuristics operate on. */
export interface IntakeEvidence {
  title: string;
  summary: string;
  requirements: string[];
  acceptanceCriteria: string[];
  sourceSystems: string[];
  targets: string[];
  stakeholders: string[];
  dependencies: string[];
  ambiguousTerms: string[];
  /** Open questions previously surfaced (parsed from requirements.md). */
  priorOpenQuestions: string[];
  /** True if the intake brief noted neutralized injection patterns. */
  injectionDetected: boolean;
}

/** Pull the title from an intake brief heading (`# Intake Brief: <title>`). */
function extractTitle(intakeMd: string | null): string {
  if (!intakeMd) return "Untitled ticket";
  const m = intakeMd.match(/^#\s+Intake Brief:\s*(.+)$/m);
  return m ? m[1]!.trim() : "Untitled ticket";
}

/** Parse the "Missing / Ambiguous" open-question bullets out of requirements.md. */
function extractPriorOpenQuestions(requirementsMd: string | null): string[] {
  if (!requirementsMd) return [];
  const lines = requirementsMd.split(/\r?\n/);
  const out: string[] = [];
  let inSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^##\s+/.test(line)) {
      inSection = /missing|ambiguous|open question/i.test(line);
      continue;
    }
    if (inSection) {
      const m = line.match(/^[-*]\s+(.*)$/);
      if (m) {
        const text = m[1]!.trim();
        // Skip the "none — ..." placeholder italic note.
        if (text && !/^_.*_$/.test(text) && !/^none\b/i.test(text)) {
          out.push(text);
        }
      }
    }
  }
  return out;
}

/**
 * Build the structured evidence object from the (possibly missing) prior
 * intake artifacts. Degrades gracefully: any missing artifact contributes
 * empty fields rather than throwing.
 */
export function buildEvidenceFromArtifacts(args: {
  intakeMd: string | null;
  requirementsMd: string | null;
  acceptanceMd: string | null;
}): IntakeEvidence {
  const { intakeMd, requirementsMd, acceptanceMd } = args;

  const combinedText = [intakeMd, requirementsMd, acceptanceMd]
    .filter((s): s is string => Boolean(s))
    .join("\n\n");

  const reqSections = requirementsMd ? splitSections(requirementsMd).sections : [];
  const acSections = acceptanceMd ? splitSections(acceptanceMd).sections : [];

  const requirements = extractRequirements(reqSections);
  const acceptanceCriteria = parseNumberedOrBulleted(acSections, acceptanceMd);

  return {
    title: extractTitle(intakeMd),
    summary: extractSummary(intakeMd),
    requirements,
    acceptanceCriteria,
    sourceSystems: detectSourceSystems(combinedText),
    targets: detectTargets(combinedText),
    stakeholders: dedupeStakeholders(detectStakeholders(reqSections, combinedText)),
    dependencies: detectDependencies(reqSections, combinedText),
    ambiguousTerms: detectAmbiguousTerms(combinedText),
    priorOpenQuestions: extractPriorOpenQuestions(requirementsMd),
    injectionDetected: /injection|NEUTRALIZED:/i.test(intakeMd ?? ""),
  };
}

/** Acceptance criteria render as `1. ...` numbered list; also accept bullets. */
function parseNumberedOrBulleted(
  sections: ReturnType<typeof splitSections>["sections"],
  acceptanceMd: string | null,
): string[] {
  // Prefer the intake extractor (handles bullets), then fall back to numbered.
  // Drop italic placeholder / "none" lines that intake renders when empty.
  const viaExtractor = extractAcceptanceCriteria(sections).filter(
    (c) => !/^_.*_$/.test(c.trim()) && !/^none\b/i.test(c.trim()),
  );
  if (viaExtractor.length > 0) return viaExtractor;
  if (!acceptanceMd) return [];
  const out: string[] = [];
  let inSection = false;
  for (const raw of acceptanceMd.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^##\s+/.test(line)) {
      inSection = /acceptance/i.test(line);
      continue;
    }
    if (inSection) {
      const m = line.match(/^\d+[.)]\s+(.*)$/);
      if (m && m[1] && !/^_.*_$/.test(m[1].trim())) out.push(m[1].trim());
    }
  }
  return out;
}

/** Pull the summary paragraph that intake renders under the brief title. */
function extractSummary(intakeMd: string | null): string {
  if (!intakeMd) return "";
  const lines = intakeMd.split(/\r?\n/);
  // The summary is the first non-empty paragraph after the `# Intake Brief:` line
  // and before the first `##` section.
  let started = false;
  const buf: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (/^#\s+Intake Brief:/i.test(line)) {
      started = true;
      continue;
    }
    if (!started) continue;
    if (/^##\s+/.test(line)) break;
    if (line) buf.push(line);
  }
  return buf.join(" ");
}

/** Drop redaction placeholders that would otherwise become a "stakeholder". */
function dedupeStakeholders(stakeholders: string[]): string[] {
  return [
    ...new Set(
      stakeholders
        .map((s) => s.trim())
        .filter((s) => s && !/redacted/i.test(s)),
    ),
  ];
}
