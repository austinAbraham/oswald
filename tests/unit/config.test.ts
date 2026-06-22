import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, parseConfig, ConfigError } from "../../src/core/config/index.js";

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oswald-cfg-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("config: parseConfig", () => {
  it("applies defaults for a minimal config", () => {
    const config = parseConfig({ project: { name: "demo" } });
    expect(config.project.name).toBe("demo");
    expect(config.project.default_repo_provider).toBe("github");
    expect(config.paths.artifact_dir).toBe(".oswald");
    expect(config.standards.modeling_tool).toBe("dbt");
    expect(config.policies.warehouse.read_only_by_default).toBe(true);
    expect(config.policies.warehouse.max_sample_rows).toBe(100);
    expect(config.policies.privacy.pii_allowed_in_artifacts).toBe(false);
    expect(config.mcp_servers).toEqual({});
  });

  it("rejects a config missing project.name", () => {
    expect(() => parseConfig({ project: {} })).toThrow(ConfigError);
  });

  it("rejects an empty project.name", () => {
    expect(() => parseConfig({ project: { name: "" } })).toThrow(/project\.name/);
  });

  it("preserves mcp_servers and overridden values", () => {
    const config = parseConfig({
      project: { name: "demo", default_warehouse: "bigquery" },
      policies: { warehouse: { max_sample_rows: 50 } },
      mcp_servers: { dbt: { transport: "stdio", command: "uvx", args: ["dbt-mcp"] } },
    });
    expect(config.project.default_warehouse).toBe("bigquery");
    expect(config.policies.warehouse.max_sample_rows).toBe(50);
    expect(config.mcp_servers.dbt.command).toBe("uvx");
  });
});

describe("config: loadConfig", () => {
  it("loads a valid YAML file from disk", async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, "oswald.yml");
    await fs.writeFile(
      file,
      "project:\n  name: from-disk\n  default_warehouse: snowflake\n",
      "utf8",
    );
    const config = await loadConfig(file);
    expect(config.project.name).toBe("from-disk");
    expect(config.project.default_warehouse).toBe("snowflake");
  });

  it("throws a clear error when the file is missing", async () => {
    const dir = await makeTmpDir();
    await expect(loadConfig(path.join(dir, "nope.yml"))).rejects.toThrow(
      /Config file not found/,
    );
  });

  it("throws on invalid YAML content", async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, "oswald.yml");
    await fs.writeFile(file, "project: : : bad", "utf8");
    await expect(loadConfig(file)).rejects.toThrow(ConfigError);
  });

  it("throws on schema-invalid content (missing name)", async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, "oswald.yml");
    await fs.writeFile(file, "project:\n  default_warehouse: snowflake\n", "utf8");
    await expect(loadConfig(file)).rejects.toThrow(/project\.name/);
  });
});
