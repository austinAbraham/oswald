/**
 * Regression tests for the two flagged intake / redaction security gaps:
 *
 *  1. Intake raw-prose leak — the intake tentacle surfaces ticket-derived prose
 *     (the business-ask summary, the evidence ledger, the wrapped block) into
 *     `.oswald/intake.md`. A plaintext secret stated inline in the ticket body
 *     ("the password is hunter2", "api key is sk-...") must NOT survive into any
 *     persisted artifact: every artifact is run through redactArtifactContent
 *     before write, and value-level inline-secret redaction now catches prose
 *     secrets that have no column-name context.
 *
 *  2. Trailing-punctuation phone — a phone number at the END of a sentence (with
 *     a trailing period / comma) must be redacted IN FULL, not clipped to a
 *     truncated prefix that leaks the final digits.
 *
 * These exercise the REAL `oswald intake` CLI path end-to-end (temp dir, no
 * network, no live LLM) and assert the on-disk artifacts contain no plaintext
 * secret and a fully-redacted phone.
 */
import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildProgram } from "../../src/cli/index.js";
import {
  redactArtifactContent,
  REDACTION_MASK,
} from "../../src/core/policy/index.js";

// A ticket whose BACKGROUND (which becomes the trusted top-level summary) states
// secrets inline in prose, plus a phone number ending a sentence (trailing `.`).
const LEAKY_TICKET = `# Monthly revenue rollup

## Background
Build a revenue rollup from raw.finance.invoices. For the staging DB the
password is hunter2 and the api key is sk-live-DEADBEEF0123456789. Use
token: ghp_ABCDEF0123456789ABCDEF0123456789ABCD when calling the API, and the
auth header should send Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.aaaa.bbbb.
If you get stuck, call the data owner at +1 (555) 123-4567.

## Requirements
- Group invoices by calendar month

## Acceptance criteria
- [ ] Monthly totals reconcile with finance within 1%
`;

// The exact secrets that must NEVER appear verbatim in any artifact.
const PLAINTEXT_SECRETS = [
  "hunter2",
  "sk-live-DEADBEEF0123456789",
  "ghp_ABCDEF0123456789ABCDEF0123456789ABCD",
  "eyJhbGciOiJIUzI1NiJ9.aaaa.bbbb",
];

const tmpDirs: string[] = [];
async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oswald-leak-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  process.exitCode = 0;
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function cli(root: string, ...argv: string[]): Promise<number> {
  const program = buildProgram();
  program.exitOverride();
  const prev = process.exitCode;
  process.exitCode = 0;
  try {
    await program.parseAsync(["node", "oswald", ...argv, "--cwd", root]);
  } catch {
    /* exitOverride; command set exitCode. */
  }
  const code = typeof process.exitCode === "number" ? process.exitCode : 0;
  process.exitCode = prev;
  return code;
}

/** Read every file the intake tentacle wrote under `.oswald/`. */
async function readAllArtifacts(root: string): Promise<Record<string, string>> {
  const dir = path.join(root, ".oswald");
  const entries = await fs.readdir(dir);
  const out: Record<string, string> = {};
  for (const name of entries) {
    const full = path.join(dir, name);
    const stat = await fs.stat(full);
    if (stat.isFile()) out[name] = await fs.readFile(full, "utf8");
  }
  return out;
}

