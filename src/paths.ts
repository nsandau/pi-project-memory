import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { basename, join, normalize, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

async function gitToplevel(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 3000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function projectHash(cwd: string): Promise<string> {
  const identity = (await gitToplevel(cwd)) ?? resolve(cwd);
  return createHash("sha256").update(identity).digest("hex").slice(0, 12);
}

export async function resolveMemoryDir(config: { memoryDir: string }, cwd: string): Promise<string> {
  return join(config.memoryDir, await projectHash(cwd));
}

/** Resolve one flat topic filename and reject traversal, nested paths, and symlink targets. */
export function safeTopicPath(memoryDir: string, topic: string): string {
  const normalized = normalize(topic);
  if (
    !topic ||
    normalized.includes("..") ||
    normalized.startsWith(sep) ||
    topic.includes("/") ||
    topic.includes("\\") ||
    basename(normalized) !== normalized
  ) {
    throw new Error(`Unsafe topic path: ${topic}`);
  }
  const resolved = resolve(memoryDir, normalized);
  const root = resolve(memoryDir);
  if (!resolved.startsWith(`${root}${sep}`)) throw new Error(`Topic escapes memory dir: ${topic}`);
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
    throw new Error(`Unsafe symbolic-link topic: ${topic}`);
  }
  return resolved;
}
