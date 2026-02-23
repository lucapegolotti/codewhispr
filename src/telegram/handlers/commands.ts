import { Bot, InlineKeyboard } from "grammy";
import { log } from "../../logger.js";
import { ATTACHED_SESSION_PATH, getAttachedSession, listSessions } from "../../session/history.js";
import { findClaudePane, sendKeysToPane, killWindow } from "../../session/tmux.js";
import { summarizeSession } from "../../agent/summarizer.js";
import { sendMarkdownReply } from "../utils.js";
import { sendSessionPicker } from "./sessions.js";
import { clearActiveWatcher, watcherManager, fetchAndOfferImages } from "./text.js";
import { isTimerActive, stopTimer, setTimerSetup } from "./timer.js";
import { unlink, writeFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { access } from "fs/promises";
import { spawn } from "child_process";
import { isServiceInstalled } from "../../service/index.js";

interface AnthropicModel {
  id: string;
  display_name: string;
}

let cachedModels: AnthropicModel[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function fetchModels(): Promise<AnthropicModel[]> {
  if (cachedModels && Date.now() - cacheTimestamp < CACHE_TTL) return cachedModels;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];

  try {
    const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });
    if (!res.ok) return cachedModels ?? [];
    const json = (await res.json()) as { data: AnthropicModel[] };
    // Keep only claude models, deduplicate by display_name (prefer shorter id = alias).
    // The API returns most recent first, so first occurrence wins.
    const seen = new Set<string>();
    cachedModels = json.data
      .filter((m) => m.id.startsWith("claude-"))
      .filter((m) => {
        if (seen.has(m.display_name)) return false;
        seen.add(m.display_name);
        return true;
      });
    cacheTimestamp = Date.now();
    return cachedModels;
  } catch {
    return cachedModels ?? [];
  }
}

const POLISH_VOICE_OFF_PATH = join(homedir(), ".codedove", "polish-voice-off");

export const BOT_COMMANDS: Array<{ command: string; description: string; details: string }> = [
  {
    command: "sessions",
    description: "Pick a Claude Code session to attach to",
    details: "Lists all Claude Code sessions found under ~/.claude/projects/. Tap one to attach — the bot will then forward Claude's responses and accept your messages.",
  },
  {
    command: "status",
    description: "Show attached session info",
    details: "Shows the project name, working directory, and watcher state of the currently attached session.",
  },
  {
    command: "detach",
    description: "Detach from current session",
    details: "Stops watching the current session. Offers to also close the Claude Code tmux window. Messages you send afterwards won't be forwarded until you attach again.",
  },
  {
    command: "clear",
    description: "Clear Claude Code context (/clear)",
    details: "Sends /clear to Claude Code, starting a fresh conversation context while keeping the same tmux session open.",
  },
  {
    command: "compact",
    description: "Compact the conversation (/compact)",
    details: "Sends /compact to Claude Code, compressing the conversation history to save context space.",
  },
  {
    command: "escape",
    description: "Send Escape to cancel Claude's current action",
    details: "Sends the Escape key to the Claude Code tmux pane. Use this to interrupt a running action without sending a new message.",
  },
  {
    command: "summarize",
    description: "Summarise the current session",
    details: "Reads the current session's JSONL history and asks Claude to produce a concise summary of what has been done so far.",
  },
  {
    command: "images",
    description: "Ask Claude Code for images it created",
    details: "Asks Claude Code to list image files it has created in the working directory, then offers to send them to you.",
  },
  {
    command: "close_session",
    description: "Detach and close the Claude Code tmux window",
    details: "Detaches from the session and kills the Claude Code tmux window in one step. Use this when you're done with a project entirely.",
  },
  {
    command: "polishvoice",
    description: "Toggle voice transcript polishing on/off",
    details: "When on (default), voice messages are cleaned up by Claude before being injected into Claude Code. When off, raw Whisper transcripts are injected as-is.",
  },
  {
    command: "model",
    description: "Switch Claude Code model",
    details: "Shows a list of available Claude models. Tap one to send /model <name> to Claude Code.",
  },
  {
    command: "timer",
    description: "Set a recurring prompt on a schedule",
    details: "Sets up a recurring prompt that gets injected into Claude Code every N minutes. Run /timer again to stop an active timer.",
  },
  {
    command: "restart",
    description: "Restart the bot service",
    details: "Exits the bot process. The system service (launchd/systemd) restarts it automatically. Use this to pick up code changes.",
  },
  {
    command: "help",
    description: "Show this command list with descriptions",
    details: "Shows all available commands with full descriptions.",
  },
];

