import { Bot, Context, InputFile, InlineKeyboard } from "grammy";
import { handleTurn, clearChatState } from "../agent/loop.js";
import { transcribeAudio, synthesizeSpeech, polishTranscript } from "../voice.js";
import { narrate } from "../narrator.js";
import type { SessionResponseState } from "../session/monitor.js";
import { log } from "../logger.js";
import { listSessions, ATTACHED_SESSION_PATH, getAttachedSession, getSessionFilePath } from "../session/history.js";
import { registerForNotifications, resolveWaitingAction, notifyResponse, sendPing } from "./notifications.js";
import { injectInput } from "../session/tmux.js";
import { clearAdapterSession } from "../session/adapter.js";
import { watchForResponse, getFileSize } from "../session/monitor.js";
import { writeFile, mkdir, unlink } from "fs/promises";
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

function splitMessage(text: string, limit = 4000): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt <= 0) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

async function sendMarkdownReply(ctx: Context, text: string): Promise<void> {
  for (const chunk of splitMessage(text)) {
    try {
      await ctx.reply(chunk, { parse_mode: "Markdown" });
    } catch {
      await ctx.reply(chunk);
    }
  }
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

async function ensureSession(
  ctx: Context,
  chatId: number
): Promise<{ sessionId: string; cwd: string } | null> {
  const existing = await getAttachedSession();
  if (existing) return existing;

  const recent = await listSessions(1);
  if (recent.length === 0) return null;

  const s = recent[0];
  await mkdir(`${homedir()}/.claude-voice`, { recursive: true });
  await writeFile(ATTACHED_SESSION_PATH, `${s.sessionId}\n${s.cwd}`, "utf8");
  clearChatState(chatId);
  clearAdapterSession(chatId);
  await ctx.reply(`Auto-attached to \`${s.projectName}\`.`, { parse_mode: "Markdown" });
  return { sessionId: s.sessionId, cwd: s.cwd };
}

let activeWatcherStop: (() => void) | null = null;

async function startInjectionWatcher(
  attached: { sessionId: string; cwd: string },
  chatId: number,
  onDone?: () => void,
  onResponse?: (state: SessionResponseState) => Promise<void>
): Promise<void> {
  // Stop any watcher from a previous injection — prevents duplicate notifications
  if (activeWatcherStop) {
    activeWatcherStop();
    activeWatcherStop = null;
  }

  const filePath = await getSessionFilePath(attached.sessionId);
  if (!filePath) {
    log({ message: `watchForResponse: could not find JSONL for session ${attached.sessionId.slice(0, 8)}` });
    onDone?.();
    return;
  }
  const baseline = await getFileSize(filePath);
  log({ message: `watchForResponse started for ${attached.sessionId.slice(0, 8)}, baseline=${baseline}` });
  activeWatcherStop = watchForResponse(
    filePath,
    baseline,
    async (state) => {
      onDone?.();
      await (onResponse ?? notifyResponse)(state);
    },
    3_600_000,
    () => sendPing("⏳ Still working...")
  );
}

async function processTextTurn(ctx: Context, chatId: number, text: string): Promise<void> {
  const attached = await ensureSession(ctx, chatId);
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
      await startInjectionWatcher(attached, chatId, () => clearInterval(typingInterval));
    } else {
      clearInterval(typingInterval);
    }
    return;
  }

  log({ chatId, direction: "out", message: reply });
  await sendMarkdownReply(ctx, reply);
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
      const polished = await polishTranscript(transcript);
      log({ chatId, direction: "in", message: `[voice] ${transcript} → polished: ${polished}` });

      const attached = await ensureSession(ctx, chatId);
      const reply = await handleTurn(chatId, polished, undefined, attached?.cwd);

      if (reply === "__SESSION_PICKER__") {
        await sendSessionPicker(ctx);
        return;
      }

      if (reply === "__INJECTED__") {
        if (polished) {
          await ctx.reply(`\`[transcription]\` ${polished}`);
        }
        await ctx.replyWithChatAction("typing");
        const typingInterval = setInterval(() => {
          ctx.replyWithChatAction("typing").catch(() => {});
        }, 4000);

        if (attached) {
          let lastText = "";
          let responseTimer: ReturnType<typeof setTimeout> | null = null;

          const voiceResponseHandler = async (state: SessionResponseState) => {
            // Text blocks are streamed as they arrive. If two blocks arrive in rapid
            // succession, Telegram delivery order is non-deterministic — acceptable here
            // since the audio summary will always reflect the final state.
            await sendMarkdownReply(ctx, `\`[claude-code]\` ${state.text}`).catch(() => {});

            // Debounce for final audio summary
            lastText = state.text;
            if (responseTimer) clearTimeout(responseTimer);
            responseTimer = setTimeout(async () => {
              try {
                const summary = await narrate(lastText, polished);
                const audio = await synthesizeSpeech(summary);
                await ctx.replyWithVoice(new InputFile(audio, "reply.mp3"));
                log({ chatId, direction: "out", message: `[voice response] ${summary.slice(0, 80)}` });
              } catch (err) {
                log({ chatId, message: `Voice response error: ${err instanceof Error ? err.message : String(err)}` });
              }
            }, 3000);
          };

          await startInjectionWatcher(attached, chatId, () => clearInterval(typingInterval), voiceResponseHandler);
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

  bot.command("detach", async (ctx) => {
    try {
      await unlink(ATTACHED_SESSION_PATH);
    } catch {
      // file did not exist
    }
    clearChatState(ctx.chat.id);
    clearAdapterSession(ctx.chat.id);
    if (activeWatcherStop) {
      activeWatcherStop();
      activeWatcherStop = null;
    }
    await ctx.reply("Detached.");
  });

  bot.command("status", async (ctx) => {
    const attached = await getAttachedSession();
    if (!attached) {
      await ctx.reply("No session attached. Use /sessions to pick one.");
      return;
    }
    const sessions = await listSessions(20);
    const info = sessions.find((s) => s.sessionId === attached.sessionId);
    const projectName = info?.projectName ?? "(unknown)";
    const lines = [
      `*Attached session*`,
      `Project: \`${projectName}\``,
      `Directory: \`${attached.cwd}\``,
      `Session: \`${attached.sessionId.slice(0, 8)}…\``,
      `Watcher: ${activeWatcherStop ? "⏳ active" : "✅ idle"}`,
    ];
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
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
            await startInjectionWatcher(attached, ctx.chat!.id);
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
      clearChatState(ctx.chat!.id);
      clearAdapterSession(ctx.chat!.id);
      await ctx.answerCallbackQuery({ text: "Attached!" });
      await ctx.reply(`Attached to \`${session.projectName}\`. Send your first message.`, {
        parse_mode: "Markdown",
      });
    }
  });

  return bot;
}
