import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { loadConfig, type MemoryConfig, type SessionPersistenceConfig } from "./src/config";
import { runDream } from "./src/dream";
import { runExtract } from "./src/extract";
import { buildInjection, loadIndexSnapshot } from "./src/inject";
import { createMemoryTool, createMemoryTools } from "./src/memory-tool";
import { readDreamMeta, shouldNudge, writeDreamMeta } from "./src/nudge";
import { resolveMemoryDir } from "./src/paths";
import {
  emptySessionReviewState,
  readReviewStore,
  shouldReview,
  type ReviewStore,
  type ReviewTrigger,
  type SessionReviewState,
  unreviewedConversation,
  writeReviewStore,
} from "./src/review-state";
import { searchSessions } from "./src/session-search";

function resolveTaskDefault(
  config: MemoryConfig,
  task: "dream" | "extractMemories",
  key: "model" | "sessionPersistence",
): string | SessionPersistenceConfig | undefined {
  const taskValue = config[task][key] as string | SessionPersistenceConfig | undefined;
  return taskValue ?? config.defaults?.[key];
}

function countBranch(branch: any[]): { responses: number; toolCalls: number } {
  let responses = 0;
  let toolCalls = 0;
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    if (entry.message?.role === "assistant") {
      responses++;
      if (Array.isArray(entry.message.content)) {
        toolCalls += entry.message.content.filter((block: any) => block?.type === "toolCall").length;
      }
    }
  }
  return { responses, toolCalls };
}

