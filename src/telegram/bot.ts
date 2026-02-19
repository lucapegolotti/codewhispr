import { Bot, Context, InputFile, InlineKeyboard } from "grammy";
import { handleTurn } from "../agent/loop.js";
import { transcribeAudio, synthesizeSpeech } from "../voice.js";
import { log } from "../logger.js";
import { listSessions, ATTACHED_SESSION_PATH, getAttachedSession, getSessionFilePath } from "../session/history.js";
import { registerForNotifications, resolveWaitingAction, notifyResponse } from "./notifications.js";
import { injectInput } from "../session/tmux.js";
import { watchForResponse, getFileSize } from "../session/monitor.js";
import { writeFile, mkdir } from "fs/promises";
import { homedir } from "os";

const pendingSessions = new Map<string, { sessionId: string; cwd: string; projectName: string }>();

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds <= 0) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

async function sendSessionPicker(ctx: Context): Promise<void> {
  const sessions = await listSessions();
  if (sessions.length === 0) {
    await ctx.reply("No sessions found.");
    return;
  }

  const keyboard = new InlineKeyboard();
  pendingSessions.clear();
  for (const s of sessions) {
    pendingSessions.set(s.sessionId, s);
    keyboard.text(`${s.projectName} · ${timeAgo(s.mtime)}`, `session:${s.sessionId}`).row();
  }

  const lines = sessions.map((s) => {
    const preview = s.lastMessage ? `  "${s.lastMessage}"` : "  (no messages)";
    return `• ${s.projectName} · ${timeAgo(s.mtime)}\n${preview}`;
  });

  await ctx.reply(`Available sessions:\n\n${lines.join("\n\n")}`, { reply_markup: keyboard });
}

async function startInjectionWatcher(
  attached: { sessionId: string; cwd: string },
  onDone?: () => void
): Promise<void> {
  const filePath = await getSessionFilePath(attached.sessionId);
  if (!filePath) {
    log({ message: `watchForResponse: could not find JSONL for session ${attached.sessionId.slice(0, 8)}` });
    onDone?.();
    return;
  }
  const baseline = await getFileSize(filePath);
  log({ message: `watchForResponse started for ${attached.sessionId.slice(0, 8)}, baseline=${baseline}` });
  watchForResponse(filePath, baseline, async (state) => {
    onDone?.();
    await notifyResponse(state);
  });
}

async function processTextTurn(ctx: Context, chatId: number, text: string): Promise<void> {
  const attached = await getAttachedSession();
  const reply = await handleTurn(chatId, text, undefined, attached?.cwd);

  if (reply === "__SESSION_PICKER__") {
    await sendSessionPicker(ctx);
    return;
  }

  if (reply === "__INJECTED__") {
    await ctx.replyWithChatAction("typing");
    const typingInterval = setInterval(() => {
      ctx.replyWithChatAction("typing").catch(() => {});
    }, 4000);
    if (attached) {
      await startInjectionWatcher(attached, () => clearInterval(typingInterval));
    } else {
      clearInterval(typingInterval);
    }
    return;
  }

  log({ chatId, direction: "out", message: reply });
  await ctx.reply(reply);
}

export function createBot(token: string): Bot {
  const bot = new Bot(token);

  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    const userText = ctx.message.text;
    await ctx.replyWithChatAction("typing");
    log({ chatId, direction: "in", message: userText });
    registerForNotifications(bot, chatId);

    try {
      await processTextTurn(ctx, chatId, userText);
    } catch (err) {
      log({ chatId, message: `Error: ${err instanceof Error ? err.message : String(err)}` });
      await ctx.reply("Something went wrong — try again?");
    }
  });

  bot.on("message:voice", async (ctx) => {
    const chatId = ctx.chat.id;
    await ctx.replyWithChatAction("record_voice");
    registerForNotifications(bot, chatId);

    try {
      const file = await ctx.getFile();
      if (!file.file_path) throw new Error("Telegram did not return a file_path for this voice note");
      const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const audioResponse = await fetch(fileUrl);
      if (!audioResponse.ok) throw new Error(`Failed to download voice note: ${audioResponse.status}`);
      const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());

      const transcript = await transcribeAudio(audioBuffer, "voice.ogg");
      log({ chatId, direction: "in", message: transcript });

      const attached = await getAttachedSession();
      const reply = await handleTurn(chatId, transcript, undefined, attached?.cwd);

      if (reply === "__SESSION_PICKER__") {
        await sendSessionPicker(ctx);
        return;
      }

      if (reply === "__INJECTED__") {
        await ctx.replyWithChatAction("typing");
        const typingInterval = setInterval(() => {
          ctx.replyWithChatAction("typing").catch(() => {});
        }, 4000);
        if (attached) {
          await startInjectionWatcher(attached, () => clearInterval(typingInterval));
        } else {
          clearInterval(typingInterval);
        }
        return;
      }

      log({ chatId, direction: "out", message: reply });
      const audioReply = await synthesizeSpeech(reply);
      await ctx.replyWithVoice(new InputFile(audioReply, "reply.mp3"));
    } catch (err) {
      log({ chatId, message: `Voice error: ${err instanceof Error ? err.message : String(err)}` });
      await ctx.reply("Couldn't process your voice message — try again?");
    }
  });

  bot.command("sessions", async (ctx) => {
    await sendSessionPicker(ctx);
  });

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    if (data.startsWith("waiting:")) {
      if (data === "waiting:ignore") {
        await ctx.answerCallbackQuery({ text: "Ignored." });
        return;
      }
      if (data === "waiting:custom") {
        await ctx.answerCallbackQuery({ text: "Send your input as a text message." });
        return;
      }
      const input = resolveWaitingAction(data);
      if (input !== null) {
        const attached = await getAttachedSession();
        if (attached) {
          const result = await injectInput(attached.cwd, input);
          if (result.found) {
            await ctx.answerCallbackQuery({ text: "Sent!" });
            await ctx.reply(`Sent "${input || "↩"}". Claude is resuming.`);
          } else {
            await ctx.answerCallbackQuery({ text: "Could not find tmux pane." });
          }
        } else {
          await ctx.answerCallbackQuery({ text: "No attached session." });
        }
      }
      return;
    }

    if (data.startsWith("session:")) {
      const sessionId = data.slice("session:".length);
      const session = pendingSessions.get(sessionId);
      if (!session) {
        await ctx.answerCallbackQuery({ text: "Session not found — try /sessions again." });
        return;
      }
      await mkdir(`${homedir()}/.claude-voice`, { recursive: true });
      await writeFile(ATTACHED_SESSION_PATH, `${session.sessionId}\n${session.cwd}`, "utf8");
      await ctx.answerCallbackQuery({ text: "Attached!" });
      await ctx.reply(`Attached to \`${session.projectName}\`. Send your first message.`, {
        parse_mode: "Markdown",
      });
    }
  });

  return bot;
}
