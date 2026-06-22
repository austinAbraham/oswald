/**
 * MCP provider skeleton — NOT YET WIRED.
 *
 * This is the documented seam for connecting Oswald to a real MCP server (dbt-mcp,
 * a Jira MCP, etc.). It deliberately does NOT depend on `@modelcontextprotocol/sdk`
 * yet: adding that dependency, the stdio/HTTP transport, and the tool-listing /
 * tool-calling plumbing is the follow-up task. Until then every method reports
 * "unavailable - no MCP server configured" so the rest of the system degrades
 * gracefully and `oswald doctor` shows the seam clearly.
 *
 * To wire it up later:
 *   1. add `@modelcontextprotocol/sdk` to dependencies,
 *   2. construct a Client + transport in `connect()` from `this.config`,
 *   3. implement `capabilities()` from `client.listTools()`,
 *   4. implement `invoke()` via `client.callTool({ name, arguments })`,
 *   5. map MCP tool names → ProviderKind and write-classification.
 */
import type { McpServerConfig } from "../../core/config/index.js";
import type {
  Capability,
  HealthReport,
  InvokeOptions,
  InvokeResult,
  ProviderKind,
  ToolProvider,
} from "../providers/types.js";

const UNAVAILABLE = "unavailable - no MCP server configured";

export interface McpProviderOptions {
  /** Logical name (e.g. "dbt-mcp"). */
  name: string;
  /** Which provider category this MCP server fulfills. */
  kind: ProviderKind;
  /** The MCP server config from `config.mcp_servers[name]`. */
  config?: McpServerConfig;
}

/**
 * A ToolProvider backed (eventually) by an MCP server. Currently a stub.
 */
export class McpToolProvider implements ToolProvider {
  readonly name: string;
  readonly kind: ProviderKind;
  private readonly config: McpServerConfig | undefined;
  private connected = false;

  constructor(options: McpProviderOptions) {
    this.name = options.name;
    this.kind = options.kind;
    this.config = options.config;
  }

  /** Whether a server config was provided at all. */
  get configured(): boolean {
    return this.config !== undefined;
  }

  capabilities(): Capability[] {
    // Until connected, we cannot enumerate the server's tools.
    return [];
  }

  async health(): Promise<HealthReport> {
    if (!this.config) {
      return { state: "unavailable", detail: UNAVAILABLE };
    }
    // Config present but transport not implemented yet.
    return {
      state: "unavailable",
      detail: `MCP transport not yet implemented (config present for '${this.name}'); ${UNAVAILABLE}`,
    };
  }

  /**
   * Placeholder for establishing the MCP connection. Throws to make the seam
   * obvious if something tries to use it prematurely.
   */
  async connect(): Promise<void> {
    throw new Error(
      `McpToolProvider.connect() not implemented — ${UNAVAILABLE}. See src/tools/mcp/provider.ts.`,
    );
  }

  async invoke(
    toolName: string,
    _args: Record<string, unknown>,
    _options?: InvokeOptions,
  ): Promise<InvokeResult> {
    void this.connected;
    return {
      ok: false,
      error: `MCP tool '${toolName}' on '${this.name}': ${UNAVAILABLE}`,
    };
  }
}

export const MCP_UNAVAILABLE_MESSAGE = UNAVAILABLE;
