import { readFile, writeFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { join, dirname } from "path";

export type BotConfig = {
  reposFolder: string;
  allowedChatId?: number;
};

export const DEFAULT_CONFIG_PATH = join(homedir(), ".codedove", "config.json");

const DEFAULTS: BotConfig = {
  reposFolder: join(homedir(), "repositories"),
};

export async function loadConfig(configPath = DEFAULT_CONFIG_PATH): Promise<BotConfig> {
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<BotConfig>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveConfig(config: Partial<BotConfig>, configPath = DEFAULT_CONFIG_PATH): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  const existing = await loadConfig(configPath);
  const merged = { ...existing, ...config };
  await writeFile(configPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
}
