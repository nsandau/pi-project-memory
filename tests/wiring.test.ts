import { mkdir, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { base, runExtractMock } = vi.hoisted(() => ({
  base: `/tmp/pi-project-memory-wiring-${process.pid}`,
  runExtractMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/config", () => ({
  loadConfig: vi.fn().mockResolvedValue({
    enabled: true,
    memoryDir: base,
    memIndexMaxLines: 50,
    memIndexMaxBytes: 8192,
    search: { maxResults: 12, maxBytes: 16384 },
    dream: { nudgeAfterSessions: 5, nudgeAfterHours: 24, thinkLevel: "high" },
    sessionSearch: { maxSessions: 10, maxMatches: 5 },
    extractMemories: {
      enabled: true,
      thinkLevel: "high",
      maxContextTokens: 12000,
      maxMemories: 5,
      responseThreshold: 10,
      toolCallThreshold: 30,
      shutdownResponseThreshold: 4,
    },
  }),
}));
vi.mock("../src/paths", () => ({
  resolveMemoryDir: vi.fn().mockResolvedValue(base),
  safeTopicPath: vi.fn((dir: string, topic: string) => `${dir}/${topic}`),
}));
vi.mock("../src/extract", () => ({ runExtract: runExtractMock }));
vi.mock("../src/nudge", () => ({
  shouldNudge: vi.fn().mockResolvedValue({ nudge: false, message: "", sessions: 0, newEntries: 0 }),
  readDreamMeta: vi.fn().mockResolvedValue(null),
  writeDreamMeta: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/dream", () => ({ runDream: vi.fn().mockResolvedValue("done") }));
vi.mock("../src/session-search", () => ({ searchSessions: vi.fn().mockResolvedValue("none") }));

import memoryExtension from "../index";

function fakePi() {
  const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
  const tools: any[] = [];
  const commands: Record<string, any> = {};
  return {
    handlers, tools, commands,
    pi: {
      on(name: string, handler: any) { (handlers[name] ??= []).push(handler); },
      registerTool(tool: any) { tools.push(tool); },
      registerCommand(name: string, command: any) { commands[name] = command; },
    },
  };
}

function context(sessionId: string, branch: any[]) {
  return {
    cwd: "/project",
    hasUI: false,
    isProjectTrusted: () => true,
    modelRegistry: {},
    model: undefined,
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => branch,
    },
  };
}

async function start(sessionId: string, branch: any[]) {
  const runtime = fakePi();
  memoryExtension(runtime.pi as any);
  const ctx = context(sessionId, branch);
  await runtime.handlers.session_start[0]({}, ctx);
  return { ...runtime, ctx };
}

beforeEach(async () => {
  runExtractMock.mockClear();
  await rm(base, { recursive: true, force: true });
  await mkdir(base, { recursive: true });
  await writeFile(`${base}/MEMORY.md`, "- [Validation](validation.md) — grouped CV decisions\n");
});
afterEach(async () => rm(base, { recursive: true, force: true }));

const branch = [
  { id: "u1", type: "message", message: { role: "user", content: "Use grouped CV" } },
  { id: "a1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } },
];

describe("extension cadence wiring", () => {
  it("injects only the compact MEMORY.md snapshot and never auto-surfaces topics", async () => {
    const { handlers, ctx } = await start("inject", []);
    const result = await handlers.before_agent_start[0]({ systemPrompt: "BASE", prompt: "validation" }, ctx);
    expect(result.systemPrompt).toContain("# Project Memory Index");
    expect(result.systemPrompt).toContain("grouped CV decisions");
    expect(result.message).toBeUndefined();
  });

  it("runs extraction at 10 assistant responses", async () => {
    const runtime = await start("responses", branch);
    // New sessions reconstruct one existing assistant response; add nine more.
    for (let index = 0; index < 9; index++) await runtime.handlers.message_end[0]({ message: { role: "assistant" } }, runtime.ctx);
    await runtime.handlers.agent_end[0]({}, runtime.ctx);
    await vi.waitFor(() => expect(runExtractMock).toHaveBeenCalledTimes(1));
  });

  it("runs extraction at 30 tool calls", async () => {
    const runtime = await start("tools", []);
    for (let index = 0; index < 30; index++) await runtime.handlers.tool_execution_end[0]({}, runtime.ctx);
    // Add a branch entry before review is claimed.
    (runtime.ctx.sessionManager.getBranch as any) = () => branch;
    await runtime.handlers.agent_end[0]({}, runtime.ctx);
    await vi.waitFor(() => expect(runExtractMock).toHaveBeenCalledTimes(1));
  });

  it("compaction triggers pending extraction", async () => {
    const runtime = await start("compact", []);
    await runtime.handlers.message_end[0]({ message: { role: "assistant" } }, runtime.ctx);
    await runtime.handlers.session_before_compact[0]({ branchEntries: branch }, runtime.ctx);
    await vi.waitFor(() => expect(runExtractMock).toHaveBeenCalledTimes(1));
  });

  it("shutdown triggers extraction with four pending responses", async () => {
    const runtime = await start("shutdown", []);
    for (let index = 0; index < 4; index++) await runtime.handlers.message_end[0]({ message: { role: "assistant" } }, runtime.ctx);
    (runtime.ctx.sessionManager.getBranch as any) = () => branch;
    await runtime.handlers.session_shutdown[0]({ reason: "quit" }, runtime.ctx);
    expect(runExtractMock).toHaveBeenCalledTimes(1);
  });

  it("does not submit the same reviewed branch twice", async () => {
    const runtime = await start("once", branch);
    for (let index = 0; index < 9; index++) await runtime.handlers.message_end[0]({ message: { role: "assistant" } }, runtime.ctx);
    await runtime.handlers.agent_end[0]({}, runtime.ctx);
    await vi.waitFor(() => expect(runExtractMock).toHaveBeenCalledTimes(1));
    await runtime.handlers.agent_end[0]({}, runtime.ctx);
    expect(runExtractMock).toHaveBeenCalledTimes(1);
  });
});
