import { describe, expect, it, vi } from "vitest";
import { buildExtractTask, runExtract } from "../src/extract";
import { emptySessionReviewState, shouldReview, unreviewedConversation } from "../src/review-state";

const { runHeadlessAgentMock } = vi.hoisted(() => ({ runHeadlessAgentMock: vi.fn().mockResolvedValue("No durable memories.") }));
vi.mock("../src/agent-runner", () => ({ runHeadlessAgent: runHeadlessAgentMock }));

const thresholds = { responseThreshold: 10, toolCallThreshold: 30, shutdownResponseThreshold: 4 };

describe("review cadence", () => {
  it("does not review before a threshold", () => {
    const state = { ...emptySessionReviewState(), responses: 9, toolCalls: 29 };
    expect(shouldReview(state, "responses", thresholds)).toBe(false);
    expect(shouldReview(state, "tools", thresholds)).toBe(false);
    expect(shouldReview({ ...state, responses: 3 }, "shutdown", thresholds)).toBe(false);
  });

  it("reviews at 10 responses", () => {
    expect(shouldReview({ ...emptySessionReviewState(), responses: 10 }, "responses", thresholds)).toBe(true);
  });

  it("reviews at 30 tool calls", () => {
    expect(shouldReview({ ...emptySessionReviewState(), toolCalls: 30 }, "tools", thresholds)).toBe(true);
  });

  it("compaction reviews any pending conversation", () => {
    expect(shouldReview({ ...emptySessionReviewState(), responses: 1 }, "compaction", thresholds)).toBe(true);
    expect(shouldReview(emptySessionReviewState(), "compaction", thresholds)).toBe(false);
  });

  it("shutdown reviews at four unreviewed responses", () => {
    expect(shouldReview({ ...emptySessionReviewState(), responses: 4 }, "shutdown", thresholds)).toBe(true);
  });

  it("does not review an already-reviewed conversation twice", () => {
    const branch = [
      { id: "u1", type: "message", message: { role: "user", content: "first" } },
      { id: "a1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
      { id: "u2", type: "message", message: { role: "user", content: "second" } },
      { id: "a2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "new answer" }] } },
    ];
    const first = unreviewedConversation(branch, "a1");
    expect(first.messages.map((message) => message.content)).toEqual(["second", "new answer"]);
    expect(first.checkpoint).toBe("a2");
    const second = unreviewedConversation(branch, first.checkpoint);
    expect(second.messages).toEqual([]);
    expect(second.checkpoint).toBe("a2");
  });

  it("does not re-review inherited entries in a forked session", () => {
    const inherited = [
      { id: "u1", type: "message", message: { role: "user", content: "old request" } },
      { id: "a1", type: "message", message: { role: "assistant", content: "old answer" } },
      { id: "u2", type: "message", message: { role: "user", content: "fork-only request" } },
    ];
    const result = unreviewedConversation(inherited, null, new Set(["u1", "a1"]));
    expect(result.messages.map((message) => message.content)).toEqual(["fork-only request"]);
    expect(result.entryIds).toEqual(["u2"]);
  });
});

describe("conservative adaptive extraction", () => {
  it("explicitly permits zero memories and caps extraction at five", () => {
    const task = buildExtractTask("/memory", [{ role: "user", content: "rename a local variable" }], 2000, 5);
    expect(task).toContain("between 0 and 5 memories");
    expect(task).toContain("Zero is expected and should be common");
    expect(task).toContain("routine edits");
  });

  it("requires inspecting the index and preferring an existing topic", () => {
    const task = buildExtractTask("/memory", [{ role: "assistant", content: "Grouped CV prevents leakage" }], 2000, 5);
    expect(task).toContain("Read MEMORY.md");
    expect(task).toContain("Prefer an existing topic");
    expect(task).toContain("Create a new descriptive stable topic only when no existing topic fits");
  });

  it("uses the isolated headless mechanism and may complete with no writes", async () => {
    runHeadlessAgentMock.mockClear();
    await runExtract({
      thinkLevel: "high",
      memoryDir: "/memory",
      messages: [{ role: "user", content: "routine request" }],
      maxContextTokens: 2000,
      maxMemories: 5,
      modelRegistry: {} as any,
      customTools: [],
    });
    expect(runHeadlessAgentMock).toHaveBeenCalledOnce();
    expect(runHeadlessAgentMock).toHaveBeenCalledWith(expect.objectContaining({ tools: ["read", "ls"], maxTurns: 8 }));
  });
});
