import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { OswaldConfigSchema, type OswaldConfig } from "./schema.js";

export const DEFAULT_CONFIG_FILENAME = "oswald.yml";

/** Error thrown when configuration cannot be loaded or is invalid. */
export class ConfigError extends Error {
  constructor(
    message: string,
    readonly configPath: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  - ${where}: ${issue.message}`;
    })
    .join("\n");
}

/**
 * Parse + validate an already-loaded config object. Exposed for tests and for
 * callers that obtain YAML by other means.
 */
export function parseConfig(raw: unknown, configPath = DEFAULT_CONFIG_FILENAME): OswaldConfig {
  const result = OswaldConfigSchema.safeParse(raw ?? {});
  if (!result.success) {
    throw new ConfigError(
      `Invalid Oswald config at ${configPath}:\n${formatZodError(result.error)}`,
      configPath,
    );
  }
  return result.data;
}

/**
 * Load and validate `oswald.yml`.
 *
 * @param configPath Explicit path to the config file. Defaults to
 *   `./oswald.yml` relative to the current working directory.
 */
export async function loadConfig(
  configPath: string = DEFAULT_CONFIG_FILENAME,
): Promise<OswaldConfig> {
  const abs = path.resolve(configPath);

  let text: string;
  try {
    text = await fs.readFile(abs, "utf8");
  } catch {
    throw new ConfigError(
      `Config file not found: ${abs}\n` +
        `  Create one by copying oswald.yml.example to ${DEFAULT_CONFIG_FILENAME}.`,
      abs,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`Failed to parse YAML in ${abs}:\n  ${detail}`, abs);
  }

  return parseConfig(parsed, abs);
}
