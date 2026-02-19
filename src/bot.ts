import { Bot, InputFile } from "grammy";
import { runAgentTurn } from "./sessions.js";
import { transcribeAudio, synthesizeSpeech } from "./voice.js";
import { log } from "./logger.js";
import { InlineKeyboard } from "grammy";
import { listSessions, SessionInfo } from "./sessions.js";
import { detectSessionListIntent } from "./intent.js";
import { writeFile, mkdir } from "fs/promises";
import { homedir } from "os";

const ATTACHED_SESSION_PATH = `${homedir()}/.claude-voice/attached`;
const pendingSessions = new Map<string, SessionInfo>();

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

async function sendSessionPicker(ctx: { reply: Function }): Promise<void> {
  const sessions = await listSessions();
  if (sessions.length === 0) {
    await ctx.reply("No sessions found.");
    return;
  }

  const keyboard = new InlineKeyboard();
  for (const s of sessions) {
    pendingSessions.set(s.sessionId, s);
    const label = `${s.projectName} · ${timeAgo(s.mtime)}`;
    keyboard.text(label, `session:${s.sessionId}`).row();
  }

  const lines = sessions.map((s) => {
    const preview = s.lastMessage ? `  "${s.lastMessage}"` : "  (no messages)";
    return `• ${s.projectName} · ${timeAgo(s.mtime)}\n${preview}`;
  });

  await ctx.reply(`Available sessions:\n\n${lines.join("\n\n")}`, {
    reply_markup: keyboard,
  });
}

export function createBot(token: string): Bot {
  const bot = new Bot(token);

  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    const userText = ctx.message.text;
    await ctx.replyWithChatAction("typing");
    log({ chatId, direction: "in", message: userText });

    try {
      if (await detectSessionListIntent(userText)) {
        await sendSessionPicker(ctx);
        return;
      }
      const reply = await runAgentTurn(chatId, userText);
      log({ chatId, direction: "out", message: reply });
      await ctx.reply(reply);
    } catch (err) {
      log({ chatId, message: `Error: ${err instanceof Error ? err.message : String(err)}` });
      await ctx.reply("Something went wrong — try again?");
    }
  });

  bot.on("message:voice", async (ctx) => {
    const chatId = ctx.chat.id;
    await ctx.replyWithChatAction("record_voice");
    log({ chatId, direction: "in", message: "[voice note]" });

    try {
      const file = await ctx.getFile();
      if (!file.file_path) throw new Error("Telegram did not return a file_path for this voice note");
      const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const audioResponse = await fetch(fileUrl);
      if (!audioResponse.ok) throw new Error(`Failed to download voice note: ${audioResponse.status}`);
      const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());

      const transcript = await transcribeAudio(audioBuffer, "voice.ogg");
      log({ chatId, message: `transcribed: "${transcript}"` });

      if (await detectSessionListIntent(transcript)) {
        await sendSessionPicker(ctx);
        return;
      }

      const replyText = await runAgentTurn(chatId, transcript);
      log({ chatId, direction: "out", message: "[voice reply]" });
      const audioReply = await synthesizeSpeech(replyText);
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
    if (!data.startsWith("session:")) return;

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
  });

  return bot;
}
