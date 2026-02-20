import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

const TMP_DIR = join(tmpdir(), `cv-config-test-${Date.now()}`);
const TMP_CONFIG = join(TMP_DIR, "config.json");

describe("loadConfig", () => {
  beforeEach(async () => {
    await mkdir(TMP_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TMP_DIR, { recursive: true, force: true });
  });

  it("returns defaults when config file does not exist", async () => {
    const { loadConfig } = await import("./config.js");
    const config = await loadConfig(join(TMP_DIR, "nonexistent.json"));
    expect(config.reposFolder).toMatch(/repositories/);
    expect(config.allowedChatId).toBeUndefined();
  });

  it("reads saved values from config file", async () => {
    await writeFile(TMP_CONFIG, JSON.stringify({ reposFolder: "/custom/repos", allowedChatId: 999 }));
    const { loadConfig } = await import("./config.js");
    const config = await loadConfig(TMP_CONFIG);
    expect(config.reposFolder).toBe("/custom/repos");
    expect(config.allowedChatId).toBe(999);
  });

  it("returns defaults for missing keys in partial config", async () => {
    await writeFile(TMP_CONFIG, JSON.stringify({ reposFolder: "/custom" }));
    const { loadConfig } = await import("./config.js");
    const config = await loadConfig(TMP_CONFIG);
    expect(config.allowedChatId).toBeUndefined();
  });
});

describe("saveConfig", () => {
  beforeEach(async () => {
    await mkdir(TMP_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TMP_DIR, { recursive: true, force: true });
  });

  it("writes config to file", async () => {
    const { saveConfig } = await import("./config.js");
    await saveConfig({ reposFolder: "/my/repos" }, TMP_CONFIG);
    const raw = await readFile(TMP_CONFIG, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.reposFolder).toBe("/my/repos");
  });
});
