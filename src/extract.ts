import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runHeadlessAgent } from "./agent-runner";
import type { SessionPersistenceConfig, ThinkLevel } from "./config";

export interface ExtractMessage { role: string; content: string }

export interface RunExtractOpts {
  model?: string;
  thinkLevel: ThinkLevel;
  memoryDir: string;
  messages: ExtractMessage[];
  maxContextTokens: number;
  maxMemories: number;
  modelRegistry: ModelRegistry;
  parentModel?: Model<any>;
  sessionPersistence?: SessionPersistenceConfig;
  customTools?: ToolDefinition[];
}

export function buildExtractTask(
  memoryDir: string,
  messages: ExtractMessage[],
  maxTokens: number,
  maxMemories = 5,
): string {
  const maxChars = Math.max(1_000, maxTokens * 4);
  const transcript = messages
    .map((message) => `[${message.role}]\n${message.content}`)
    .join("\n\n")
    .slice(-maxChars);

  return [
    `You are a conservative durable-memory reviewer. The project memory directory is ${memoryDir}.`,
    `Extract between 0 and ${maxMemories} memories from only the unreviewed conversation below. Zero is expected and should be common.`,
    "",
    "## Required workflow",
    "1. Read MEMORY.md. It must remain a tiny one-line-per-topic index, never a memory dump.",
    "2. Inspect likely existing topic files and use memory_search with related terms.",
    "3. Prefer an existing topic whenever it fits. Create a new descriptive stable topic only when no existing topic fits; keep fragmentation low.",
    "4. Use memory_add only for novel durable knowledge. Stop after the configured maximum. If nothing qualifies, make no writes.",
    "",
    "## Store only",
    "- decisions and their rationale",
    "- durable assumptions, methodological choices, and project conventions",
    "- important corrections, dataset/provenance quirks, and reproducibility-critical details",
    "- non-obvious implementation details, important bugs/pitfalls, and failed approaches with why they failed",
    "- durable findings, robustness observations, or references that materially affect future work",
    "",
    "## Never store",
    "- routine edits, temporary task state, verbose session summaries, or progress reports",
    "- easily rediscoverable code facts, speculative conclusions, or duplicate information",
    "- generic advice without project-specific future value",
    "",
    "Write one clear point per entry. Prefer what + why + context over a bare fact. Topic descriptions say what can be found there; they do not summarize every entry.",
    "Do not use bash, write, or edit. Use only read, ls, memory_search, and memory_add.",
    "",
    "=== Unreviewed conversation ===",
    transcript,
  ].join("\n");
}

/** Run extraction in an isolated headless session. Callers may await it or launch it in the background. */
export async function runExtract(options: RunExtractOpts): Promise<void> {
  if (options.messages.length === 0) return;
  await runHeadlessAgent({
    task: buildExtractTask(options.memoryDir, options.messages, options.maxContextTokens, options.maxMemories),
    cwd: options.memoryDir,
    modelRegistry: options.modelRegistry,
    model: options.model,
    parentModel: options.parentModel,
    thinkLevel: options.thinkLevel,
    maxTurns: 8,
    timeoutMs: 120_000,
    // Custom tools must be included in the allowlist as well as passed to
    // createAgentSession; otherwise the headless agent can inspect memory but
    // cannot call memory_add or memory_search.
    tools: ["read", "ls", "memory_search", "memory_add"],
    customTools: options.customTools ?? [],
    sessionPersistence: options.sessionPersistence,
  });
}
