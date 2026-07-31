/**
 * Drift baseline acceptance — bless deliberate hand-edits.
 *
 * A `modified` drift finding means an artifact's on-disk content no longer
 * matches the baseline recorded when the pipeline wrote it. Re-running the
 * producing phase would regenerate the file and DISCARD the human edit, so
 * `oswald doctor --accept-drift` offers the other exit: re-hash the current
 * content into `state.artifact_hashes`, keeping the edit.
 *
 * The new `written_at` is the file's mtime (not "now"): downstream phases that
 * already re-ran after the edit stay `fresh`, while phases that last ran
 * before the edit are honestly flagged `stale` until re-run.
 *
 * Only artifacts that ALREADY have a baseline are touched — artifacts from
 * pre-tracking runs stay `unknown (no baseline)` (never blocking) until the
 * pipeline writes them again.
 */
import { promises as fs } from "node:fs";
import type { OswaldState } from "../state/index.js";
import { sha256Hex, type ArtifactManager } from "../artifacts/index.js";

export interface AcceptDriftResult {
  /** State with re-hashed baselines (a new object; caller persists it). */
  state: OswaldState;
  /** Artifact names whose baselines were re-hashed. */
  rebaselined: string[];
}

/**
 * Re-hash every baselined artifact whose on-disk content diverged from its
 * recorded baseline. Returns the updated state and what changed; writes
 * nothing itself.
 */
export async function acceptDriftBaselines(options: {
  state: OswaldState;
  artifacts: ArtifactManager;
}): Promise<AcceptDriftResult> {
  const { state, artifacts } = options;
  const hashes = { ...(state.artifact_hashes ?? {}) };
  const rebaselined: string[] = [];

  for (const [name, baseline] of Object.entries(hashes)) {
    if (!(await artifacts.exists(name))) continue;
    const sha256 = sha256Hex(await artifacts.read(name));
    if (sha256 === baseline.sha256) continue;
    const stat = await fs.stat(artifacts.resolve(name));
    hashes[name] = { sha256, written_at: stat.mtime.toISOString() };
    rebaselined.push(name);
  }

  return {
    state: { ...state, artifact_hashes: hashes },
    rebaselined,
  };
}
