/**
 * Sensitive-field detection and redaction.
 *
 * Two responsibilities:
 *  1. Decide whether a *column / field name* looks like it holds PII.
 *  2. Redact sensitive *values* out of free-form artifact content (markdown /
 *     structured docs) before they are persisted, so EDA samples and ticket
 *     text never leak raw PII into the repo.
 *
 * This is heuristic, not a guarantee — it is a defense-in-depth masking layer
 * on top of the read-only / aggregate-preferring warehouse policy.
 */

/** Canonical sensitive field tokens from the project PII spec. */
export const SENSITIVE_FIELD_TOKENS = [
  "email",
  "phone",
  "name",
  "address",
  "ssn",
  "ni_number",
  "national_insurance",
  "dob",
  "date_of_birth",
  "credit_card",
  "card_number",
  "iban",
  "account_number",
  "ip_address",
  "user_agent",
  "token",
  "secret",
  "password",
] as const;

export type SensitiveFieldToken = (typeof SENSITIVE_FIELD_TOKENS)[number];

/** The mask string substituted for redacted values. */
export const REDACTION_MASK = "[REDACTED]";

/**
 * Normalize a column name to its bare token form: lowercase, separators
 * collapsed to `_`, common prefixes/suffixes ignored at the matching layer.
 */
function normalizeName(name: string): string {
  return name
    .trim()
    // split camelCase / PascalCase boundaries into separators first
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[\s\-.]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

/**
 * Split a normalized name into word-ish parts so we can match whole tokens
 * (e.g. `customer_email_address` → ["customer","email","address"]) without
 * matching substrings inside unrelated words (`username` should NOT match
 * `name` as a value-bearing field on its own — but `user_name` should).
 */
function nameParts(normalized: string): string[] {
  return normalized.split("_").filter(Boolean);
}

/**
 * Whether a column/field name looks sensitive.
 *
 * Matching strategy:
 *  - Multi-word tokens (e.g. `date_of_birth`, `ip_address`) match if the
 *    normalized name contains that token as a contiguous substring.
 *  - Single-word tokens match if they appear as a standalone word-part of the
 *    name (so `email` matches `customer_email` but `name` does NOT match
 *    `filename` — yet `name` DOES match `full_name`).
 */
export function isSensitiveColumn(name: string): boolean {
  if (!name) return false;
  const normalized = normalizeName(name);
  if (!normalized) return false;
  const parts = new Set(nameParts(normalized));

  for (const token of SENSITIVE_FIELD_TOKENS) {
    if (token.includes("_")) {
      // multi-word token: contiguous substring match
      if (normalized.includes(token)) return true;
    } else if (parts.has(token)) {
      // single-word token: must be a standalone word part
      return true;
    }
  }
  return false;
}

/** Which sensitive tokens a name matched (for reporting / audit). */
export function matchedSensitiveTokens(name: string): SensitiveFieldToken[] {
  const normalized = normalizeName(name);
  const parts = new Set(nameParts(normalized));
  const hits: SensitiveFieldToken[] = [];
  for (const token of SENSITIVE_FIELD_TOKENS) {
    if (token.includes("_")) {
      if (normalized.includes(token)) hits.push(token);
    } else if (parts.has(token)) {
      hits.push(token);
    }
  }
  return hits;
}

/** Redact a single scalar value. Empty/nullish values are returned as-is. */
export function redactValue(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return String(value ?? "");
  }
  return REDACTION_MASK;
}

/**
 * Value patterns that look like PII regardless of any associated column name.
 * Used to scrub free-form text where we have no column context.
 */