export default function memoryExtension(pi: ExtensionAPI) {
  let memoryDir: string | null = null;
  let config: MemoryConfig | null = null;
  let indexSnapshot = "";
  let toolRegistered = false;
  let sessionId = "";
  let reviewStore: ReviewStore = { version: 1, sessions: {}, reviewedEntries: [] };
  let reviewState: SessionReviewState = emptySessionReviewState();
  let persistChain: Promise<void> = Promise.resolve();
  let extractionInFlight: Promise<void> | null = null;
  let pendingTrigger: ReviewTrigger | null = null;
  let shuttingDown = false;

  const queuePersist = () => {
    if (!memoryDir || !sessionId) return persistChain;
    reviewState.updatedAt = new Date().toISOString();
    reviewStore.sessions[sessionId] = { ...reviewState };
    const dir = memoryDir;
    persistChain = persistChain.then(() => writeReviewStore(dir, reviewStore)).catch(() => {});
    return persistChain;
  };

  const extractionOptions = (ctx: ExtensionContext, messages: Array<{ role: string; content: string }>) => {
    if (!config || !memoryDir) throw new Error("Memory not initialized");
    return {
      model: resolveTaskDefault(config, "extractMemories", "model") as string | undefined,
      thinkLevel: config.extractMemories.thinkLevel,
      memoryDir,
      messages,
      maxContextTokens: config.extractMemories.maxContextTokens,
      maxMemories: config.extractMemories.maxMemories,
      modelRegistry: ctx.modelRegistry,
      parentModel: ctx.model,
      customTools: createMemoryTools(memoryDir, {
        maxLines: config.memIndexMaxLines,
        maxBytes: config.memIndexMaxBytes,
        searchMaxResults: config.search.maxResults,
        searchMaxBytes: config.search.maxBytes,
      }),
      sessionPersistence: resolveTaskDefault(config, "extractMemories", "sessionPersistence") as SessionPersistenceConfig | undefined,
    };
  };

  const triggerExtraction = async (trigger: ReviewTrigger, ctx: ExtensionContext, branchOverride?: any[]): Promise<void> => {
    if (!config?.enabled || !config.extractMemories.enabled || !memoryDir) return;
    if (!shouldReview(reviewState, trigger, config.extractMemories)) return;
    if (extractionInFlight) {
      pendingTrigger = trigger;
      return;
    }

    const branch = branchOverride ?? ctx.sessionManager.getBranch();
    const { messages, checkpoint, entryIds } = unreviewedConversation(
      branch as any[],
      reviewState.reviewedThrough,
      new Set(reviewStore.reviewedEntries),
    );
    if (messages.length === 0 || checkpoint === reviewState.reviewedThrough) {
      reviewState.responses = 0;
      reviewState.toolCalls = 0;
      await queuePersist();
      return;
    }

    // Claim this exact conversation slice synchronously before any await so
    // concurrent lifecycle events cannot submit the same slice twice.
    reviewState.reviewedThrough = checkpoint;
    reviewState.responses = 0;
    reviewState.toolCalls = 0;
    reviewStore.reviewedEntries.push(...entryIds);
    reviewStore.reviewedEntries = [...new Set(reviewStore.reviewedEntries)].slice(-5_000);
    const options = extractionOptions(ctx, messages);
    extractionInFlight = (async () => {
      await queuePersist();
      await runExtract(options);
    })()
      .catch(() => {})
      .finally(async () => {
        extractionInFlight = null;
        if (!shuttingDown && pendingTrigger) {
          const next = pendingTrigger;
          pendingTrigger = null;
          await triggerExtraction(next, ctx);
        }
      });
    if (trigger === "shutdown") await extractionInFlight;
  };

  pi.on("session_start", async (_event, ctx) => {
    shuttingDown = false;
    pendingTrigger = null;
    config = await loadConfig(ctx);
    memoryDir = await resolveMemoryDir(config, ctx.cwd);
    await mkdir(memoryDir, { recursive: true });
    indexSnapshot = await loadIndexSnapshot(memoryDir, config.memIndexMaxLines, config.memIndexMaxBytes);
    sessionId = ctx.sessionManager.getSessionId();
    reviewStore = await readReviewStore(memoryDir);
    const stored = reviewStore.sessions[sessionId];
    if (stored) {
      reviewState = { ...stored };
    } else {
      const counts = countBranch(ctx.sessionManager.getBranch() as any[]);
      reviewState = { reviewedThrough: null, ...counts, updatedAt: new Date().toISOString() };
      await queuePersist();
    }

    if (!toolRegistered) {
      pi.registerTool(createMemoryTool({
        getMemoryDir: () => memoryDir,
        getConfig: () => {
          if (!config) throw new Error("Memory not initialized");
          return config;
        },
        getEnabled: () => config?.enabled ?? false,
        searchSessions,
        cwd: () => ctx.cwd,
      }) as any);
      toolRegistered = true;
    }

    if (config.enabled && ctx.hasUI) {
      const status = await shouldNudge(memoryDir, config, ctx.cwd);
      if (status.nudge && await ctx.ui.confirm("Memory Consolidation", `${status.message}\n\nConsolidate memory files now?`)) {
        ctx.ui.setStatus("dream", "Consolidating memory…");
        void runDream({
          model: resolveTaskDefault(config, "dream", "model") as string | undefined,
          thinkLevel: config.dream.thinkLevel,
          memoryDir,
          maxLines: config.memIndexMaxLines,
          maxBytes: config.memIndexMaxBytes,
          modelRegistry: ctx.modelRegistry,
          parentModel: ctx.model,
          sessionPersistence: resolveTaskDefault(config, "dream", "sessionPersistence") as SessionPersistenceConfig | undefined,
        }).then(async (summary) => {
          await writeDreamMeta(memoryDir!, status.sessions);
          ctx.ui.notify(summary, "info");
        }).catch((error) => ctx.ui.notify(`Dream failed: ${error instanceof Error ? error.message : String(error)}`, "error"))
          .finally(() => ctx.ui.setStatus("dream", undefined));
      }
    }
  });

  pi.on("before_agent_start", (event) => {
    if (!config?.enabled || !indexSnapshot) return;
    return { systemPrompt: buildInjection(event.systemPrompt, indexSnapshot) };
  });

  pi.on("message_end", async (event) => {
    if (!config?.enabled || event.message.role !== "assistant") return;
    reviewState.responses++;
    await queuePersist();
  });

  pi.on("tool_execution_end", async () => {
    if (!config?.enabled) return;
    reviewState.toolCalls++;
    await queuePersist();
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!config?.enabled) return;
    if (shouldReview(reviewState, "responses", config.extractMemories)) {
      void triggerExtraction("responses", ctx);
    } else if (shouldReview(reviewState, "tools", config.extractMemories)) {
      void triggerExtraction("tools", ctx);
    }
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (!config?.enabled) return;
    void triggerExtraction("compaction", ctx, event.branchEntries as any[]);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    shuttingDown = true;
    if (extractionInFlight) await extractionInFlight;
    if (config?.enabled && shouldReview(reviewState, "shutdown", config.extractMemories)) {
      await triggerExtraction("shutdown", ctx);
    }
    await queuePersist();
  });

  pi.registerCommand("memory", {
    description: "Show project memory status or toggle it for this runtime",
    handler: async (args, ctx) => {
      if (!config || !memoryDir) {
        ctx.ui.notify("Memory not initialized.", "info");
        return;
      }
      if (args === "off" || args === "on") {
        config = { ...config, enabled: args === "on" };
        ctx.ui.notify(`Memory ${args}`, "info");
        return;
      }
      const files = (await readdir(memoryDir).catch(() => [])).filter((file) => file.endsWith(".md"));
      const index = await readFile(join(memoryDir, "MEMORY.md"), "utf8").catch(() => "");
      const meta = await readDreamMeta(memoryDir);
      ctx.ui.notify([
        `Memory: ${config.enabled ? "enabled" : "disabled"}`,
        `Dir: ${memoryDir}`,
        `Index: ${index.split("\n").filter((line) => line.trim()).length}/${config.memIndexMaxLines} topic lines`,
        `Topics: ${files.filter((file) => file !== "MEMORY.md").join(", ") || "none"}`,
        `Unreviewed: ${reviewState.responses} responses, ${reviewState.toolCalls} tool calls`,
        `Last dream: ${meta?.lastDreamAt ?? "never"}`,
      ].join("\n"), "info");
    },
  });

  pi.registerCommand("dream", {
    description: "Consolidate project memory for precision",
    handler: async (_args, ctx) => {
      if (!config || !memoryDir) {
        ctx.ui.notify("Memory not initialized.", "info");
        return;
      }
      if (!await ctx.ui.confirm("Dream", "Consolidate and rewrite this project's memory files?")) return;
      ctx.ui.setStatus("dream", "Consolidating memory…");
      const currentConfig = config;
      const currentDir = memoryDir;
      void runDream({
        model: resolveTaskDefault(currentConfig, "dream", "model") as string | undefined,
        thinkLevel: currentConfig.dream.thinkLevel,
        memoryDir: currentDir,
        maxLines: currentConfig.memIndexMaxLines,
        maxBytes: currentConfig.memIndexMaxBytes,
        modelRegistry: ctx.modelRegistry,
        parentModel: ctx.model,
        sessionPersistence: resolveTaskDefault(currentConfig, "dream", "sessionPersistence") as SessionPersistenceConfig | undefined,
      }).then(async (summary) => {
        await writeDreamMeta(currentDir, (await SessionManager.list(ctx.cwd)).length);
        ctx.ui.notify(summary, "info");
      }).catch((error) => ctx.ui.notify(`Dream failed: ${error instanceof Error ? error.message : String(error)}`, "error"))
        .finally(() => ctx.ui.setStatus("dream", undefined));
    },
  });
}