async function isVoicePolishEnabled(): Promise<boolean> {
  try {
    await access(POLISH_VOICE_OFF_PATH);
    return false;
  } catch {
    return true;
  }
}

async function sendClaudeCommand(ctx: Parameters<Parameters<Bot["command"]>[1]>[0], command: string): Promise<void> {
  const attached = await getAttachedSession().catch(() => null);
  if (!attached) {
    await ctx.reply("No session attached. Use /sessions to pick one.");
    return;
  }
  const pane = await findClaudePane(attached.cwd).catch(() => ({ found: false as const, reason: "no_tmux" as const }));
  if (!pane.found) {
    await ctx.reply("Could not find the Claude Code tmux pane.");
    return;
  }
  await sendKeysToPane(pane.paneId, command);
}

export function registerCommands(bot: Bot): void {
  bot.command("compact", async (ctx) => {
    await sendClaudeCommand(ctx, "/compact");
  });

  bot.command("polishvoice", async (ctx) => {
    const enabled = await isVoicePolishEnabled();
    if (enabled) {
      await mkdir(join(homedir(), ".codedove"), { recursive: true });
      await writeFile(POLISH_VOICE_OFF_PATH, "", "utf8");
      await ctx.reply("Voice polish *off*. Raw Whisper transcripts will be injected.", { parse_mode: "Markdown" });
    } else {
      await unlink(POLISH_VOICE_OFF_PATH).catch(() => {});
      await ctx.reply("Voice polish *on*. Transcripts will be cleaned up before injection.", { parse_mode: "Markdown" });
    }
  });

  bot.command("summarize", async (ctx) => {
    await ctx.replyWithChatAction("typing");
    try {
      const summary = await summarizeSession();
      await sendMarkdownReply(ctx, summary);
    } catch (err) {
      log({ message: `summarize error: ${err instanceof Error ? err.message : String(err)}` });
      await ctx.reply("Could not generate summary — try again?");
    }
  });

  bot.command("clear", async (ctx) => {
    await sendClaudeCommand(ctx, "/clear");
  });

  bot.command("sessions", async (ctx) => {
    await sendSessionPicker(ctx);
  });

  bot.command("detach", async (ctx) => {
    const attached = await getAttachedSession().catch(() => null);
    const pane = attached
      ? await findClaudePane(attached.cwd).catch(() => ({ found: false as const, reason: "no_tmux" as const }))
      : null;

    // Always detach immediately
    try { await unlink(ATTACHED_SESSION_PATH); } catch { /* already gone */ }
    clearActiveWatcher();

    if (pane?.found) {
      const keyboard = new InlineKeyboard()
        .text("Close tmux window", `detach:close:${pane.paneId}`)
        .text("Keep open", "detach:keep");
      await ctx.reply("Detached. Close the tmux Claude Code window too?", { reply_markup: keyboard });
    } else {
      await ctx.reply("Detached.");
    }
  });

  bot.command("close_session", async (ctx) => {
    const attached = await getAttachedSession().catch(() => null);
    if (!attached) {
      await ctx.reply("No session attached.");
      return;
    }

    const pane = await findClaudePane(attached.cwd).catch(() => ({ found: false as const, reason: "no_tmux" as const }));

    try { await unlink(ATTACHED_SESSION_PATH); } catch { /* already gone */ }
    clearActiveWatcher();

    if (pane.found) {
      await killWindow(pane.paneId).catch((err) => {
        log({ message: `killWindow error: ${err instanceof Error ? err.message : String(err)}` });
      });
      await ctx.reply("Session closed.");
    } else {
      await ctx.reply("No running session found — detached.");
    }
  });

  bot.command("status", async (ctx) => {
    const attached = await getAttachedSession();
    if (!attached) {
      await ctx.reply("No session attached. Use /sessions to pick one.");
      return;
    }
    const sessions = await listSessions(20);
    const info = sessions.find((s) => s.sessionId === attached.sessionId);
    const project = info?.projectName ?? attached.sessionId.slice(0, 8);
    const watcherState = watcherManager.isActive ? "⏳ active" : "✅ idle";
    await ctx.reply(
      `\`${project}\` · \`${attached.cwd}\` · watcher: ${watcherState}`,
      { parse_mode: "Markdown" }
    );
  });

  bot.command("images", async (ctx) => {
    const attached = await getAttachedSession().catch(() => null);
    if (!attached) {
      await ctx.reply("No session attached. Use /sessions to pick one.");
      return;
    }
    await ctx.reply("Asking Claude Code for image files…");
    await fetchAndOfferImages(attached.cwd);
  });

  bot.command("escape", async (ctx) => {
    await sendClaudeCommand(ctx, "Escape");
  });

  bot.command("model", async (ctx) => {
    const models = await fetchModels();
    const keyboard = new InlineKeyboard();
    keyboard.text("Default (Sonnet)", "model:sonnet").row();
    if (models.length > 0) {
      for (const m of models) {
        keyboard.text(m.display_name, `model:${m.id}`).row();
      }
    } else {
      // Fallback if API is unreachable
      keyboard.text("Opus 4.6", "model:claude-opus-4-6").row();
      keyboard.text("Sonnet 4.6", "model:claude-sonnet-4-6").row();
      keyboard.text("Haiku 4.5", "model:claude-haiku-4-5-20251001");
    }
    await ctx.reply("Choose a model:", { reply_markup: keyboard });
  });

  bot.command("timer", async (ctx) => {
    if (isTimerActive()) {
      const stopped = stopTimer();
      if (stopped) {
        await ctx.reply(`Timer stopped. Was running every ${stopped.frequencyMin}min.`);
      } else {
        await ctx.reply("No active timer.");
      }
      return;
    }
    const keyboard = new InlineKeyboard()
      .text("Yes, set a timer", "timer:confirm")
      .text("Cancel", "timer:cancel");
    await ctx.reply("Set up a recurring prompt for Claude Code?", { reply_markup: keyboard });
  });

  bot.command("restart", async (ctx) => {
    // Persist chat-id before exiting so sendStartupMessage can confirm the restart.
    const chatIdDir = join(homedir(), ".codedove");
    await mkdir(chatIdDir, { recursive: true });
    await writeFile(join(chatIdDir, "chat-id"), String(ctx.chat.id), "utf8").catch(() => {});
    await ctx.reply("Restarting…").catch(() => {});
    const serviceInstalled = await isServiceInstalled().catch(() => false);
    if (serviceInstalled) {
      // Service manager (launchd/systemd) will revive the process automatically.
      setTimeout(() => process.exit(0), 500);
    } else {
      // Running manually — spawn a fresh copy then exit so Telegram polling
      // doesn't conflict. The 1 s delay lets the current getUpdates request
      // expire before the new process starts polling.
      const child = spawn(process.argv[0], process.argv.slice(1), {
        detached: true,
        stdio: "ignore",
        cwd: process.cwd(),
        env: process.env,
      });
      child.unref();
      setTimeout(() => process.exit(0), 1000);
    }
  });

  const escMd = (s: string) => s.replace(/[_*[\]()~`>#+=|{}.!\\-]/g, "\\$&");
  const HELP_TEXT = [
    "*codedove commands*",
    "",
    ...BOT_COMMANDS.flatMap(({ command, details }) => [
      `*/${command.replace(/_/g, "\\_")}*`,
      escMd(details),
      "",
    ]),
  ].join("\n");

  bot.command("help", async (ctx) => {
    await ctx.reply(HELP_TEXT, { parse_mode: "MarkdownV2" }).catch(() =>
      ctx.reply(
        "Commands: /sessions /detach /status /summarize /compact /clear /escape /close_session /polishvoice /restart /help"
      )
    );
  });

}
