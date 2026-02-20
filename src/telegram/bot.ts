import { Bot, Context, InputFile, InlineKeyboard } from "grammy";
import { handleTurn, clearChatState } from "../agent/loop.js";
import { transcribeAudio, synthesizeSpeech, polishTranscript } from "../voice.js";
import { narrate } from "../narrator.js";
import type { SessionResponseState } from "../session/monitor.js";
import { log } from "../logger.js";
import { listSessions, ATTACHED_SESSION_PATH, getAttachedSession, getLatestSessionFileForCwd } from "../session/history.js";
import { registerForNotifications, resolveWaitingAction, notifyResponse, sendPing } from "./notifications.js";
import { injectInput, findClaudePane, sendKeysToPane, sendRawKeyToPane } from "../session/tmux.js";
import { clearAdapterSession } from "../session/adapter.js";
import { watchForResponse, getFileSize } from "../session/monitor.js";
import { respondToPermission } from "../session/permissions.js";
import { writeFile, mkdir, unlink } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

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
let activeWatcherOnComplete: (() => void) | null = null;

async function startInjectionWatcher(
  attached: { sessionId: string; cwd: string },
  chatId: number,
  onResponse?: (state: SessionResponseState) => Promise<void>,
  onComplete?: () => void
): Promise<void> {
  // Stop any watcher from a previous injection and flush its completion so the
  // previous turn's voice summary is still generated even when a new message
  // interrupts before the result event fires.
  if (activeWatcherStop) {
    activeWatcherStop();
    activeWatcherStop = null;
    activeWatcherOnComplete?.();
    activeWatcherOnComplete = null;
  }

  const latest = await getLatestSessionFileForCwd(attached.cwd);
  if (!latest) {
    log({ message: `watchForResponse: could not find JSONL for cwd ${attached.cwd}` });
    onComplete?.();
    return;
  }
  const { filePath, sessionId: latestSessionId } = latest;
  // If Claude Code restarted and created a new session, update the attached record
  // so notifyResponse (which checks sessionId match) sends to the right session.
  if (latestSessionId !== attached.sessionId) {
    log({ message: `watchForResponse: session rotated ${attached.sessionId.slice(0, 8)} → ${latestSessionId.slice(0, 8)}, updating attached` });
    await writeFile(ATTACHED_SESSION_PATH, `${latestSessionId}\n${attached.cwd}`, "utf8").catch(() => {});
  }
  const baseline = await getFileSize(filePath);
  log({ message: `watchForResponse started for ${latestSessionId.slice(0, 8)}, baseline=${baseline}` });
  activeWatcherOnComplete = onComplete ?? null;
  activeWatcherStop = watchForResponse(
    filePath,
    baseline,
    async (state) => { await (onResponse ?? notifyResponse)(state); },
    3_600_000,
    () => sendPing("⏳ Still working..."),
    () => {
      activeWatcherOnComplete = null;
      onComplete?.();
    }
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
      await startInjectionWatcher(attached, chatId, undefined, () => clearInterval(typingInterval));
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

  bot.on("message:text", async (ctx, next) => {
    // Pass slash commands through to their bot.command() handlers.
    // Without this, returning here would stop the grammY middleware chain.
    if (ctx.message.text.startsWith("/")) return next();

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
          await ctx.reply(`[transcription] ${polished}`);
          log({ chatId, direction: "out", message: `[transcription] ${polished.slice(0, 80)}` });
        }
        await ctx.replyWithChatAction("typing");
        const typingInterval = setInterval(() => {
          ctx.replyWithChatAction("typing").catch(() => {});
        }, 4000);

        if (attached) {
          const allBlocks: string[] = [];

          const voiceResponseHandler = async (state: SessionResponseState) => {
            // Stream each text block to chat immediately as it arrives
            await sendMarkdownReply(ctx, `\`[claude-code][${state.projectName}]\` ${state.text}`).catch((err) => {
              log({ chatId, message: `stream text error: ${err instanceof Error ? err.message : String(err)}` });
            });
            log({ chatId, direction: "out", message: `[stream] ${state.text.slice(0, 80)}` });
            allBlocks.push(state.text);
          };

          const voiceCompleteHandler = () => {
            clearInterval(typingInterval);
            if (allBlocks.length === 0) return;
            narrate(allBlocks.join("\n\n"), polished)
              .then((summary) => synthesizeSpeech(summary).then((audio) => {
                ctx.replyWithVoice(new InputFile(audio, "reply.mp3"));
                log({ chatId, direction: "out", message: `[voice response] ${summary.slice(0, 80)}` });
              }))
              .catch((err) => {
                log({ chatId, message: `Voice response error: ${err instanceof Error ? err.message : String(err)}` });
              });
          };

          await startInjectionWatcher(attached, chatId, voiceResponseHandler, voiceCompleteHandler);
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

  // Handle photos and image documents forwarded from Telegram.
  // Downloads the image, saves it under ~/.claude-voice/images/, then injects
  // a message into the Claude Code session so it can read and analyse the file.
  async function handleImageMessage(
    ctx: Context,
    chatId: number,
    fileId: string,
    fileMimeType: string | undefined,
    caption: string
  ): Promise<void> {
    registerForNotifications(bot, chatId);
    await ctx.replyWithChatAction("typing");

    const file = await ctx.api.getFile(fileId);
    if (!file.file_path) throw new Error("Telegram did not return a file_path for this image");

    const ext = file.file_path.split(".").pop() ?? (fileMimeType?.split("/")[1] ?? "jpg");
    const imageDir = join(homedir(), ".claude-voice", "images");
    await mkdir(imageDir, { recursive: true });
    const imagePath = join(imageDir, `telegram-${Date.now()}.${ext}`);

    const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const resp = await fetch(fileUrl);
    if (!resp.ok) throw new Error(`Failed to download image: ${resp.status}`);
    await writeFile(imagePath, Buffer.from(await resp.arrayBuffer()));

    log({ chatId, direction: "in", message: `[image] saved to ${imagePath}` });

    const text = caption
      ? `${caption}\n\n[image: ${imagePath}]`
      : `[image: ${imagePath}]`;

    await processTextTurn(ctx, chatId, text);
  }

  bot.on("message:photo", async (ctx) => {
    const chatId = ctx.chat.id;
    try {
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      await handleImageMessage(ctx, chatId, largest.file_id, "image/jpeg", ctx.message.caption ?? "");
    } catch (err) {
      log({ chatId, message: `Image error: ${err instanceof Error ? err.message : String(err)}` });
      await ctx.reply("Couldn't process the image — try again?");
    }
  });

  bot.on("message:document", async (ctx) => {
    const chatId = ctx.chat.id;
    const doc = ctx.message.document;
    const mime = doc.mime_type ?? "";
    if (!mime.startsWith("image/")) return;
    try {
      await handleImageMessage(ctx, chatId, doc.file_id, mime, ctx.message.caption ?? "");
    } catch (err) {
      log({ chatId, message: `Image error: ${err instanceof Error ? err.message : String(err)}` });
      await ctx.reply("Couldn't process the image — try again?");
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
            await startInjectionWatcher(attached, ctx.chat!.id, undefined, undefined);
          } else {
            await ctx.answerCallbackQuery({ text: "Could not find tmux pane." });
          }
        } else {
          await ctx.answerCallbackQuery({ text: "No attached session." });
        }
      }
      return;
    }

    if (data.startsWith("perm:")) {
      const parts = data.split(":");
      const action = parts[1];
      const requestId = parts.slice(2).join(":");
      if (!requestId || (action !== "approve" && action !== "deny")) {
        await ctx.answerCallbackQuery({ text: "Invalid permission request." });
        return;
      }
      await respondToPermission(requestId, action === "deny" ? "deny" : "approve").catch((err) => {
        log({ message: `respondToPermission error: ${err instanceof Error ? err.message : String(err)}` });
      });
      // Also send the matching key to the Claude Code tmux pane so the terminal
      // permission dialog is dismissed even if the user is looking at the terminal.
      const attachedForPerm = await getAttachedSession().catch(() => null);
      if (attachedForPerm) {
        const pane = await findClaudePane(attachedForPerm.cwd).catch(() => ({ found: false as const, reason: "no_tmux" as const }));
        if (pane.found) {
          if (action === "approve") {
            await sendKeysToPane(pane.paneId, "1").catch(() => {});
          } else {
            await sendRawKeyToPane(pane.paneId, "Escape").catch(() => {});
          }
        }
      }
      await ctx.answerCallbackQuery({ text: action === "deny" ? "Denied ❌" : "Approved ✅" });
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

  bot.command("restart", async (ctx) => {
    // Send the reply and give Telegram a moment to deliver it, then exit.
    // launchd's KeepAlive will restart the service automatically.
    await ctx.reply("Restarting…").catch(() => {});
    setTimeout(() => process.exit(0), 500);
  });

  return bot;
}
