import * as path from "node:path";
import { promises as fs } from "node:fs";
import { stringify as stringifyYaml } from "yaml";
import {
  ensureDir,
  pathExists,
  readText,
  writeText,
  appendText,
} from "../../utils/fs.js";
import { DEFAULT_ARTIFACT_DIR } from "../state/store.js";
import type { Clock } from "../../utils/time.js";

/** A structured document that can be rendered to Markdown. */
export interface StructuredDoc {
  title: string;
  /** Optional summary paragraph rendered under the title. */
  summary?: string;
  /** Ordered sections; each becomes an `##` heading with body text. */
  sections?: Array<{ heading: string; body: string }>;
}

export class ArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactError";
  }
}

/**
 * Manages reading/writing pipeline artifacts under a project's artifact dir.
 *
 * All paths resolve under `<root>/<artifactDir>`. Names are treated as relative
 * filenames; path traversal outside the artifact dir is rejected.
 */
export class ArtifactManager {
  readonly root: string;
  readonly artifactDir: string;
  private readonly clock: Clock | undefined;

  constructor(
    root: string,
    options: { artifactDir?: string; clock?: Clock } = {},
  ) {
    this.root = path.resolve(root);
    this.artifactDir = options.artifactDir ?? DEFAULT_ARTIFACT_DIR;
    this.clock = options.clock;
  }

  /** Absolute path to the artifact directory. */
  get dir(): string {
    return path.resolve(this.root, this.artifactDir);
  }

  /** Resolve (and guard) the absolute path for an artifact name. */
  resolve(name: string): string {
    const target = path.resolve(this.dir, name);
    const rel = path.relative(this.dir, target);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new ArtifactError(
        `Artifact name escapes artifact dir: ${name}`,
      );
    }
    return target;
  }

  /** Ensure the artifact directory exists. Returns its absolute path. */
  async ensureArtifactDir(): Promise<string> {
    return ensureDir(this.dir);
  }

  /** Whether an artifact exists. */
  async exists(name: string): Promise<boolean> {
    return pathExists(this.resolve(name));
  }

  /** Read an artifact's text content. */
  async read(name: string): Promise<string> {
    const p = this.resolve(name);
    if (!(await pathExists(p))) {
      throw new ArtifactError(`Artifact not found: ${name}`);
    }
    return readText(p);
  }

  /** Write (overwrite) an artifact. */
  async write(name: string, content: string): Promise<string> {
    const p = this.resolve(name);
    await writeText(p, content);
    return p;
  }

  /** Append text to an artifact (creating it if missing). */
  async append(name: string, text: string): Promise<string> {
    const p = this.resolve(name);
    await appendText(p, text);
    return p;
  }

  /**
   * Archive an artifact by moving it to `archive/<timestamp>-<name>`.
   * Requires a clock (constructor or argument) to name the archived copy.
   * Returns the archived path, or null if the artifact did not exist.
   */
  async archive(name: string, clock?: Clock): Promise<string | null> {
    const src = this.resolve(name);
    if (!(await pathExists(src))) {
      return null;
    }
    const usedClock = clock ?? this.clock;
    if (!usedClock) {
      throw new ArtifactError(
        "archive() requires a clock (pass one to the constructor or this call)",
      );
    }
    const stamp = usedClock.nowIso().replace(/[:.]/g, "-");
    const base = path.basename(name);
    const dest = this.resolve(path.join("archive", `${stamp}-${base}`));
    await ensureDir(path.dirname(dest));
    await fs.rename(src, dest);
    return dest;
  }

  /** Render a structured document to Markdown text. */
  renderMarkdown(doc: StructuredDoc): string {
    const parts: string[] = [`# ${doc.title}`];
    if (doc.summary) {
      parts.push("", doc.summary);
    }
    for (const section of doc.sections ?? []) {
      parts.push("", `## ${section.heading}`, "", section.body);
    }
    return parts.join("\n") + "\n";
  }

  /** Render an object to safe YAML text. */
  renderYaml(obj: unknown): string {
    return stringifyYaml(obj);
  }
}
