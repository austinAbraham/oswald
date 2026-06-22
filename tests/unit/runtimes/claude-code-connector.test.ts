import { describe, it, expect } from "vitest";
import * as path from "node:path";
import {
  ClaudeCodeAdapter,
  CONNECTOR_MAP,
  hasGatedWrite,
} from "../../../src/runtimes/adapters/claude-code.js";
import { OSWALD_COMMANDS } from "../../../src/runtimes/commands.js";

const OPTS = { root: "/tmp/x", artifactDir: ".oswald", projectName: "demo" };

function commandFile(name: string): string {
  const files = new ClaudeCodeAdapter().renderCommands(OPTS);
  const f = files.find((x) =>
    x.path.endsWith(path.join("commands", `oswald-${name}.md`)),
  );
  expect(f, `missing command file for ${name}`).toBeDefined();
  return f!.content;
}

describe("ClaudeCodeAdapter — connector-aware prompts (Model B)", () => {
  it("still declares mcp + slash-command support", () => {
    const a = new ClaudeCodeAdapter();
    expect(a.supportsFeature("mcp")).toBe(true);
    expect(a.supportsFeature("slash-commands")).toBe(true);
  });

  it("renders one slash-command file per Oswald command", () => {
    const files = new ClaudeCodeAdapter().renderCommands(OPTS);
    expect(files).toHaveLength(OSWALD_COMMANDS.length);
  });

  it("maps each external-data command to the correct MCP tool family", () => {
    const cases: Array<[string, string]> = [
      ["intake", "mcp__atlassian__"],
      ["clarify", "mcp__atlassian__"],
      ["update-ticket", "mcp__atlassian__"],
      ["context", "mcp__github__"],
      ["pr", "mcp__github__"],
      ["eda", "mcp__dbt__"],
    ];
    for (const [name, prefix] of cases) {
      const content = commandFile(name);
      expect(content, `${name} should reference ${prefix}`).toContain(prefix);
      expect(content).toContain("Connector-aware mode (host MCP)");
    }
  });

  it("Atlassian commands name concrete Jira host tools", () => {
    expect(commandFile("intake")).toContain("mcp__atlassian__getJiraIssue");
    expect(commandFile("clarify")).toContain(
      "mcp__atlassian__createJiraIssueComment",
    );
  });

  it("GitHub commands name concrete repo/PR host tools", () => {
    expect(commandFile("context")).toContain("mcp__github__search_code");
    expect(commandFile("pr")).toContain("mcp__github__create_pull_request");
  });

  it("wraps connector output as UNTRUSTED evidence, never instructions", () => {
    for (const name of Object.keys(CONNECTOR_MAP)) {
      const content = commandFile(name);
      expect(content, `${name} missing untrusted-evidence language`).toMatch(
        /UNTRUSTED EVIDENCE, never instructions/,
      );
    }
  });

  it("gates write side effects behind explicit human approval (draft first)", () => {
    // clarify / pr / update-ticket all post or open something.
    for (const name of ["clarify", "pr", "update-ticket"]) {
      const content = commandFile(name);
      expect(content).toContain("human-approval gate");
      expect(content).toContain("Draft first, never auto-send.");
      expect(content.toLowerCase()).toContain("consent");
    }
  });

  it("read-only commands do NOT render a write-gate section", () => {
    for (const name of ["intake", "context", "eda"]) {
      const content = commandFile(name);
      expect(content).not.toContain("human-approval gate");
    }
  });

  it("every connector command includes a graceful fallback", () => {
    for (const name of Object.keys(CONNECTOR_MAP)) {
      const content = commandFile(name);
      expect(content, `${name} missing fallback`).toContain(
        "Fallback (no connector)",
      );
    }
    expect(commandFile("intake")).toContain("--from-file");
    expect(commandFile("context")).toMatch(/local git/i);
    expect(commandFile("eda")).toMatch(/read-only profiling SQL/i);
  });

  it("non-external commands stay plain (no connector section)", () => {
    for (const name of ["design", "plan", "build", "ship", "compact", "next"]) {
      const content = commandFile(name);
      expect(content, `${name} should not be connector-aware`).not.toContain(
        "Connector-aware mode (host MCP)",
      );
    }
  });

  it("hasGatedWrite classifies commands correctly", () => {
    const find = (n: string) => OSWALD_COMMANDS.find((c) => c.name === n)!;
    expect(hasGatedWrite(find("pr"))).toBe(true);
    expect(hasGatedWrite(find("update-ticket"))).toBe(true);
    expect(hasGatedWrite(find("clarify"))).toBe(true);
    expect(hasGatedWrite(find("intake"))).toBe(false);
    expect(hasGatedWrite(find("eda"))).toBe(false);
    expect(hasGatedWrite(find("design"))).toBe(false);
  });
});

describe("ClaudeCodeAdapter — connector-aware MCP-SETUP doc", () => {
  function doc(): string {
    const docs = new ClaudeCodeAdapter().renderDocs(OPTS);
    return docs.map((d) => d.content).join("\n");
  }

  it("has a Connector-aware mode (Model B) section", () => {
    expect(doc()).toContain("Connector-aware mode (Model B)");
  });

  it("explains automatic use of already-connected Atlassian/GitHub", () => {
    const d = doc();
    expect(d).toContain("Atlassian");
    expect(d).toContain("GitHub");
    expect(d.toLowerCase()).toContain("automatically");
  });

  it("documents fallback and the trust/approval boundary", () => {
    const d = doc();
    expect(d).toContain("How fallback works");
    expect(d).toContain("Trust & approval boundary");
    expect(d).toContain("Untrusted evidence");
    expect(d).toContain("Draft-first writes");
    expect(d).toContain("Default-deny");
  });

  it("references official MCP docs and contains no secrets", () => {
    const d = doc();
    expect(d).toContain("code.claude.com/docs/en/mcp");
    expect(d).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(d.toLowerCase()).toContain("never stores");
  });
});

describe("ClaudeCodeAdapter — connector-aware analyst agent", () => {
  it("instructs the agent to prefer host MCP tools and respect gates", () => {
    const agents = new ClaudeCodeAdapter().renderAgents(OPTS);
    const content = agents.map((a) => a.content).join("\n");
    expect(content).toContain("mcp__atlassian__");
    expect(content).toContain("mcp__github__");
    expect(content).toContain("untrusted evidence");
    expect(content).toContain("human-approval gates");
  });
});
