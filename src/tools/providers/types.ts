/**
 * Typed tool-provider contracts.
 *
 * A `ToolProvider` is Oswald's abstraction over an external capability — a
 * ticket system, a warehouse, a git repo, a document store — whether it is
 * backed by a local mock, a direct API client, or an MCP server. The pipeline
 * code depends only on these interfaces, never on a concrete transport.
 */

/** Broad category of a provider, used for discovery + doctor reporting. */
export type ProviderKind = "ticket" | "warehouse" | "repo" | "document";

/** A capability a provider advertises (free-form but conventionally a verb). */
export interface Capability {
  /** Stable id, e.g. "getTicket", "executeReadOnlySql". */
  name: string;
  /** Whether invoking this capability has side effects (writes). */
  write: boolean;
  /** Short human description. */
  description?: string;
}

export type HealthState = "ok" | "degraded" | "unavailable";

export interface HealthReport {
  state: HealthState;
  /** Human-readable detail (e.g. why unavailable). */
  detail: string;
}

export interface InvokeOptions {
  /** Explicit human consent, threaded to the ApprovalService for writes. */
  yes?: boolean;
  /** Optional audit reason. */
  reason?: string;
}

export interface InvokeResult<T = unknown> {
  ok: boolean;
  /** Result payload on success. */
  data?: T;
  /** Error / denial detail on failure. */
  error?: string;
}

/**
 * Base provider contract. Concrete providers (ticket/warehouse/repo/document)
 * extend this with their typed methods, but all share discovery + health +
 * a generic `invoke` escape hatch (used by the MCP-backed providers and tests).
 */
export interface ToolProvider {
  /** Unique provider name, e.g. "mock-ticket", "jira". */
  readonly name: string;
  readonly kind: ProviderKind;
  /** Advertised capabilities. */
  capabilities(): Capability[];
  /** Best-effort health check. Never throws. */
  health(): Promise<HealthReport>;
  /** Generic dynamic invocation (mainly for MCP passthrough/tests). */
  invoke(
    toolName: string,
    args: Record<string, unknown>,
    options?: InvokeOptions,
  ): Promise<InvokeResult>;
}

// ---------------------------------------------------------------------------
// Domain data shapes
// ---------------------------------------------------------------------------

export interface Ticket {
  id: string;
  title: string;
  body: string;
  status?: string;
  url?: string;
  /** The source system (jira/confluence/clickup/mock/...) — sets trust origin. */
  source: string;
  labels?: string[];
}

export interface RelatedTicket {
  id: string;
  title: string;
  url?: string;
  score?: number;
}

export interface CommentDraft {
  ticketId: string;
  body: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable?: boolean;
  /** Marked true if the column name looks sensitive (set by EDA layer). */
  sensitive?: boolean;
}

export interface TableInfo {
  schema: string;
  name: string;
  columns: ColumnInfo[];
  rowCountEstimate?: number;
}

export interface QueryResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  /** True if results were truncated by a LIMIT cap. */
  truncated?: boolean;
}

export interface PullRequest {
  number?: number;
  url?: string;
  title: string;
  branch: string;
  base: string;
}

export interface DocumentRef {
  id: string;
  title: string;
  url?: string;
  source: string;
}

export interface DocumentContent {
  id: string;
  title: string;
  body: string;
  source: string;
}

export interface WorkbookContent {
  id: string;
  title: string;
  /** Sheet name → 2D cell grid (strings). */
  sheets: Record<string, string[][]>;
  source: string;
}

// ---------------------------------------------------------------------------
// Domain provider contracts
// ---------------------------------------------------------------------------

export interface TicketProvider extends ToolProvider {
  readonly kind: "ticket";
  getTicket(id: string): Promise<Ticket>;
  searchRelated(query: string): Promise<RelatedTicket[]>;
  /** Drafting is read-only: it returns text, it does NOT post. */
  draftComment(ticketId: string, body: string): Promise<CommentDraft>;
  /** Posting is a write — gated through ApprovalService. */
  postComment(
    draft: CommentDraft,
    options?: InvokeOptions,
  ): Promise<InvokeResult<{ posted: boolean }>>;
}

export interface WarehouseProvider extends ToolProvider {
  readonly kind: "warehouse";
  listSchemas(): Promise<string[]>;
  listTables(schema: string): Promise<TableInfo[]>;
  describeTable(schema: string, table: string): Promise<TableInfo>;
  /** Read-only SQL execution; the SQL is validated before it runs. */
  executeReadOnlySql(sql: string): Promise<InvokeResult<QueryResult>>;
  explainSql(sql: string): Promise<InvokeResult<{ plan: string }>>;
}

export interface RepoProvider extends ToolProvider {
  readonly kind: "repo";
  currentBranch(): Promise<string>;
  changedFiles(): Promise<string[]>;
  /** Write — gated. */
  createBranch(
    name: string,
    options?: InvokeOptions,
  ): Promise<InvokeResult<{ branch: string }>>;
  /** Write — gated. */
  commit(
    message: string,
    files: string[],
    options?: InvokeOptions,
  ): Promise<InvokeResult<{ committed: boolean }>>;
  /** Write — gated. */
  openPullRequest(
    pr: PullRequest,
    options?: InvokeOptions,
  ): Promise<InvokeResult<PullRequest>>;
}

export interface DocumentProvider extends ToolProvider {
  readonly kind: "document";
  search(query: string): Promise<DocumentRef[]>;
  fetchDocument(id: string): Promise<DocumentContent>;
  fetchWorkbook(id: string): Promise<WorkbookContent>;
}
