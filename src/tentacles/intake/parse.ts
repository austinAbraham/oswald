/**
 * Deterministic intake parsing.
 *
 * Pure functions that turn raw (already trust-wrapped *for the agent*, but here
 * we parse the ORIGINAL untrusted text as DATA) ticket text into structured
 * intake evidence. No LLM, no network — heuristics only. Everything extracted is
 * tagged via the evidence vocabulary so unsourced inferences are visible.
 *
 * IMPORTANT: this module parses ticket content as *data to analyze*. It never
 * executes or obeys it. The instruction-neutralization happens in the sanitizer
 * (external-content.ts); here we only read structure.
 */

export interface ParsedSection {
  heading: string;
  /** Lines of body text under the heading (trimmed, blank lines dropped). */
  lines: string[];
}

/** Split markdown into a title + ordered sections keyed by their headings. */
export function splitSections(markdown: string): {
  title: string | null;
  sections: ParsedSection[];
  /** Leading body before the first `##` heading. */
  preamble: string[];
} {
  const lines = markdown.split(/\r?\n/);
  let title: string | null = null;
  const sections: ParsedSection[] = [];
  const preamble: string[] = [];
  let current: ParsedSection | null = null;

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const h1 = line.match(/^#\s+(.*)$/);
    const h = line.match(/^#{2,6}\s+(.*)$/);
    if (h1 && title === null) {
      title = h1[1]!.trim();
      continue;
    }
    if (h) {
      if (current) sections.push(current);
      current = { heading: h[1]!.trim(), lines: [] };
      continue;
    }
    const trimmed = line.trim();
    if (current) {
      if (trimmed) current.lines.push(trimmed);
    } else if (trimmed && !/^#\s+/.test(line)) {
      preamble.push(trimmed);
    }
  }
  if (current) sections.push(current);
  return { title, sections, preamble };
}

/** Strip a leading list marker (`-`, `*`, `1.`, `[ ]`) from a line. */
export function stripBullet(line: string): string {
  return line
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*\d+[.)]\s+/, "")
    .replace(/^\s*\[[ xX]?\]\s+/, "")
    .trim();
}

/** Whether a line looks like a list item. */
export function isBullet(line: string): boolean {
  return /^\s*([-*+]\s+|\d+[.)]\s+|\[[ xX]?\]\s+)/.test(line);
}

const HEADING_ALIASES: Record<string, string[]> = {
  acceptance: ["acceptance criteria", "acceptance", "definition of done", "dod", "success criteria"],
  requirements: ["requirements", "scope", "what we need", "ask", "details"],
  background: ["background", "context", "summary", "overview", "description", "problem"],
  stakeholders: ["stakeholders", "requested by", "owner", "audience", "consumers", "reporter"],
  sources: ["data sources", "sources", "source systems", "upstream", "inputs"],
  targets: ["deliverables", "outputs", "target models", "dashboards", "models", "reports"],
  dependencies: ["dependencies", "depends on", "blocked by", "related"],
  due: ["due date", "deadline", "timeline", "due", "needed by"],
};

/** Find the first section whose heading matches one of a key's aliases. */
export function findSection(
  sections: ParsedSection[],
  key: keyof typeof HEADING_ALIASES,
): ParsedSection | undefined {
  const aliases = HEADING_ALIASES[key]!;
  return sections.find((s) => {
    const h = s.heading.toLowerCase().trim();
    return aliases.some((a) => h === a || h.startsWith(a) || h.includes(a));
  });
}

/** Extract acceptance-criteria bullet lines from the parsed sections. */
export function extractAcceptanceCriteria(sections: ParsedSection[]): string[] {
  const sec = findSection(sections, "acceptance");
  if (!sec) return [];
  const items = sec.lines.filter(isBullet).map(stripBullet).filter(Boolean);
  // Fall back to non-bullet sentences if no bullets were used.
  if (items.length === 0) {
    return sec.lines.filter(Boolean);
  }
  return items;
}

/** Extract requirement bullet lines (scope/requirements section). */
export function extractRequirements(sections: ParsedSection[]): string[] {
  const sec = findSection(sections, "requirements");
  if (!sec) return [];
  const items = sec.lines.filter(isBullet).map(stripBullet).filter(Boolean);
  return items.length > 0 ? items : sec.lines.filter(Boolean);
}

