import * as path from "node:path";
import type { Command } from "commander";
import { logger } from "../../core/logging/index.js";
import {
  DEFAULT_CONFIG_FILENAME,
  loadConfig,
  type OswaldConfig,
} from "../../core/config/index.js";
import {
  createInitialState,
  stateFilePath,
  writeState,
} from "../../core/state/index.js";
import { ArtifactManager } from "../../core/artifacts/index.js";
import { pathExists } from "../../utils/fs.js";
import { systemClock } from "../../utils/time.js";
import {
  resolveAdapter,
  runtimeIds,
  type AdapterInstallOptions,
} from "../../runtimes/index.js";

async function loadOrDefaultConfig(
  cwd: string,
): Promise<{ config: OswaldConfig | null; configPath: string }> {
  const configPath = path.resolve(cwd, DEFAULT_CONFIG_FILENAME);
  if (await pathExists(configPath)) {
    return { config: await loadConfig(configPath), configPath };
  }
  return { config: null, configPath };
}

interface InitOptions {
  cwd: string;
  runtime?: string;
  force?: boolean;
  yes?: boolean;
  artifactDir?: string;
}

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Initialize Oswald in the current project (config + state + runtime templates)")
    .option("-C, --cwd <dir>", "project root", process.cwd())
    .option(
      "-r, --runtime <runtime>",
      `agent runtime to install templates for (${runtimeIds().join("|")})`,
      "generic",
    )
    .option("-f, --force", "overwrite existing files (state + runtime templates)")
    .option("-y, --yes", "assume yes for non-destructive prompts")
    .option("--artifact-dir <dir>", "artifact dir (overrides config)")
    .action(async (opts: InitOptions) => {
      const root = path.resolve(opts.cwd);
      const { config } = await loadOrDefaultConfig(root);

      const projectName = config?.project.name ?? path.basename(root);
      const artifactDir =
        opts.artifactDir ?? config?.paths.artifact_dir ?? ".oswald";

      const artifacts = new ArtifactManager(root, {
        artifactDir,
        clock: systemClock,
      });
      await artifacts.ensureArtifactDir();

      // 1) State (respects --force).
      const statePath = stateFilePath(root, artifactDir);
      const stateExists = await pathExists(statePath);
      if (stateExists && !opts.force) {
        logger.warn(`Oswald already initialized: ${statePath}`);
        logger.info("  (re-run with --force to reset state)");
      } else {
        const state = createInitialState({
          projectName,
          projectRoot: root,
          clock: systemClock,
        });
        const written = await writeState(state, artifactDir);
        logger.success(`Initialized Oswald for '${projectName}'`);
        logger.info(`  state:     ${written}`);
        logger.info(`  artifacts: ${artifacts.dir}`);
      }

      // 2) Runtime command templates (always rendered; respects --force).
      const { adapter, requested, fellBack } = resolveAdapter(opts.runtime);
      if (fellBack) {
        logger.warn(
          `Unknown runtime '${requested}' — falling back to '${adapter.id}'.`,
        );
      }
      const installOpts: AdapterInstallOptions = {
        root,
        artifactDir,
        ...(opts.force ? { force: true } : {}),
        projectName,
      };
      const result = await adapter.install(installOpts);
      logger.info(
        `  runtime:   ${adapter.displayName} (${result.written.length} written, ${result.skipped.length} skipped)`,
      );
      if (result.skipped.length > 0 && !opts.force) {
        logger.info("  (some runtime files existed; re-run with --force to overwrite)");
      }

      if (!config) {
        logger.info(
          `  tip:  copy oswald.yml.example to ${DEFAULT_CONFIG_FILENAME} to customize`,
        );
      }
      logger.info("  next:  oswald intake");
      process.exitCode = 0;
    });
}
