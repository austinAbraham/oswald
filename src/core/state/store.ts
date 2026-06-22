import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import {
  OswaldStateSchema,
  STATE_VERSION,
  type OswaldState,
} from "./schema.js";
import {
  ensureDir,
  pathExists,
  readText,
  writeText,
} from "../../utils/fs.js";
import type { Clock } from "../../utils/time.js";

export const STATE_FILENAME = "state.yml";
export const DEFAULT_ARTIFACT_DIR = ".oswald";

/** Error thrown when state cannot be read or is invalid. */
export class StateError extends Error {
  constructor(
    message: string,
    readonly statePath: string,
  ) {
    super(message);
    this.name = "StateError";
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

/** Resolve the absolute path to the state file under a project root. */
export function stateFilePath(
  projectRoot: string,
  artifactDir: string = DEFAULT_ARTIFACT_DIR,
): string {
  return path.resolve(projectRoot, artifactDir, STATE_FILENAME);
}

/** Validate an arbitrary object into a typed state. */
export function parseState(
  raw: unknown,
  statePath = STATE_FILENAME,
): OswaldState {
  const result = OswaldStateSchema.safeParse(raw);
  if (!result.success) {
    throw new StateError(
      `Invalid Oswald state at ${statePath}:\n${formatZodError(result.error)}`,
      statePath,
    );
  }
  return result.data;
}

export interface CreateInitialStateOptions {
  projectName: string;
  projectRoot: string;
  clock: Clock;
  ticket?: Partial<OswaldState["ticket"]>;
}

/** Build a fresh state object for a newly-initialized project. */
export function createInitialState(
  options: CreateInitialStateOptions,
): OswaldState {
  const now = options.clock.nowIso();
  return OswaldStateSchema.parse({
    version: STATE_VERSION,
    project: { name: options.projectName, root: options.projectRoot },
    ticket: {
      id: options.ticket?.id ?? null,
      provider: options.ticket?.provider ?? null,
      url: options.ticket?.url ?? null,
    },
    status: {
      phase: "uninitialized",
      last_command: null,
      next_recommended_command: "init",
      blockers: [],
    },
    requirements: {},
    tools: {},
    policy: {},
    artifacts: {},
    timestamps: { created_at: now, updated_at: now },
  });
}

/** Read and validate state from disk. */
export async function readState(
  projectRoot: string,
  artifactDir: string = DEFAULT_ARTIFACT_DIR,
): Promise<OswaldState> {
  const p = stateFilePath(projectRoot, artifactDir);
  if (!(await pathExists(p))) {
    throw new StateError(
      `No Oswald state found at ${p}. Run \`oswald init\` first.`,
      p,
    );
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(await readText(p));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new StateError(`Failed to parse state YAML at ${p}:\n  ${detail}`, p);
  }
  return parseState(parsed, p);
}

/**
 * Write state to disk. The caller is responsible for setting timestamps; this
 * function does NOT stamp time so that it stays deterministic.
 */
export async function writeState(
  state: OswaldState,
  artifactDir: string = DEFAULT_ARTIFACT_DIR,
): Promise<string> {
  const validated = OswaldStateSchema.parse(state);
  const p = stateFilePath(validated.project.root, artifactDir);
  await ensureDir(path.dirname(p));
  await writeText(p, stringifyYaml(validated));
  return p;
}

/**
 * Read → mutate → write helper. The mutator receives the current state and
 * returns the next state (or mutates in place and returns it). The caller
 * supplies a clock; `timestamps.updated_at` is stamped from it.
 */
export async function updateState(
  projectRoot: string,
  mutator: (state: OswaldState) => OswaldState,
  options: { clock: Clock; artifactDir?: string },
): Promise<OswaldState> {
  const artifactDir = options.artifactDir ?? DEFAULT_ARTIFACT_DIR;
  const current = await readState(projectRoot, artifactDir);
  const next = mutator(current);
  next.timestamps.updated_at = options.clock.nowIso();
  const validated = OswaldStateSchema.parse(next);
  await writeState(validated, artifactDir);
  return validated;
}
