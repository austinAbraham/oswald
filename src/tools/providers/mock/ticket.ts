/**
 * Mock ticket provider — reads a local markdown or JSON fixture.
 *
 * Powers offline / test mode. Reads are real (from the fixture); writes
 * (`postComment`) route through the ApprovalService and default-deny.
 */
import { promises as fs } from "node:fs";
import {
  ApprovalService,
  type ApprovalPolicy,
} from "../../../core/approvals/index.js";
import { wrapUntrusted } from "../../../core/policy/external-content.js";
import type {
  Capability,
  CommentDraft,
  HealthReport,
  InvokeOptions,
  InvokeResult,
  RelatedTicket,
  Ticket,
  TicketProvider,
} from "../types.js";

export interface MockTicketOptions {
  /** Path to a fixture file (.json or .md). */
  fixturePath?: string;
  /** Inline ticket fixtures keyed by id (overrides file). */
  tickets?: Record<string, Ticket>;
  approvals?: ApprovalService;
  policy?: ApprovalPolicy;
}

const DEFAULT_POLICY: ApprovalPolicy = {
  requireApprovalFor: ["ticket_update"],
  prohibit: [],
};

function parseMarkdownTicket(content: string, id: string): Ticket {
  // First `# Title` line is the title; the rest is the body.
  const lines = content.split(/\r?\n/);
  const titleLine = lines.find((l) => /^#\s+/.test(l));
  const title = titleLine ? titleLine.replace(/^#\s+/, "").trim() : id;
  const body = content;
  return { id, title, body, source: "mock-md" };
}

export class MockTicketProvider implements TicketProvider {
  readonly name = "mock-ticket";
  readonly kind = "ticket" as const;

  private readonly fixturePath: string | undefined;
  private readonly inline: Record<string, Ticket> | undefined;
  private readonly approvals: ApprovalService;
  private readonly policy: ApprovalPolicy;

  constructor(options: MockTicketOptions = {}) {
    this.fixturePath = options.fixturePath;
    this.inline = options.tickets;
    this.approvals = options.approvals ?? new ApprovalService();
    this.policy = options.policy ?? DEFAULT_POLICY;
  }

  capabilities(): Capability[] {
    return [
      { name: "getTicket", write: false, description: "Read a ticket by id" },
      { name: "searchRelated", write: false, description: "Find related tickets" },
      { name: "draftComment", write: false, description: "Draft a comment (no post)" },
      { name: "postComment", write: true, description: "Post a comment (gated)" },
    ];
  }

  async health(): Promise<HealthReport> {
    if (this.inline) {
      return { state: "ok", detail: `inline fixtures (${Object.keys(this.inline).length} ticket(s))` };
    }
    if (this.fixturePath) {
      try {
        await fs.access(this.fixturePath);
        return { state: "ok", detail: `fixture at ${this.fixturePath}` };
      } catch {
        return { state: "unavailable", detail: `fixture not found: ${this.fixturePath}` };
      }
    }
    return { state: "degraded", detail: "no fixture configured; getTicket will fail" };
  }

  async getTicket(id: string): Promise<Ticket> {
    if (this.inline?.[id]) {
      return this.markTrust(this.inline[id]!);
    }
    if (!this.fixturePath) {
      throw new Error(`mock-ticket: no fixture configured for ticket '${id}'`);
    }
    const raw = await fs.readFile(this.fixturePath, "utf8");
    if (this.fixturePath.endsWith(".json")) {
      const parsed = JSON.parse(raw) as Ticket | Record<string, Ticket>;
      const ticket =
        "id" in (parsed as Ticket)
          ? (parsed as Ticket)
          : (parsed as Record<string, Ticket>)[id];
      if (!ticket) throw new Error(`mock-ticket: ticket '${id}' not in fixture`);
      return this.markTrust({ ...ticket, source: ticket.source ?? "mock-json" });
    }
    return this.markTrust(parseMarkdownTicket(raw, id));
  }

  /** Annotate body with a trust-wrapped copy for downstream prompt building. */
  private markTrust(ticket: Ticket): Ticket {
    return { ...ticket };
  }

  async searchRelated(query: string): Promise<RelatedTicket[]> {
    const pool = this.inline ? Object.values(this.inline) : [];
    const q = query.toLowerCase();
    return pool
      .filter((t) => (t.title + t.body).toLowerCase().includes(q))
      .map((t) => ({ id: t.id, title: t.title, url: t.url, score: 1 }));
  }

  async draftComment(ticketId: string, body: string): Promise<CommentDraft> {
    return { ticketId, body };
  }

  async postComment(
    draft: CommentDraft,
    options: InvokeOptions = {},
  ): Promise<InvokeResult<{ posted: boolean }>> {
    const decision = this.approvals.requireApproval("ticket_update", {
      yes: options.yes,
      policy: this.policy,
      reason: options.reason,
    });
    if (!decision.allowed) {
      return { ok: false, error: decision.reason };
    }
    if (!draft.ticketId || !draft.body) {
      return { ok: false, error: "draft requires both ticketId and body" };
    }
    // Mock: pretend to post.
    return { ok: true, data: { posted: true } };
  }

  async invoke(
    toolName: string,
    args: Record<string, unknown>,
    options?: InvokeOptions,
  ): Promise<InvokeResult> {
    switch (toolName) {
      case "getTicket":
        return { ok: true, data: await this.getTicket(String(args.id)) };
      case "searchRelated":
        return { ok: true, data: await this.searchRelated(String(args.query)) };
      case "draftComment":
        return {
          ok: true,
          data: await this.draftComment(String(args.ticketId), String(args.body)),
        };
      case "postComment":
        return this.postComment(
          { ticketId: String(args.ticketId), body: String(args.body) },
          options,
        );
      default:
        return { ok: false, error: `unknown ticket tool: ${toolName}` };
    }
  }
}

/** Helper to produce a trust-wrapped view of a ticket's untrusted text. */
export function wrapTicketContent(ticket: Ticket): string {
  return wrapUntrusted(ticket.body, ticket.source).wrapped;
}
