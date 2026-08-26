import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const previousMemoryDir = process.env.PI_MEMORY_DIR;

afterEach(() => {
  if (previousMemoryDir === undefined) delete process.env.PI_MEMORY_DIR;
  else process.env.PI_MEMORY_DIR = previousMemoryDir;
});

describe("memory directory configuration", () => {
  it("honors PI_MEMORY_DIR for project-local launcher setups", async () => {
    process.env.PI_MEMORY_DIR = "/project/.pi/memory";
    const config = await loadConfig({
      cwd: "/project",
      isProjectTrusted: () => false,
      _globalDir: "/tmp/pi-project-memory-no-config",
    });

    expect(config.memoryDir).toBe("/project/.pi/memory");
  });
});
