import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const STATE_FILE = ".review-state.json";

export interface SessionReviewState {
  reviewedThrough: string | null;
  responses: number;
  toolCalls: number;
  updatedAt: string;
}

export interface ReviewStore {
  version: 1;
  sessions: Record<string, SessionReviewState>;
  /** Entry ids already claimed for review, shared across forks in this project. */
  reviewedEntries: string[];
}

export type ReviewTrigger = "responses" | "tools" | "compaction" | "shutdown";

export function emptySessionReviewState(): SessionReviewState {
  return { reviewedThrough: null, responses: 0, toolCalls: 0, updatedAt: new Date(0).toISOString() };
}

export async function readReviewStore(memoryDir: string): Promise<ReviewStore> {
  try {
    const parsed = JSON.parse(await readFile(join(memoryDir, STATE_FILE), "utf8"));
    if (parsed?.version === 1 && parsed.sessions && typeof parsed.sessions === "object") {
      return {
        version: 1,
        sessions: parsed.sessions,
        reviewedEntries: Array.isArray(parsed.reviewedEntries) ? parsed.reviewedEntries.filter((id: unknown) => typeof id === "string") : [],
      };
    }
  } catch {
    // Missing or malformed state starts clean.
  }
  return { version: 1, sessions: {}, reviewedEntries: [] };
}

export async function writeReviewStore(memoryDir: string, store: ReviewStore): Promise<void> {
  await mkdir(memoryDir, { recursive: true });
  const entries = Object.entries(store.sessions)
    .sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt))
    .slice(0, 100);
  const compact: ReviewStore = {
    version: 1,
    sessions: Object.fromEntries(entries),
    reviewedEntries: store.reviewedEntries.slice(-5_000),
  };
  const target = join(memoryDir, STATE_FILE);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(compact, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

export function shouldReview(
  state: SessionReviewState,
  trigger: ReviewTrigger,
  thresholds: { responseThreshold: number; toolCallThreshold: number; shutdownResponseThreshold: number },
): boolean {
  if (trigger === "compaction") return state.responses > 0 || state.toolCalls > 0;
  if (trigger === "shutdown") return state.responses >= thresholds.shutdownResponseThreshold;
  if (trigger === "responses") return state.responses >= thresholds.responseThreshold;
  return state.toolCalls >= thresholds.toolCallThreshold;
}

interface EntryLike {
  id?: string;
  type?: string;
  summary?: string;
  message?: { role?: string; content?: unknown; toolName?: string; isError?: boolean };
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: any) => {
      if (block?.type === "text") return block.text ?? "";
      if (block?.type === "toolCall") return `[tool call: ${block.name} ${JSON.stringify(block.arguments ?? {})}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function unreviewedConversation(
  branch: EntryLike[],
  reviewedThrough: string | null,
  alreadyReviewed: ReadonlySet<string> = new Set(),
): { messages: Array<{ role: string; content: string }>; checkpoint: string | null; entryIds: string[] } {
  let start = 0;
  if (reviewedThrough) {
    const index = branch.findIndex((entry) => entry.id === reviewedThrough);
    start = index >= 0 ? index + 1 : 0;
  }
  const selected = branch.slice(start);
  const messages: Array<{ role: string; content: string }> = [];
  const entryIds: string[] = [];
  for (const entry of selected) {
    if (entry.id && alreadyReviewed.has(entry.id)) continue;
    if (entry.type === "message" && entry.message?.role) {
      const text = textContent(entry.message.content);
      if (text) {
        messages.push({ role: entry.message.role, content: text });
        if (entry.id) entryIds.push(entry.id);
      }
    } else if (entry.type === "compaction" && entry.summary) {
      messages.push({ role: "compactionSummary", content: entry.summary });
      if (entry.id) entryIds.push(entry.id);
    }
  }
  return { messages, checkpoint: selected.at(-1)?.id ?? reviewedThrough, entryIds };
}
