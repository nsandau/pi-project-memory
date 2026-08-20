import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { truncateForInjection } from "./index-file";

/** Load the compact topic index once at session start. Detailed topic files are never auto-surfaced. */
export async function loadIndexSnapshot(memoryDir: string, maxLines: number, maxBytes: number): Promise<string> {
  try {
    const raw = await readFile(join(memoryDir, "MEMORY.md"), "utf8");
    const { content } = truncateForInjection(raw, maxLines, maxBytes);
    return content.trim() ? `# Project Memory Index\n${content.trim()}` : "";
  } catch {
    return "";
  }
}

export function buildInjection(systemPrompt: string, snapshot: string): string {
  if (!snapshot) return systemPrompt;
  return `${systemPrompt}\n\n${snapshot}\n\nDetailed memory is not auto-loaded. Use the memory search action when historical context may matter.`;
}
