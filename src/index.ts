import { createBot } from "./telegram/bot.js";
import { startMonitor } from "./session/monitor.js";
import { watchPermissionRequests } from "./session/permissions.js";
import { notifyWaiting, sendStartupMessage, notifyPermission } from "./telegram/notifications.js";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
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

const bot = createBot(process.env.TELEGRAM_BOT_TOKEN!);
bot.catch(console.error);

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
