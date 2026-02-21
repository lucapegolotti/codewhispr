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

  bot.command("restart", async (ctx) => {
    // Send the reply and give Telegram a moment to deliver it, then exit.
    // launchd's KeepAlive will restart the service automatically.
    await ctx.reply("Restarting…").catch(() => {});
    setTimeout(() => process.exit(0), 500);
  });

  const HELP_TEXT = [
    "*claude\\-voice commands*",
    "",
    "/sessions \\— pick a Claude Code session to attach to",
    "/detach \\— detach from current session",
    "/status \\— show attached session info",
    "/summarize \\— summarise the current session",
    "/compact \\— trigger /compact in Claude Code",
    "/clear \\— clear Claude Code context",
    "/close\\_session \\— close the Claude Code window",
    "/images \\— ask Claude Code for images it created",
    "/polishvoice \\— toggle voice transcript polishing on/off",
    "/restart \\— restart the bot",
    "/help \\— show this list",
  ].join("\n");

  bot.command("help", async (ctx) => {
    await ctx.reply(HELP_TEXT, { parse_mode: "MarkdownV2" }).catch(() =>
      ctx.reply(
        "Commands: /sessions /detach /status /summarize /compact /clear /close_session /polishvoice /restart /help"
      )
    );
  });
}