/** Pull a list (bullets or comma-separated) from a section. */
export function extractList(
  sections: ParsedSection[],
  key: keyof typeof HEADING_ALIASES,
): string[] {
  const sec = findSection(sections, key);
  if (!sec) return [];
  const bullets = sec.lines.filter(isBullet).map(stripBullet).filter(Boolean);
  if (bullets.length > 0) return bullets;
  // Otherwise split the joined body on commas / "and".
  return sec.lines
    .join(" ")
    .split(/,|\band\b/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Mentions of source systems anywhere in the text (heuristic keyword scan). */
const SOURCE_SYSTEM_KEYWORDS = [
  "salesforce",
  "stripe",
  "snowflake",
  "bigquery",
  "redshift",
  "postgres",
  "mysql",
  "hubspot",
  "segment",
  "shopify",
  "netsuite",
  "zendesk",
  "marketo",
  "google analytics",
  "ga4",
  "fivetran",
  "kafka",
  "s3",
  "mongodb",
  "dynamodb",
];

export function detectSourceSystems(text: string): string[] {
  const lower = text.toLowerCase();
  const hits = new Set<string>();
  for (const kw of SOURCE_SYSTEM_KEYWORDS) {
    if (lower.includes(kw)) hits.add(kw);
  }
  return [...hits];
}

/** Detect dbt-model / table / dashboard references (e.g. `fct_orders`, schema.table). */
export function detectTargets(text: string): string[] {
  const hits = new Set<string>();
  // dbt naming conventions: stg_/int_/fct_/dim_/mart_ prefixes.
  for (const m of text.matchAll(/\b(?:stg|int|fct|dim|mart|rpt)_[a-z0-9_]+\b/gi)) {
    hits.add(m[0].toLowerCase());
  }
  // schema.table style identifiers (avoid version numbers / urls).
  for (const m of text.matchAll(/\b[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\b/gi)) {
    hits.add(m[0].toLowerCase());
  }
  return [...hits];
}

/** Detect a due-date / deadline mention. Returns the raw matched phrase. */
export function detectDueDate(text: string): string | null {
  // ISO date or "by <Month> <day>" or "EOQ"/"end of <period>".
  const iso = text.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (iso) return iso[0];
  const phrase = text.match(
    /\b(?:by|before|due|deadline:?)\s+([A-Z][a-z]+\.?\s+\d{1,2}(?:,?\s+\d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|end of (?:the )?(?:week|month|quarter|q[1-4]|year)|eo[wmq]y?)/i,
  );
  return phrase ? phrase[0].trim() : null;
}

/** Detect explicit dependency / blocked-by phrases. */
export function detectDependencies(
  sections: ParsedSection[],
  text: string,
): string[] {
  const fromSection = extractList(sections, "dependencies");
  const fromText: string[] = [];
  for (const m of text.matchAll(
    /\b(?:depends on|blocked by|requires|after)\s+([A-Z]+-\d+|[a-z0-9_]+(?:\s+[a-z0-9_]+){0,4})/gi,
  )) {
    fromText.push(m[0].trim());
  }
  return [...new Set([...fromSection, ...fromText])];
}

/** Detect stakeholders (people / teams / @mentions / "requested by"). */
export function detectStakeholders(
  sections: ParsedSection[],
  text: string,
): string[] {
  const fromSection = extractList(sections, "stakeholders");
  const mentions = [...text.matchAll(/@([a-z0-9_.-]+)/gi)].map((m) => `@${m[1]}`);
  const requested = [...text.matchAll(/\brequested by:?\s+([^\n.]+)/gi)].map((m) =>
    m[1]!.trim(),
  );
  return [...new Set([...fromSection, ...mentions, ...requested])];
}

/**
 * Heuristic ambiguity detection over the metric/grain dimension — flags vague
 * terms that an analytical engineer would need clarified before modeling.
 */
const VAGUE_TERMS = [
  "active",
  "engaged",
  "revenue",
  "recent",
  "top",
  "best",
  "good",
  "successful",
  "churn",
  "retention",
  "conversion",
];

export function detectMetricAmbiguity(text: string): string[] {
  const lower = text.toLowerCase();
  const flags: string[] = [];
  for (const term of VAGUE_TERMS) {
    const re = new RegExp(`\\b${term}\\b`, "i");
    if (re.test(lower)) {
      flags.push(
        `Term "${term}" is used but not defined — needs an explicit definition (formula / grain / filter).`,
      );
    }
  }
  return flags;
}

/** Produce a deterministic one-paragraph business-ask summary. */
export function summarizeAsk(
  title: string | null,
  background: ParsedSection | undefined,
  preamble: string[],
): string {
  if (background && background.lines.length > 0) {
    return background.lines.join(" ");
  }
  if (preamble.length > 0) {
    return preamble.join(" ");
  }
  return title ? `Request: ${title}.` : "No business context provided.";
}