describe("SECURITY: intake never leaks inline secrets into .oswald artifacts", () => {
  it("produces artifacts with NO plaintext secret anywhere", async () => {
    const root = await makeTmpDir();
    const fixture = path.join(root, "leaky-ticket.md");
    await fs.writeFile(fixture, LEAKY_TICKET, "utf8");

    await cli(root, "init");
    const code = await cli(root, "intake", "REV-1", "--from-file", fixture);
    expect(code).toBe(0);

    const artifacts = await readAllArtifacts(root);
    // The brief MUST exist and MUST be one of the things we scan.
    expect(artifacts["intake.md"]).toBeTruthy();

    for (const [name, content] of Object.entries(artifacts)) {
      for (const secret of PLAINTEXT_SECRETS) {
        expect(
          content.includes(secret),
          `plaintext secret '${secret}' leaked into .oswald/${name}`,
        ).toBe(false);
      }
    }
  });

  it("redacts the secret in the trusted top-level summary line, not just the wrapped block", async () => {
    const root = await makeTmpDir();
    const fixture = path.join(root, "leaky-ticket.md");
    await fs.writeFile(fixture, LEAKY_TICKET, "utf8");

    await cli(root, "init");
    await cli(root, "intake", "REV-1", "--from-file", fixture);

    const brief = await fs.readFile(
      path.join(root, ".oswald", "intake.md"),
      "utf8",
    );
    // The summary paragraph (derived from Background prose) sits ABOVE the
    // untrusted wrapper; it must carry the redaction mask, proving the prose
    // passed through redactArtifactContent rather than bypassing it.
    expect(brief).toContain(REDACTION_MASK);
    expect(brief).not.toContain("hunter2");
  });

  it("redacts a phone number that ends a sentence (trailing period) in full", async () => {
    const root = await makeTmpDir();
    const fixture = path.join(root, "leaky-ticket.md");
    await fs.writeFile(fixture, LEAKY_TICKET, "utf8");

    await cli(root, "init");
    await cli(root, "intake", "REV-1", "--from-file", fixture);

    const artifacts = await readAllArtifacts(root);
    for (const [name, content] of Object.entries(artifacts)) {
      // Neither the full number nor any clipped fragment of the local part may
      // survive. The trailing-period bug used to leave "4567" behind.
      expect(
        content.includes("123-4567"),
        `phone fragment leaked into .oswald/${name}`,
      ).toBe(false);
      expect(
        content.includes("4567"),
        `clipped phone digits leaked into .oswald/${name}`,
      ).toBe(false);
    }
  });
});

describe("redactArtifactContent: inline secrets (no column context)", () => {
  it.each([
    ["the password is hunter2", "hunter2"],
    ["password: s3cr3tpw99", "s3cr3tpw99"],
    ["the api key is sk-live-DEADBEEF0123456789", "sk-live-DEADBEEF0123456789"],
    ["api-key = AIzaSyA1234567890abcdefghijklmnop", "AIzaSyA1234567890abcdefghijklmnop"],
    ["token is ghp_ABCDEF0123456789ABCDEF0123456789ABCD", "ghp_ABCDEF0123456789ABCDEF0123456789ABCD"],
    ["use bearer token: abc123DEF456ghi789", "abc123DEF456ghi789"],
    ["the client secret is topSecretValue", "topSecretValue"],
    ["Authorization: Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9", "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9"],
  ])("redacts inline secret in %j", (input, secret) => {
    const { content } = redactArtifactContent(input);
    expect(content).not.toContain(secret);
    expect(content).toContain(REDACTION_MASK);
  });

  it("provider key prefixes are caught even bare in prose", () => {
    const { content } = redactArtifactContent(
      "We rotated to sk-proj-ABCDEFGHIJKLMNOP last week.",
    );
    expect(content).not.toContain("sk-proj-ABCDEFGHIJKLMNOP");
  });
});

describe("redactArtifactContent: phone trailing-punctuation matcher", () => {
  it.each([
    "Call me at +1 (555) 123-4567.",
    "Call me at +1 (555) 123-4567,",
    "Reach the owner on 555-123-4567!",
    "Phone (020) 7946 0958.",
    "Tel: +44 20 7946 0958)",
  ])("fully redacts the phone in %j", (input) => {
    const { content } = redactArtifactContent(input);
    expect(content).toContain(REDACTION_MASK);
    // No 4+ digit run from the local part survives.
    expect(/\d{4}/.test(content.replace(REDACTION_MASK, ""))).toBe(false);
  });

  it("does NOT over-redact dates, money, percentages, or short ids", () => {
    const input = [
      "Deliver by 2026-06-30 with amount 49.99 and tax 7.5.",
      "Order 1001 shipped; revenue grew 12 percent in Q4.",
      "Version 1.2.3 has 99 issues.",
    ].join("\n");
    const { content, report } = redactArtifactContent(input);
    expect(content).toBe(input);
    expect(report.count).toBe(0);
  });

  it("redacts a phone but keeps an adjacent date intact", () => {
    const input = "On 2026-06-30, call +1 (555) 987-6543.";
    const { content } = redactArtifactContent(input);
    expect(content).toContain("2026-06-30");
    expect(content).not.toContain("987-6543");
    expect(content).toContain(REDACTION_MASK);
  });
});
