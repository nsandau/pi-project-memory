import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doAdd, searchMemory } from "../src/memory-tool";
import { projectHash, resolveMemoryDir, safeTopicPath } from "../src/paths";

const dirs: string[] = [];
async function temp(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

const limits = { maxLines: 50, maxBytes: 8192 };

describe("project identity and isolation", () => {
  it("uses the Git root for project identity", async () => {
    const root = await temp("memory-git-");
    execFileSync("git", ["init", "-q"], { cwd: root });
    const nested = join(root, "a", "b");
    await mkdir(nested, { recursive: true });
    expect(await projectHash(root)).toBe(await projectHash(nested));
  });

  it("falls back to the absolute cwd outside Git", async () => {
    const root = await temp("memory-cwd-");
    const child = join(root, "child");
    await mkdir(child);
    expect(await projectHash(root)).not.toBe(await projectHash(child));
    expect(resolve(root)).toBe(root);
  });

  it("never returns project A memory from project B", async () => {
    const base = await temp("memory-base-");
    const projectA = await temp("memory-project-a-");
    const projectB = await temp("memory-project-b-");
    const dirA = await resolveMemoryDir({ memoryDir: base }, projectA);
    const dirB = await resolveMemoryDir({ memoryDir: base }, projectB);
    await doAdd(dirA, { ...limits, topic: "decisions.md", title: "A-only choice", content: "quasar-secret belongs only to A" });
    await doAdd(dirB, { ...limits, topic: "decisions.md", title: "B-only choice", content: "different project" });
    expect(await searchMemory(dirB, "quasar-secret")).toBe("No matches in memory.");
  });

  it("rejects topic path traversal", async () => {
    const dir = await temp("memory-safe-");
    expect(() => safeTopicPath(dir, "../outside.md")).toThrow(/unsafe|escapes/i);
  });
});

describe("ripgrep memory search", () => {
  let dir: string;
  beforeEach(async () => { dir = await temp("memory-search-"); });

  it("returns the complete matching entry block and not adjacent entries", async () => {
    await doAdd(dir, { ...limits, topic: "deployment.md", title: "Staging SSH", content: "Port 2222.\n\n### Rationale\nThe load balancer reserves port 22." });
    await doAdd(dir, { ...limits, topic: "deployment.md", title: "Production HTTPS", content: "Port 443." });
    const result = await searchMemory(dir, "load balancer");
    expect(result).toContain("## Staging SSH");
    expect(result).toContain("### Rationale");
    expect(result).toContain("reserves port 22");
    expect(result).not.toContain("Production HTTPS");
  });

  it("supports whitespace-separated terms and explicit regex OR", async () => {
    await doAdd(dir, { ...limits, topic: "api.md", title: "Authentication", content: "OAuth tokens expire after one hour." });
    await doAdd(dir, { ...limits, topic: "validation.md", title: "Grouped CV", content: "Group folds by patient." });
    const terms = await searchMemory(dir, "OAuth patient");
    expect(terms).toContain("Authentication");
    expect(terms).toContain("Grouped CV");
    const regex = await searchMemory(dir, "tokens|folds");
    expect(regex).toContain("Authentication");
    expect(regex).toContain("Grouped CV");
  });

  it("deduplicates entries hit on multiple lines", async () => {
    await doAdd(dir, { ...limits, topic: "bugs.md", title: "Cache pitfall", content: "cache line one\ncache line two" });
    const result = await searchMemory(dir, "cache");
    expect(result.match(/## Cache pitfall/g)).toHaveLength(1);
  });

  it("bounds result count and bytes without returning partial entries", async () => {
    for (let index = 0; index < 8; index++) {
      await doAdd(dir, { ...limits, topic: `topic-${index}.md`, title: `Match ${index}`, content: `bounded-key ${"x".repeat(120)}` });
    }
    const result = await searchMemory(dir, "bounded-key", { maxResults: 2, maxBytes: 1024 });
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(1024);
    expect(result.match(/^## Match/gm)?.length).toBeLessThanOrEqual(2);
    expect(result).toContain("omitted");
  });

  it("supports adaptive topic creation and keeps MEMORY.md as an index", async () => {
    await doAdd(dir, { ...limits, topic: "model-validation.md", topicDescription: "grouped CV, leakage controls, validation decisions", title: "Use grouped folds", content: "Group by patient to prevent leakage." });
    const index = await readFile(join(dir, "MEMORY.md"), "utf8");
    expect(index.trim().split("\n")).toHaveLength(1);
    expect(index).toContain("[Model Validation](model-validation.md)");
    expect(index).toContain("grouped CV, leakage controls, validation decisions");
    expect(index).not.toContain("Group by patient to prevent leakage");
  });

  it("adds to an existing topic without creating another topic or expanding its index summary", async () => {
    await doAdd(dir, { ...limits, topic: "api-design.md", topicDescription: "versioning and compatibility decisions", title: "Use URL versions", content: "CDN behavior requires /v1." });
    await doAdd(dir, { ...limits, topic: "api-design.md", title: "Keep old fields", content: "Clients need a deprecation window." });
    const index = await readFile(join(dir, "MEMORY.md"), "utf8");
    expect(index.trim().split("\n")).toHaveLength(1);
    expect(index).toContain("versioning and compatibility decisions");
    expect(index).not.toContain("Keep old fields");
    const topic = await readFile(join(dir, "api-design.md"), "utf8");
    expect(topic).toContain("## Use URL versions");
    expect(topic).toContain("## Keep old fields");
  });
});
