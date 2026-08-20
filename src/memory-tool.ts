import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, withFileMutationQueue, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  checkCapacity,
  findEntryByTopic,
  type IndexEntry,
  parseIndex,
  removeEntryByTopic,
  serializeIndex,
  updateHook,
  upsertEntryByTopic,
} from "./index-file";
import { safeTopicPath } from "./paths";
import {
  appendContent,
  buildFrontmatter,
  hasEntries,
  parseEntryBlocks,
  removeEntrySection,
  replaceFrontmatterField,
  updateFrontmatterDate,
} from "./topic-file";

const MEMORY_MD = "MEMORY.md";
const DEFAULT_SEARCH_RESULTS = 12;
const DEFAULT_SEARCH_BYTES = 16 * 1024;

export interface AddParams {
  content: string;
  topic: string;
  title: string;
  topicDescription?: string;
  /** Accepted for compatibility with @yandy0725/pi-memory; no fixed taxonomy is imposed. */
  type?: string;
  maxLines: number;
  maxBytes: number;
}

export interface RemoveParams { entry: string }
export interface ActionResult { ok: boolean; error?: string; entries?: IndexEntry[] }
export interface SearchOptions { maxResults?: number; maxBytes?: number }

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function cleanLine(value: string, max = 180): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function topicDisplayName(topic: string): string {
  return topic
    .replace(/\.md$/i, "")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

async function readIndex(memoryDir: string): Promise<IndexEntry[]> {
  try {
    return parseIndex(await readFile(join(memoryDir, MEMORY_MD), "utf8")).entries;
  } catch {
    return [];
  }
}

export async function doAdd(memoryDir: string, params: AddParams): Promise<ActionResult> {
  if (!params.title?.trim()) return { ok: false, error: "title is required" };
  if (!params.content?.trim()) return { ok: false, error: "content is required" };
  const topic = params.topic.endsWith(".md") ? params.topic : `${params.topic}.md`;
  let topicPath: string;
  try {
    topicPath = safeTopicPath(memoryDir, topic);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (topic === MEMORY_MD) return { ok: false, error: "MEMORY.md is an index, not a topic file" };

  return withFileMutationQueue(join(memoryDir, MEMORY_MD), async () => {
    await mkdir(dirname(topicPath), { recursive: true });
    const entries = await readIndex(memoryDir);
    const existing = findEntryByTopic(entries, topic);
    const title = cleanLine(params.title);
    const requestedDescription = cleanLine(params.topicDescription ?? "", 220);
    let next: IndexEntry[];

    if (!existing) {
      const name = topicDisplayName(topic);
      const description = requestedDescription || cleanLine(title, 140);
      next = upsertEntryByTopic(entries, { name, topic, hook: description, raw: "" });
      if (!checkCapacity(next, params.maxLines, params.maxBytes)) {
        return { ok: false, error: `MEMORY.md capacity exceeded (max ${params.maxLines} topic lines / ${params.maxBytes} bytes)` };
      }
      const frontmatter = buildFrontmatter({ name, description, updated: today() });
      await writeFile(topicPath, appendContent(frontmatter, title, params.content), "utf8");
    } else {
      const raw = await readFile(topicPath, "utf8").catch(() => "");
      if (!raw) return { ok: false, error: `Topic file "${topic}" is indexed but missing` };
      let topicContent = appendContent(updateFrontmatterDate(raw, today()), title, params.content);
      const hook = requestedDescription || existing.hook;
      if (requestedDescription) topicContent = replaceFrontmatterField(topicContent, "description", requestedDescription);
      next = updateHook(entries, topic, hook);
      if (!checkCapacity(next, params.maxLines, params.maxBytes)) {
        return { ok: false, error: `MEMORY.md capacity exceeded (max ${params.maxLines} topic lines / ${params.maxBytes} bytes)` };
      }
      await writeFile(topicPath, topicContent, "utf8");
    }

    await writeFile(join(memoryDir, MEMORY_MD), `${serializeIndex(next)}\n`, "utf8");
    return { ok: true, entries: next };
  });
}

export async function doRemove(memoryDir: string, params: RemoveParams): Promise<ActionResult> {
  return withFileMutationQueue(join(memoryDir, MEMORY_MD), async () => {
    const entries = await readIndex(memoryDir);
    const files = (await readdir(memoryDir).catch(() => [])).filter((file) => file.endsWith(".md") && file !== MEMORY_MD);
    const matches: string[] = [];
    for (const file of files) {
      let candidatePath: string;
      try {
        candidatePath = safeTopicPath(memoryDir, file);
      } catch {
        continue;
      }
      const raw = await readFile(candidatePath, "utf8").catch(() => "");
      if (parseEntryBlocks(raw).some((entry) => entry.title === params.entry)) matches.push(file);
    }
    if (matches.length === 0) return { ok: false, error: `Entry "${params.entry}" not found in any topic` };
    if (matches.length > 1) return { ok: false, error: `Multiple matches for entry "${params.entry}" in topics: ${matches.join(", ")}` };

    const topic = matches[0];
    const topicPath = safeTopicPath(memoryDir, topic);
    const raw = await readFile(topicPath, "utf8");
    const afterRemoval = removeEntrySection(raw, params.entry);
    if (hasEntries(afterRemoval)) {
      await writeFile(topicPath, updateFrontmatterDate(afterRemoval, today()), "utf8");
      await writeFile(join(memoryDir, MEMORY_MD), `${serializeIndex(entries)}\n`, "utf8");
    } else {
      const next = removeEntryByTopic(entries, topic);
      await unlink(topicPath);
      await writeFile(join(memoryDir, MEMORY_MD), `${serializeIndex(next)}\n`, "utf8");
    }
    return { ok: true };
  });
}

interface RgMatch { file: string; line: number }

/** Treat whitespace-separated expressions as regex OR terms; preserve explicit OR expressions. */
export function buildSearchPattern(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) throw new Error("query is required");
  if (trimmed.includes("|")) return trimmed;
  const terms = trimmed.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+/g) ?? [];
  return terms
    .map((term) => {
      const unquoted = ((term.startsWith('"') && term.endsWith('"')) || (term.startsWith("'") && term.endsWith("'")))
        ? term.slice(1, -1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        : term;
      return `(?:${unquoted})`;
    })
    .join("|");
}

export function resolvePiRgPath(): string {
  // Pi's public getAgentDir() lets extensions use the same managed bin
  // directory as Pi without importing its private tools-manager module.
  const managed = join(getAgentDir(), "bin", process.platform === "win32" ? "rg.exe" : "rg");
  if (existsSync(managed)) return managed;
  // Pi normally puts this directory on PATH. Keep the fallback for system
  // installs and older Pi versions that do not have a managed binary yet.
  return "rg";
}

function runRipgrep(memoryDir: string, pattern: string): Promise<RgMatch[]> {
  const args = ["--json", "--ignore-case", "--glob", "*.md", "--glob", "!MEMORY.md", "--", pattern, "."];
  return new Promise((resolve, reject) => {
    execFile(resolvePiRgPath(), args, { cwd: memoryDir, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const exitCode = (error as NodeJS.ErrnoException & { code?: number })?.code;
      if (error && exitCode !== 1) {
        reject(new Error(`ripgrep search failed: ${stderr.trim() || error.message}`));
        return;
      }
      const matches: RgMatch[] = [];
      for (const line of stdout.split(/\r?\n/)) {
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          if (event.type !== "match") continue;
          const file = String(event.data?.path?.text ?? "").replace(/^\.\//, "");
          const lineNumber = Number(event.data?.line_number ?? 0);
          if (file && lineNumber > 0) matches.push({ file, line: lineNumber });
        } catch {
          // Ignore malformed progress records, but keep valid matches.
        }
      }
      resolve(matches);
    });
  });
}

export async function searchMemory(memoryDir: string, query: string, options: SearchOptions = {}): Promise<string> {
  const maxResults = Math.max(1, Math.min(100, options.maxResults ?? DEFAULT_SEARCH_RESULTS));
  const maxBytes = Math.max(512, Math.min(50 * 1024, options.maxBytes ?? DEFAULT_SEARCH_BYTES));
  const rgMatches = await runRipgrep(memoryDir, buildSearchPattern(query));
  if (rgMatches.length === 0) return "No matches in memory.";

  const linesByFile = new Map<string, Set<number>>();
  for (const match of rgMatches) {
    if (match.file === MEMORY_MD || match.file.includes("..")) continue;
    const set = linesByFile.get(match.file) ?? new Set<number>();
    set.add(match.line);
    linesByFile.set(match.file, set);
  }

  const found: Array<{ key: string; text: string }> = [];
  for (const [file, lineNumbers] of linesByFile) {
    let topicPath: string;
    try {
      topicPath = safeTopicPath(memoryDir, file);
    } catch {
      continue;
    }
    const raw = await readFile(topicPath, "utf8").catch(() => "");
    for (const entry of parseEntryBlocks(raw)) {
      if (![...lineNumbers].some((line) => line >= entry.startLine && line <= entry.endLine)) continue;
      found.push({ key: `${file}\0${entry.title}\0${entry.content}`, text: `### ${relative(memoryDir, topicPath)}\n\n${entry.block}` });
    }
  }

  const unique = [...new Map(found.map((entry) => [entry.key, entry.text])).values()];
  const output: string[] = [];
  let bytes = 0;
  let omitted = 0;
  for (const entry of unique) {
    if (output.length >= maxResults) { omitted++; continue; }
    const addition = `${output.length ? "\n\n" : ""}${entry}`;
    const additionBytes = Buffer.byteLength(addition, "utf8");
    if (bytes + additionBytes > maxBytes) { omitted++; continue; }
    output.push(entry);
    bytes += additionBytes;
  }
  if (output.length === 0) return `Matches found, but complete entries exceed the ${maxBytes}-byte output limit.`;
  const result = output.join("\n\n");
  const notice = omitted > 0 ? `\n\n[${omitted} additional matching entr${omitted === 1 ? "y" : "ies"} omitted by limits.]` : "";
  return Buffer.byteLength(result + notice, "utf8") <= maxBytes ? result + notice : result;
}

interface MemoryToolConfig {
  memIndexMaxLines: number;
  memIndexMaxBytes: number;
  search: { maxResults: number; maxBytes: number };
  sessionSearch: { maxSessions: number; maxMatches: number };
}

export interface MemoryToolDeps {
  getMemoryDir: () => string | null;
  getConfig: () => MemoryToolConfig;
  getEnabled: () => boolean;
  searchSessions: (cwd: string, query: string, config: { maxSessions: number; maxMatches: number }) => Promise<string>;
  cwd: () => string;
}

export function createMemoryTools(memoryDir: string, config: { maxLines: number; maxBytes: number; searchMaxResults?: number; searchMaxBytes?: number }): ToolDefinition[] {
  return [
    {
      name: "memory_add",
      label: "Memory Add",
      description: "Add one durable memory to an existing topic when possible, or create a stable descriptive topic only when needed.",
      parameters: Type.Object({
        content: Type.String({ description: "Durable knowledge with what, why, and relevant context." }),
        topic: Type.String({ description: "Stable topic filename such as model-validation.md." }),
        title: Type.String({ description: "Concise, self-contained entry title." }),
        topicDescription: Type.Optional(Type.String({ description: "One-line description of what belongs in this topic. Required when creating a good new topic." })),
      }),
      async execute(_id, params: any) {
        const result = await doAdd(memoryDir, { ...params, maxLines: config.maxLines, maxBytes: config.maxBytes });
        if (!result.ok) throw new Error(result.error);
        return { details: {}, content: [{ type: "text", text: `Added "${params.title}" to ${params.topic}.` }] };
      },
    },
    {
      name: "memory_search",
      label: "Memory Search",
      description: "Search current-project topic Markdown with case-insensitive ripgrep regex/OR terms. Returns complete matching entry blocks with bounded output.",
      parameters: Type.Object({ query: Type.String({ description: "Regex OR expression or whitespace-separated terms." }) }),
      async execute(_id, params: any) {
        const text = await searchMemory(memoryDir, params.query, { maxResults: config.searchMaxResults, maxBytes: config.searchMaxBytes });
        return { details: {}, content: [{ type: "text", text }] };
      },
    },
  ];
}

export function createMemoryTool(deps: MemoryToolDeps) {
  return {
    name: "memory",
    label: "Memory",
    description: "Manage high-precision durable memory for only the current project. Add/remove entries, search topic files with ripgrep, or search Pi session history. MEMORY.md is only a compact topic index; detailed knowledge belongs in topic files.",
    promptSnippet: "Manage and search durable current-project memory (add/remove/search).",
    promptGuidelines: [
      "Use memory action='search' when historical project decisions, conventions, pitfalls, rationale, or corrections may matter; reformulate with synonyms or related identifiers if the first search misses.",
      "Before memory action='add', inspect MEMORY.md and search memory; prefer an existing topic and create a new stable topic only when none fits.",
      "Store only durable, non-obvious knowledge with what + why + context; do not store routine edits, temporary state, summaries, speculation, duplicates, or easily rediscoverable code facts.",
    ],
    parameters: Type.Object({
      action: StringEnum(["add", "remove", "search"] as const),
      content: Type.Optional(Type.String()),
      topic: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      topicDescription: Type.Optional(Type.String()),
      entry: Type.Optional(Type.String()),
      query: Type.Optional(Type.String()),
      scope: Type.Optional(StringEnum(["memory", "sessions"] as const)),
    }),
    renderCall(args: any, theme: any) {
      let text = theme.fg("toolTitle", theme.bold("memory ")) + theme.fg("muted", args.action);
      if (args.topic) text += ` ${theme.fg("accent", args.topic)}`;
      if (args.query) text += ` ${theme.fg("dim", `"${args.query}"`)}`;
      return new Text(text, 0, 0);
    },
    renderResult(result: any, _options: any, theme: any) {
      const block = result.content?.[0];
      const text = block?.type === "text" ? block.text : "";
      return new Text(theme.fg("success", "✓ ") + theme.fg("muted", text.split("\n")[0]), 0, 0);
    },
    async execute(_id: string, params: any) {
      if (!deps.getEnabled()) throw new Error("Memory is disabled (run /memory on)");
      const memoryDir = deps.getMemoryDir();
      if (!memoryDir) throw new Error("Memory not initialized");
      const config = deps.getConfig();
      if (params.action === "add") {
        if (!params.content || !params.topic || !params.title) throw new Error("content, topic, and title are required for add");
        const result = await doAdd(memoryDir, {
          content: params.content,
          topic: params.topic,
          title: params.title,
          topicDescription: params.topicDescription,
          maxLines: config.memIndexMaxLines,
          maxBytes: config.memIndexMaxBytes,
        });
        if (!result.ok) throw new Error(result.error);
        return { content: [{ type: "text", text: `Added "${params.title}" to ${params.topic}.` }], details: { entries: result.entries?.length } };
      }
      if (params.action === "remove") {
        if (!params.entry) throw new Error("entry is required for remove");
        const result = await doRemove(memoryDir, { entry: params.entry });
        if (!result.ok) throw new Error(result.error);
        return { content: [{ type: "text", text: `Removed entry "${params.entry}".` }], details: {} };
      }
      if (params.action === "search") {
        if (!params.query) throw new Error("query is required for search");
        const text = params.scope === "sessions"
          ? await deps.searchSessions(deps.cwd(), params.query, config.sessionSearch)
          : await searchMemory(memoryDir, params.query, config.search);
        return { content: [{ type: "text", text }], details: {} };
      }
      throw new Error(`Unknown action: ${params.action}`);
    },
  };
}
