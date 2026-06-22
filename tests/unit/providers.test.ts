import { describe, it, expect } from "vitest";
import {
  MockTicketProvider,
  MockWarehouseProvider,
  MockRepoProvider,
  MockDocumentProvider,
} from "../../src/tools/providers/mock/index.js";
import { McpToolProvider, MCP_UNAVAILABLE_MESSAGE } from "../../src/tools/mcp/index.js";
import { REDACTION_MASK } from "../../src/core/policy/index.js";

describe("mock provider capability discovery", () => {
  it("ticket provider advertises read + gated-write capabilities", () => {
    const p = new MockTicketProvider();
    const caps = p.capabilities();
    expect(caps.map((c) => c.name)).toEqual(
      expect.arrayContaining(["getTicket", "searchRelated", "draftComment", "postComment"]),
    );
    expect(caps.find((c) => c.name === "postComment")?.write).toBe(true);
    expect(caps.find((c) => c.name === "getTicket")?.write).toBe(false);
    expect(p.kind).toBe("ticket");
  });

  it("warehouse provider advertises only read capabilities", () => {
    const p = new MockWarehouseProvider();
    expect(p.capabilities().every((c) => c.write === false)).toBe(true);
    expect(p.kind).toBe("warehouse");
  });

  it("repo provider marks branch/commit/PR as writes", () => {
    const p = new MockRepoProvider({ branch: "main" });
    const caps = p.capabilities();
    expect(caps.find((c) => c.name === "createBranch")?.write).toBe(true);
    expect(caps.find((c) => c.name === "currentBranch")?.write).toBe(false);
  });

  it("document provider is read-only", () => {
    const p = new MockDocumentProvider();
    expect(p.capabilities().every((c) => c.write === false)).toBe(true);
  });
});

describe("mock provider health", () => {
  it("all mocks report a health state", async () => {
    const providers = [
      new MockTicketProvider({ tickets: { "T-1": { id: "T-1", title: "x", body: "y", source: "mock" } } }),
      new MockWarehouseProvider(),
      new MockRepoProvider({ branch: "main" }),
      new MockDocumentProvider(),
    ];
    for (const p of providers) {
      const h = await p.health();
      expect(["ok", "degraded", "unavailable"]).toContain(h.state);
    }
  });
});

describe("MockTicketProvider", () => {
  const ticket = { id: "T-1", title: "Revenue model", body: "build it", source: "mock" };

  it("reads an inline ticket fixture", async () => {
    const p = new MockTicketProvider({ tickets: { "T-1": ticket } });
    expect((await p.getTicket("T-1")).title).toBe("Revenue model");
  });

  it("default-denies postComment without explicit yes", async () => {
    const p = new MockTicketProvider({ tickets: { "T-1": ticket } });
    const draft = await p.draftComment("T-1", "done");
    const r = await p.postComment(draft);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/approval|consent/i);
  });

  it("allows postComment with yes + permitting policy", async () => {
    const p = new MockTicketProvider({
      tickets: { "T-1": ticket },
      policy: { requireApprovalFor: ["ticket_update"], prohibit: [] },
    });
    const draft = await p.draftComment("T-1", "done");
    const r = await p.postComment(draft, { yes: true });
    expect(r.ok).toBe(true);
    expect(r.data?.posted).toBe(true);
  });
});

describe("MockWarehouseProvider", () => {
  it("lists fixture schemas and tables, marking sensitive columns", async () => {
    const p = new MockWarehouseProvider();
    expect(await p.listSchemas()).toContain("analytics");
    const t = await p.describeTable("analytics", "customers");
    const email = t.columns.find((c) => c.name === "email");
    expect(email?.sensitive).toBe(true);
    const id = t.columns.find((c) => c.name === "customer_id");
    expect(id?.sensitive).toBe(false);
  });

  it("rejects a write statement via the SQL validator", async () => {
    const p = new MockWarehouseProvider();
    const r = await p.executeReadOnlySql("DROP TABLE customers");
    expect(r.ok).toBe(false);
  });

  it("runs a read query and redacts sensitive result columns", async () => {
    const p = new MockWarehouseProvider({
      fixture: {
        schemas: {},
        cannedResults: [
          {
            match: "select",
            result: {
              columns: ["customer_id", "email"],
              rows: [{ customer_id: 1, email: "alice@example.com" }],
            },
          },
        ],
      },
    });
    const r = await p.executeReadOnlySql("SELECT customer_id, email FROM analytics.customers");
    expect(r.ok).toBe(true);
    expect(r.data?.rows[0]?.customer_id).toBe(1);
    expect(r.data?.rows[0]?.email).toBe(REDACTION_MASK);
  });

  it("explainSql also rejects writes", async () => {
    const p = new MockWarehouseProvider();
    expect((await p.explainSql("DELETE FROM x")).ok).toBe(false);
    expect((await p.explainSql("SELECT 1")).ok).toBe(true);
  });
});

describe("MockRepoProvider writes default-deny", () => {
  it("denies createBranch/commit/openPullRequest without yes", async () => {
    const p = new MockRepoProvider({ branch: "main" });
    expect((await p.createBranch("feat/x")).ok).toBe(false);
    expect((await p.commit("msg", ["a.sql"])).ok).toBe(false);
    expect((await p.openPullRequest({ title: "t", branch: "feat/x", base: "main" })).ok).toBe(false);
  });

  it("allows with yes + permitting policy", async () => {
    const p = new MockRepoProvider({
      branch: "main",
      policy: { requireApprovalFor: ["create_branch"], prohibit: [] },
    });
    expect((await p.createBranch("feat/x", { yes: true })).ok).toBe(true);
  });
});

describe("McpToolProvider stub", () => {
  it("reports unavailable when no server configured", async () => {
    const p = new McpToolProvider({ name: "dbt-mcp", kind: "warehouse" });
    const h = await p.health();
    expect(h.state).toBe("unavailable");
    expect(h.detail).toContain(MCP_UNAVAILABLE_MESSAGE);
    expect(p.configured).toBe(false);
    expect(p.capabilities()).toEqual([]);
  });

  it("invoke returns an unavailable error rather than throwing", async () => {
    const p = new McpToolProvider({ name: "dbt-mcp", kind: "warehouse" });
    const r = await p.invoke("list", {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain(MCP_UNAVAILABLE_MESSAGE);
  });

  it("connect() throws to make the unwired seam obvious", async () => {
    const p = new McpToolProvider({ name: "dbt-mcp", kind: "warehouse" });
    await expect(p.connect()).rejects.toThrow(/not implemented/);
  });
});
