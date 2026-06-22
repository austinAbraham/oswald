/**
 * Config resolution for the CLI.
 *
 * Oswald is usable with ZERO config: `oswald init` does not require an
 * `oswald.yml`, so the pipeline commands must not hard-fail when one is absent.
 * This helper loads `<root>/oswald.yml` when it exists, and otherwise returns a
 * fully-defaulted config derived from the project directory name (the same
 * default story `init` uses). All Pydantic-style defaults in the schema fill in
 * the rest, so policy/paths/standards are always populated.
 */
import * as path from "node:path";
import {
  loadConfig,
  parseConfig,
  DEFAULT_CONFIG_FILENAME,
  type OswaldConfig,
} from "../../core/config/index.js";
import { pathExists } from "../../utils/fs.js";

/** Resolve the active config for a project root (file → defaults fallback). */
export async function resolveConfig(cwd: string): Promise<OswaldConfig> {
  const configPath = path.resolve(cwd, DEFAULT_CONFIG_FILENAME);
  if (await pathExists(configPath)) {
    return loadConfig(configPath);
  }
  return parseConfig({ project: { name: path.basename(path.resolve(cwd)) } });
}
