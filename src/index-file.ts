export interface IndexEntry {
  name: string;
  topic: string;
  hook: string;
  raw: string;
}

export interface IndexFile { entries: IndexEntry[]; raw: string }

const LINE_RE = /^-\s+\[([^\]]+)\]\(([^)]+)\)\s*—\s*(.*)$/;

export function parseIndex(content: string): IndexFile {
  const entries: IndexEntry[] = [];
  for (const line of content.split("\n")) {
    const match = line.match(LINE_RE);
    if (!match) continue;
    entries.push({ name: match[1].trim(), topic: match[2].trim(), hook: match[3].trim(), raw: line });
  }
  return { entries, raw: content };
}

export function serializeIndex(entries: IndexEntry[]): string {
  return entries.map((entry) => `- [${entry.name}](${entry.topic}) — ${entry.hook}`).join("\n");
}

export function upsertEntryByTopic(entries: IndexEntry[], entry: IndexEntry): IndexEntry[] {
  const index = entries.findIndex((candidate) => candidate.topic === entry.topic);
  if (index === -1) return [...entries, entry];
  const next = [...entries];
  next[index] = entry;
  return next;
}

export function removeEntryByTopic(entries: IndexEntry[], topic: string): IndexEntry[] {
  const index = entries.findIndex((entry) => entry.topic === topic);
  if (index === -1) throw new Error(`Topic "${topic}" not found in index`);
  return entries.filter((_, position) => position !== index);
}

export function findEntryByTopic(entries: IndexEntry[], topic: string): IndexEntry | null {
  return entries.find((entry) => entry.topic === topic) ?? null;
}

export function updateHook(entries: IndexEntry[], topic: string, hook: string): IndexEntry[] {
  const index = entries.findIndex((entry) => entry.topic === topic);
  if (index === -1) throw new Error(`Topic "${topic}" not found in index`);
  const next = [...entries];
  next[index] = { ...next[index], hook, raw: "" };
  return next;
}

export function truncateForInjection(content: string, maxLines: number, maxBytes: number): { ok: boolean; content: string; truncated: boolean } {
  const lines = content.replace(/\n+$/, "").split("\n").filter((line) => line.trim());
  const selected: string[] = [];
  let truncated = false;
  for (const line of lines) {
    if (selected.length >= maxLines) { truncated = true; break; }
    const candidate = [...selected, line].join("\n");
    if (Buffer.byteLength(candidate, "utf8") > maxBytes) { truncated = true; break; }
    selected.push(line);
  }
  if (selected.length < lines.length) truncated = true;
  const output = selected.join("\n");
  return { ok: !truncated, content: output, truncated };
}

export function checkCapacity(entries: IndexEntry[], maxLines: number, maxBytes: number): boolean {
  const serialized = serializeIndex(entries);
  return entries.length <= maxLines && Buffer.byteLength(serialized, "utf8") <= maxBytes;
}
