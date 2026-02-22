import { Bot, InlineKeyboard } from "grammy";
import { clearChatState } from "../../agent/loop.js";
import { log } from "../../logger.js";
import { ATTACHED_SESSION_PATH, getAttachedSession, listSessions } from "../../session/history.js";
import { findClaudePane, sendKeysToPane, killWindow } from "../../session/tmux.js";
import { summarizeSession } from "../../agent/summarizer.js";
import { sendMarkdownReply } from "../utils.js";
import { sendSessionPicker } from "./sessions.js";
import { clearActiveWatcher, activeWatcherStop, fetchAndOfferImages } from "./text.js";
import { unlink, writeFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { access } from "fs/promises";

const POLISH_VOICE_OFF_PATH = join(homedir(), ".codewhispr", "polish-voice-off");

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
      await mkdir(join(homedir(), ".codewhispr"), { recursive: true });
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
    clearChatState(ctx.chat.id);
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
    clearChatState(ctx.chat.id);
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
    const watcherState = activeWatcherStop ? "⏳ active" : "✅ idle";
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

  bot.command("restart", async (ctx) => {
    // Send the reply and give Telegram a moment to deliver it, then exit.
    // launchd's KeepAlive will restart the service automatically.
    await ctx.reply("Restarting…").catch(() => {});
    setTimeout(() => process.exit(0), 500);
  });

  const escMd = (s: string) => s.replace(/[_*[\]()~`>#+=|{}.!\\-]/g, "\\$&");
  const HELP_TEXT = [
    "*codewhispr commands*",
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
