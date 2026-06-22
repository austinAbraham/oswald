/**
 * Mock document provider — serves fixture documents / workbooks.
 *
 * All reads return untrusted external content; callers should wrap the body via
 * the ExternalContentSanitizer before feeding it to an agent.
 */
import type {
  Capability,
  DocumentContent,
  DocumentProvider,
  DocumentRef,
  HealthReport,
  InvokeOptions,
  InvokeResult,
  WorkbookContent,
} from "../types.js";

export interface MockDocumentOptions {
  documents?: Record<string, DocumentContent>;
  workbooks?: Record<string, WorkbookContent>;
}

export class MockDocumentProvider implements DocumentProvider {
  readonly name = "mock-document";
  readonly kind = "document" as const;

  private readonly documents: Record<string, DocumentContent>;
  private readonly workbooks: Record<string, WorkbookContent>;

  constructor(options: MockDocumentOptions = {}) {
    this.documents = options.documents ?? {};
    this.workbooks = options.workbooks ?? {};
  }

  capabilities(): Capability[] {
    return [
      { name: "search", write: false },
      { name: "fetchDocument", write: false },
      { name: "fetchWorkbook", write: false },
    ];
  }

  async health(): Promise<HealthReport> {
    return {
      state: "ok",
      detail: `${Object.keys(this.documents).length} doc(s), ${Object.keys(this.workbooks).length} workbook(s)`,
    };
  }

  async search(query: string): Promise<DocumentRef[]> {
    const q = query.toLowerCase();
    return Object.values(this.documents)
      .filter((d) => (d.title + d.body).toLowerCase().includes(q))
      .map((d) => ({ id: d.id, title: d.title, url: undefined, source: d.source }));
  }

  async fetchDocument(id: string): Promise<DocumentContent> {
    const doc = this.documents[id];
    if (!doc) throw new Error(`mock-document: document '${id}' not found`);
    return doc;
  }

  async fetchWorkbook(id: string): Promise<WorkbookContent> {
    const wb = this.workbooks[id];
    if (!wb) throw new Error(`mock-document: workbook '${id}' not found`);
    return wb;
  }

  async invoke(
    toolName: string,
    args: Record<string, unknown>,
    _options?: InvokeOptions,
  ): Promise<InvokeResult> {
    switch (toolName) {
      case "search":
        return { ok: true, data: await this.search(String(args.query)) };
      case "fetchDocument":
        return { ok: true, data: await this.fetchDocument(String(args.id)) };
      case "fetchWorkbook":
        return { ok: true, data: await this.fetchWorkbook(String(args.id)) };
      default:
        return { ok: false, error: `unknown document tool: ${toolName}` };
    }
  }
}