const VALUE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // email
  {
    name: "email",
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  // credit-card-ish: 13-16 digits, optionally grouped by spaces/dashes
  {
    name: "credit_card",
    re: /\b(?:\d[ -]?){13,16}\b/g,
  },
  // US SSN
  { name: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  // IBAN (loose)
  { name: "iban", re: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g },
  // IPv4 address
  {
    name: "ip_address",
    re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
  },
];

/**
 * Phone-number detection is handled separately from the simple value patterns
 * because it needs a post-match guard. A naive `(?![\w.])` trailing boundary
 * clips a phone at the end of a sentence ("...call 555-123-4567.") — the engine
 * backtracks past the disallowed trailing `.` and matches a truncated prefix,
 * leaking the final digits. So the boundary forbids only a following *word*
 * char (allowing trailing punctuation), the run is anchored to end on a digit,
 * and the callback then enforces a real digit-count floor so dates ("2026-06-30"),
 * money ("49.99"), and short ids ("1001") are NOT over-redacted.
 */
const PHONE_RE = /(?<![\w.])\+?\d(?:[\d\s().-]*\d)?(?=[^\w]|$)/g;

/** Count the bare digits in a candidate phone match. */
function digitCount(s: string): number {
  let n = 0;
  for (const ch of s) if (ch >= "0" && ch <= "9") n++;
  return n;
}

/** ISO-date / decimal-number shapes we must never treat as phone numbers. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL_RE = /^\d+\.\d+$/;

/** Whether a candidate run looks like a real phone number (vs date/money/id). */
function looksLikePhone(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (ISO_DATE_RE.test(trimmed)) return false;
  if (DECIMAL_RE.test(trimmed)) return false;
  // Require at least 7 actual digits — the floor for a dialable number.
  return digitCount(trimmed) >= 7;
}

/**
 * Inline secret patterns: free-prose assignments like "the password is hunter2",
 * "token: sk-abc123", "api key = ...", bearer tokens, and long high-entropy-ish
 * secret blobs. These have NO column-name context (so the keyed-value pass and
 * `isSensitiveColumn` never see them) and no PII shape (so the value patterns
 * above miss them) — yet they are exactly the plaintext secrets that must never
 * land in an artifact. Each regex captures the secret in group 1 so only the
 * secret value is masked, leaving the surrounding prose intact.
 */
const INLINE_SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // "password is hunter2", "the password = hunter2", "pwd: hunter2",
  // "passphrase -> X". Connector may be is/:/=/->. Captures the secret token.
  {
    name: "inline_password",
    re: /\b(?:pass(?:word|phrase)?|pwd)\b\s*(?:is|=|:|->|=>|was|will be)?\s*["'`]?([^\s"'`,;]{3,})["'`]?/gi,
  },
  // "token is X", "auth token: X", "access token = X", "api token X".
  {
    name: "inline_token",
    re: /\b(?:auth|access|api|bearer|refresh|session|csrf)?[\s_-]*tokens?\b\s*(?:is|=|:|->|=>|are)?\s*["'`]?([A-Za-z0-9._+/=-]{6,})["'`]?/gi,
  },
  // "api key is X", "apikey: X", "api-key = X".
  {
    name: "inline_api_key",
    re: /\bapi[\s_-]?keys?\b\s*(?:is|=|:|->|=>|are)?\s*["'`]?([A-Za-z0-9._+/=-]{6,})["'`]?/gi,
  },
  // "secret is X", "client secret: X", "the secret = X".
  {
    name: "inline_secret",
    re: /\b(?:client[\s_-]?)?secrets?\b\s*(?:is|=|:|->|=>|are)?\s*["'`]?([A-Za-z0-9._+/=-]{4,})["'`]?/gi,
  },
  // Bearer auth header value: "Authorization: Bearer <token>" / "Bearer <token>".
  {
    name: "bearer_token",
    re: /\bBearer\s+([A-Za-z0-9._~+/=-]{8,})/gi,
  },
  // Common provider key prefixes (OpenAI sk-, GitHub ghp_/gho_, Slack xox*,
  // AWS AKIA, Google AIza). High precision — prefix + body.
  {
    name: "provider_key",
    re: /\b(sk-[A-Za-z0-9-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z._-]{20,})\b/g,
  },
];

export interface RedactionReport {
  /** Total number of redactions applied. */
  count: number;
  /** Count of redactions by detector name. */
  byKind: Record<string, number>;
}

export interface RedactContentResult {
  content: string;
  report: RedactionReport;
}

/**
 * Mask sensitive-looking values in free-form markdown / text content.
 *
 * This scrubs values by pattern (emails, card numbers, SSNs, IPs, phones,
 * IBANs). It also masks the right-hand side of obvious `sensitive_key: value`
 * / `sensitive_key = value` assignments where the key is a sensitive column.
 */
export function redactArtifactContent(content: string): RedactContentResult {
  const byKind: Record<string, number> = {};
  let out = content;

  const bump = (kind: string, n: number): void => {
    if (n > 0) byKind[kind] = (byKind[kind] ?? 0) + n;
  };

  // 1. Mask `sensitive_key: value` / `sensitive_key = value` / `"key": "value"`.
  out = out.replace(
    /(["'`]?)([A-Za-z0-9_ .-]+?)\1\s*[:=]\s*(["'`]?)([^\n\r,}]+?)\3(?=\s*[,}\n\r]|$)/g,
    (match, _q1: string, key: string, _q3: string, value: string) => {
      if (isSensitiveColumn(key) && value.trim() !== "") {
        bump("keyed_value", 1);
        return match.replace(value, REDACTION_MASK);
      }
      return match;
    },
  );

  // 1b. Mask inline secrets in free prose ("the password is hunter2",
  //     "token: sk-...", bearer tokens, provider key prefixes). Only the
  //     captured secret (group 1) is masked so surrounding prose survives.
  for (const { name, re } of INLINE_SECRET_PATTERNS) {
    out = out.replace(re, (match: string, secret: string) => {
      if (!secret || secret.includes(REDACTION_MASK)) return match;
      bump(name, 1);
      return match.replace(secret, REDACTION_MASK);
    });
  }

  // 2. Mask by value pattern.
  for (const { name, re } of VALUE_PATTERNS) {
    out = out.replace(re, (m) => {
      // Avoid double-masking already-redacted spans.
      if (m.includes(REDACTION_MASK)) return m;
      bump(name, 1);
      return REDACTION_MASK;
    });
  }

  // 3. Mask phone numbers — guarded so dates / money / ids survive, but a
  //    phone with trailing punctuation is redacted in full.
  out = out.replace(PHONE_RE, (m: string) => {
    if (m.includes(REDACTION_MASK)) return m;
    if (!looksLikePhone(m)) return m;
    bump("phone", 1);
    // Preserve any leading whitespace the run may have captured.
    const lead = m.match(/^\s*/)?.[0] ?? "";
    return `${lead}${REDACTION_MASK}`;
  });

  const count = Object.values(byKind).reduce((a, b) => a + b, 0);
  return { content: out, report: { count, byKind } };
}

/**
 * Detector + redactor bundle. Carries an `enabled` flag wired from
 * `config.policies.privacy.mask_sensitive_values` so callers can pass the whole
 * thing around.
 */
export class SensitiveFieldDetector {
  readonly enabled: boolean;

  constructor(options: { enabled?: boolean } = {}) {
    this.enabled = options.enabled ?? true;
  }

  isSensitiveColumn(name: string): boolean {
    return isSensitiveColumn(name);
  }

  matchedTokens(name: string): SensitiveFieldToken[] {
    return matchedSensitiveTokens(name);
  }

  redactValue(value: unknown): string {
    return this.enabled ? redactValue(value) : String(value ?? "");
  }

  /**
   * Redact a row object: any column whose name is sensitive has its value
   * masked. Returns a new object.
   */
  redactRow(row: Record<string, unknown>): Record<string, unknown> {
    if (!this.enabled) return { ...row };
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(row)) {
      out[key] = this.isSensitiveColumn(key) ? redactValue(val) : val;
    }
    return out;
  }

  redactArtifactContent(content: string): RedactContentResult {
    if (!this.enabled) return { content, report: { count: 0, byKind: {} } };
    return redactArtifactContent(content);
  }
}
