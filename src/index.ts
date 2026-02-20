import { createBot } from "./telegram/bot.js";
import { startMonitor } from "./session/monitor.js";
import { watchPermissionRequests } from "./session/permissions.js";
import { notifyWaiting, sendStartupMessage, notifyPermission } from "./telegram/notifications.js";
import { existsSync } from "fs";
import { writeFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "..", ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

// Unset CLAUDECODE so the SDK can spawn claude subprocesses without hitting
// the "cannot launch inside another Claude Code session" guard.
delete process.env.CLAUDECODE;

const required = ["TELEGRAM_BOT_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
}

const token = process.env.TELEGRAM_BOT_TOKEN!;
const bot = createBot(token);
bot.catch(console.error);

// Write the token so compact hook scripts can use curl to call the Telegram API
mkdir(join(homedir(), ".claude-voice"), { recursive: true })
  .then(() => writeFile(join(homedir(), ".claude-voice", "bot-token"), token, { mode: 0o600 }))
  .catch((err) => console.error("Failed to write bot-token:", err));

// Start session monitor — watches all Claude JSONL files for waiting state
const stopMonitor = startMonitor(notifyWaiting);

// Start permission request watcher
const stopPermissionWatcher = watchPermissionRequests(notifyPermission);

// Graceful shutdown
process.on("SIGINT", () => {
  stopMonitor();
  stopPermissionWatcher();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopMonitor();
  stopPermissionWatcher();
  process.exit(0);
});

await bot.start({
  onStart: () => {
    console.log("claude-voice bot running");
    sendStartupMessage(bot).catch(() => {});
  },
});
