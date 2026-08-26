import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export type ThinkLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface SessionPersistenceConfig {
  enabled: boolean;
  sessionDir?: string;
}

export interface TaskDefaultsConfig {
  model?: string;
  sessionPersistence?: SessionPersistenceConfig;
}

export interface ExtractMemoriesConfig extends TaskDefaultsConfig {
  enabled: boolean;
  thinkLevel: ThinkLevel;
  maxContextTokens: number;
  maxMemories: number;
  responseThreshold: number;
  toolCallThreshold: number;
  shutdownResponseThreshold: number;
}

export interface MemoryConfig {
  enabled: boolean;
  defaults?: TaskDefaultsConfig;
  memoryDir: string;
  memIndexMaxLines: number;
  memIndexMaxBytes: number;
  search: {
    maxResults: number;
    maxBytes: number;
  };
  dream: TaskDefaultsConfig & {
    nudgeAfterSessions: number;
    nudgeAfterHours: number;
    thinkLevel: ThinkLevel;
  };
  sessionSearch: { maxSessions: number; maxMatches: number };
  extractMemories: ExtractMemoriesConfig;
}

export const DEFAULT_CONFIG: MemoryConfig = {
  enabled: true,
  memoryDir: join(homedir(), CONFIG_DIR_NAME, "memory"),
  memIndexMaxLines: 50,
  memIndexMaxBytes: 8 * 1024,
  search: { maxResults: 12, maxBytes: 16 * 1024 },
  dream: { nudgeAfterSessions: 5, nudgeAfterHours: 24, thinkLevel: "high" },
  sessionSearch: { maxSessions: 10, maxMatches: 5 },
  extractMemories: {
    enabled: true,
    thinkLevel: "high",
    maxContextTokens: 12_000,
    maxMemories: 5,
    responseThreshold: 10,
    toolCallThreshold: 30,
    shutdownResponseThreshold: 4,
  },
};

function expandTilde(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function deepMerge<T>(base: T, override: Partial<T>): T {
  const output: any = { ...base };
  for (const key of Object.keys(override) as (keyof T)[]) {
    const value: any = override[key];
    if (value && typeof value === "object" && !Array.isArray(value) && typeof output[key] === "object") {
      output[key] = deepMerge(output[key], value);
    } else if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}

function readJsonSafe(filePath: string): Partial<MemoryConfig> {
  try {
    if (existsSync(filePath)) return JSON.parse(readFileSync(filePath, "utf8")) as Partial<MemoryConfig>;
  } catch {
    // Ignore malformed optional configuration.
  }
  return {};
}

export interface LoadConfigContext {
  cwd: string;
  isProjectTrusted(): boolean;
  _globalDir?: string;
  _configDirName?: string;
}

export async function loadConfig(ctx: LoadConfigContext): Promise<MemoryConfig> {
  const agentDir = ctx._globalDir ?? getAgentDir();
  const configDirName = ctx._configDirName ?? CONFIG_DIR_NAME;
  let config = deepMerge(DEFAULT_CONFIG, readJsonSafe(join(agentDir, "memory.json")));
  if (ctx.isProjectTrusted()) {
    config = deepMerge(config, readJsonSafe(join(ctx.cwd, configDirName, "memory.json")));
  }
  // Preserve compatibility with the original pi-memory setup and let the
  // launcher choose a project-local base directory. Environment configuration
  // wins over file configuration so a shell wrapper cannot be accidentally
  // ignored by this extension.
  if (process.env.PI_MEMORY_DIR?.trim()) config.memoryDir = process.env.PI_MEMORY_DIR;
  config.memoryDir = expandTilde(config.memoryDir);
  return config;
}
