import { describe, it, expect } from "vitest";
import {
  isSensitiveColumn,
  redactValue,
  redactArtifactContent,
  SensitiveFieldDetector,
  SENSITIVE_FIELD_TOKENS,
  REDACTION_MASK,
} from "../../src/core/policy/index.js";

describe("isSensitiveColumn", () => {
  const sensitive = [
    "email",
    "customer_email",
    "phone",
    "full_name",
    "user_name",
    "home_address",
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
    "auth_token",
    "client_secret",
    "password",
    "EmailAddress",
    "Customer Email",
  ];
  for (const c of sensitive) {
    it(`flags '${c}'`, () => expect(isSensitiveColumn(c)).toBe(true));
  }

  const benign = ["customer_id", "order_id", "amount", "created_at", "country", "filename", "status"];
  for (const c of benign) {
    it(`does not flag '${c}'`, () => expect(isSensitiveColumn(c)).toBe(false));
  }

  it("covers every spec token", () => {
    for (const token of SENSITIVE_FIELD_TOKENS) {
      expect(isSensitiveColumn(token)).toBe(true);
    }
  });
});

describe("redactValue", () => {
  it("masks non-empty values", () => {
    expect(redactValue("alice@example.com")).toBe(REDACTION_MASK);
    expect(redactValue(12345)).toBe(REDACTION_MASK);
  });
  it("passes through empty/nullish", () => {
    expect(redactValue("")).toBe("");
    expect(redactValue(null)).toBe("");
    expect(redactValue(undefined)).toBe("");
  });
});

describe("SensitiveFieldDetector.redactRow", () => {
  it("masks sensitive columns and keeps benign ones", () => {
    const d = new SensitiveFieldDetector();
    const row = d.redactRow({
      customer_id: 7,
      email: "alice@example.com",
      full_name: "Alice Smith",
      amount: 42,
    });
    expect(row.customer_id).toBe(7);
    expect(row.amount).toBe(42);
    expect(row.email).toBe(REDACTION_MASK);
    expect(row.full_name).toBe(REDACTION_MASK);
  });

  it("is a no-op when disabled", () => {
    const d = new SensitiveFieldDetector({ enabled: false });
    const row = d.redactRow({ email: "alice@example.com" });
    expect(row.email).toBe("alice@example.com");
  });
});

describe("redactArtifactContent", () => {
  it("masks emails, SSNs, credit cards, IPs in free text", () => {
    const input = [
      "Customer alice@example.com signed up.",
      "SSN 123-45-6789 was provided.",
      "Card 4111 1111 1111 1111 on file.",
      "From IP 192.168.1.42 last night.",
    ].join("\n");
    const { content, report } = redactArtifactContent(input);
    expect(content).not.toContain("alice@example.com");
    expect(content).not.toContain("123-45-6789");
    expect(content).not.toContain("4111 1111 1111 1111");
    expect(content).not.toContain("192.168.1.42");
    expect(content).toContain(REDACTION_MASK);
    expect(report.count).toBeGreaterThanOrEqual(4);
  });

  it("masks the value side of sensitive key:value pairs", () => {
    const input = 'password: "hunter2"\nemail = bob@corp.test';
    const { content } = redactArtifactContent(input);
    expect(content).not.toContain("hunter2");
    expect(content).not.toContain("bob@corp.test");
  });

  it("leaves benign content untouched", () => {
    const input = "order_id: 1001\namount: 49.99\nstatus: shipped";
    const { content, report } = redactArtifactContent(input);
    expect(content).toBe(input);
    expect(report.count).toBe(0);
  });

  it("never leaks a raw secret token into the output", () => {
    const input = "token = sk-supersecretvalue123\nsecret: topsecret";
    const { content } = redactArtifactContent(input);
    expect(content).not.toContain("sk-supersecretvalue123");
    expect(content).not.toContain("topsecret");
  });
});
