import { promises as fs } from "node:fs";
import * as path from "node:path";

/** Ensure a directory exists (recursive). Returns the absolute path. */
export async function ensureDir(dir: string): Promise<string> {
  const abs = path.resolve(dir);
  await fs.mkdir(abs, { recursive: true });
  return abs;
}

/** Check whether a path exists. */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Read a UTF-8 text file. */
export async function readText(p: string): Promise<string> {
  return fs.readFile(p, "utf8");
}

/** Write a UTF-8 text file, creating parent directories as needed. */
export async function writeText(p: string, content: string): Promise<void> {
  await ensureDir(path.dirname(p));
  await fs.writeFile(p, content, "utf8");
}

/** Append text to a UTF-8 file, creating it (and parents) if missing. */
export async function appendText(p: string, content: string): Promise<void> {
  await ensureDir(path.dirname(p));
  await fs.appendFile(p, content, "utf8");
}
