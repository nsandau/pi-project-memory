import { rename, unlink, writeFile } from "node:fs/promises";
import type { Model } from "@earendil-works/pi-ai";
import { withFileMutationQueue, type ModelRegistry, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runHeadlessAgent } from "./agent-runner";
import type { SessionPersistenceConfig, ThinkLevel } from "./config";
import { checkCapacity, parseIndex } from "./index-file";
import { safeTopicPath } from "./paths";

export function buildDreamTask(memoryDir: string, maxLines: number, maxBytes = 8 * 1024): string {
  return `You are a precision-focused memory consolidation agent. Work only in ${memoryDir}.

Orient:
- List the Markdown files, read MEMORY.md, then read every topic file.

Consolidate for precision, not accumulation:
- Merge duplicate or overlapping entries while preserving useful rationale and provenance.
- Remove obsolete or superseded knowledge.
- Resolve contradictions where evidence permits; otherwise preserve the uncertainty explicitly.
- Merge overlapping topic files and rename unclear topics.
- Delete empty topic files.
- Keep durable decisions, conventions, corrections, pitfalls, failed approaches and why, provenance, and reproducibility-critical details.
- Remove routine edits, temporary state, verbose summaries, rediscoverable facts, and speculation.

Regenerate MEMORY.md:
- Exactly one concise line per topic: - [Name](stable-filename.md) — what can be found there
- No detailed memories or per-entry list belongs in MEMORY.md.
- Keep it at most ${maxLines} topic lines and ${maxBytes} bytes.
- Keep topic fragmentation low.

Use memory_file_write, memory_file_rename, and memory_file_delete for mutations. They are restricted to this project memory directory. Do not use bash. When finished, report a concise change summary.`;
}

function dreamTools(memoryDir: string, maxLines: number, maxBytes: number): ToolDefinition[] {
  const resolveMarkdown = (filename: string, allowIndex = true) => {
    if (!filename.endsWith(".md")) throw new Error("Only Markdown files are allowed");
    if (!allowIndex && filename === "MEMORY.md") throw new Error("This operation is not allowed for MEMORY.md");
    return safeTopicPath(memoryDir, filename);
  };
  return [
    {
      name: "memory_file_write",
      label: "Memory File Write",
      description: "Rewrite one memory Markdown file inside this project namespace.",
      parameters: Type.Object({ filename: Type.String(), content: Type.String() }),
      async execute(_id, params: any) {
        const target = resolveMarkdown(params.filename);
        if (params.filename === "MEMORY.md") {
          const entries = parseIndex(params.content).entries;
          if (!checkCapacity(entries, maxLines, maxBytes) || entries.length !== params.content.trim().split("\n").filter(Boolean).length) {
            throw new Error("MEMORY.md must contain only valid one-line topic entries within capacity");
          }
        }
        await withFileMutationQueue(target, () => writeFile(target, `${params.content.trim()}\n`, "utf8"));
        return { details: {}, content: [{ type: "text", text: `Wrote ${params.filename}` }] };
      },
    },
    {
      name: "memory_file_rename",
      label: "Memory File Rename",
      description: "Rename a topic Markdown file within this project namespace.",
      parameters: Type.Object({ from: Type.String(), to: Type.String() }),
      async execute(_id, params: any) {
        const from = resolveMarkdown(params.from, false);
        const to = resolveMarkdown(params.to, false);
        await withFileMutationQueue(from, () => rename(from, to));
        return { details: {}, content: [{ type: "text", text: `Renamed ${params.from} to ${params.to}` }] };
      },
    },
    {
      name: "memory_file_delete",
      label: "Memory File Delete",
      description: "Delete an obsolete or empty topic Markdown file within this project namespace.",
      parameters: Type.Object({ filename: Type.String() }),
      async execute(_id, params: any) {
        const target = resolveMarkdown(params.filename, false);
        await withFileMutationQueue(target, () => unlink(target));
        return { details: {}, content: [{ type: "text", text: `Deleted ${params.filename}` }] };
      },
    },
  ];
}

export interface RunDreamOpts {
  model?: string;
  thinkLevel: ThinkLevel;
  memoryDir: string;
  maxLines: number;
  maxBytes: number;
  modelRegistry: ModelRegistry;
  parentModel?: Model<any>;
  sessionPersistence?: SessionPersistenceConfig;
}

export async function runDream(options: RunDreamOpts): Promise<string> {
  return runHeadlessAgent({
    task: buildDreamTask(options.memoryDir, options.maxLines, options.maxBytes),
    cwd: options.memoryDir,
    modelRegistry: options.modelRegistry,
    model: options.model,
    parentModel: options.parentModel,
    thinkLevel: options.thinkLevel,
    timeoutMs: 600_000,
    tools: ["read", "ls"],
    customTools: dreamTools(options.memoryDir, options.maxLines, options.maxBytes),
    sessionPersistence: options.sessionPersistence,
  });
}
