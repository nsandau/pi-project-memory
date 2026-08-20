export interface TopicMeta {
  name: string;
  description: string;
  updated: string;
  /** Retained for compatibility with topic files created by the upstream extension. */
  type?: string;
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function buildFrontmatter(meta: TopicMeta): string {
  return [
    "---",
    `name: ${oneLine(meta.name)}`,
    `description: ${oneLine(meta.description)}`,
    ...(meta.type ? [`type: ${oneLine(meta.type)}`] : []),
    `updated: ${meta.updated}`,
    "---",
    "",
    "",
  ].join("\n");
}

export function parseFrontmatter(raw: string): TopicMeta | null {
  if (!raw.startsWith("---\n")) return null;
  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) return null;
  const fields: Record<string, string> = {};
  for (const line of raw.slice(4, end).split("\n")) {
    const match = line.match(/^(\w+):\s*(.*)$/);
    if (match) fields[match[1]] = match[2].trim();
  }
  if (!fields.name || !fields.description || !fields.updated) return null;
  return {
    name: fields.name,
    description: fields.description,
    updated: fields.updated,
    ...(fields.type ? { type: fields.type } : {}),
  };
}

export function appendContent(existing: string | null, entryTitle: string, content: string): string {
  const title = oneLine(entryTitle);
  const section = `## ${title}\n\n${content.trim()}`;
  if (!existing?.trim()) return `${section}\n`;
  return `${existing.trimEnd()}\n\n${section}\n`;
}

export function updateFrontmatterDate(raw: string, date: string): string {
  return raw.replace(/^(---\n(?:.*\n)*?)updated: .+(\n---)/m, `$1updated: ${date}$2`);
}

export function replaceFrontmatterField(raw: string, field: string, value: string): string {
  const regex = new RegExp(`^(---\\n(?:.*\\n)*?)${field}: .+(\\n)`, "m");
  return raw.replace(regex, (_full, prefix: string, newline: string) => `${prefix}${field}: ${oneLine(value)}${newline}`);
}

export function removeEntrySection(raw: string, title: string): string {
  const blocks = parseEntryBlocks(raw);
  const block = blocks.find((candidate) => candidate.title === title);
  if (!block) throw new Error(`Entry "${title}" not found`);
  const lines = raw.split("\n");
  lines.splice(block.startLine - 1, block.endLine - block.startLine + 1);
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

export function hasEntries(raw: string): boolean {
  return /^## /m.test(raw);
}

export interface ParsedEntry {
  title: string;
  content: string;
  block: string;
  startLine: number;
  endLine: number;
}

/** Parse complete H2 memory entry sections, including nested headings in their bodies. */
export function parseEntryBlocks(raw: string): ParsedEntry[] {
  const lines = raw.split("\n");
  const starts: Array<{ index: number; title: string }> = [];
  let inFrontmatter = false;
  for (let index = 0; index < lines.length; index++) {
    if (index === 0 && lines[index] === "---") {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (lines[index] === "---") inFrontmatter = false;
      continue;
    }
    const match = lines[index].match(/^##\s+(.+)$/);
    if (match) starts.push({ index, title: match[1].trim() });
  }

  return starts.map((start, position) => {
    const nextIndex = starts[position + 1]?.index ?? lines.length;
    let endIndex = nextIndex - 1;
    while (endIndex > start.index && lines[endIndex] === "") endIndex--;
    const blockLines = lines.slice(start.index, endIndex + 1);
    return {
      title: start.title,
      content: blockLines.slice(1).join("\n").trim(),
      block: blockLines.join("\n"),
      startLine: start.index + 1,
      endLine: endIndex + 1,
    };
  });
}

export function parseEntries(raw: string): ParsedEntry[] {
  return parseEntryBlocks(raw);
}
