import { Bot, Context, InputFile, InlineKeyboard } from "grammy";
import { splitMessage, sendMarkdownReply } from "./utils.js";
import { handleTurn, clearChatState } from "../agent/loop.js";
import { summarizeSession } from "../agent/summarizer.js";
import { transcribeAudio, synthesizeSpeech, polishTranscript } from "../voice.js";
import { narrate } from "../narrator.js";
import type { SessionResponseState } from "../session/monitor.js";
import { log } from "../logger.js";
import { listSessions, ATTACHED_SESSION_PATH, getAttachedSession, getLatestSessionFileForCwd } from "../session/history.js";
import { registerForNotifications, resolveWaitingAction, notifyResponse, sendPing } from "./notifications.js";
import { injectInput, findClaudePane, sendKeysToPane, sendRawKeyToPane, launchClaudeInWindow, killWindow } from "../session/tmux.js";
import { watchForResponse, getFileSize } from "../session/monitor.js";
import { respondToPermission } from "../session/permissions.js";
import { writeFile, mkdir, unlink, access, stat } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

const pendingSessions = new Map<string, { sessionId: string; cwd: string; projectName: string }>();
// Pane ID of a recently launched (but not yet fully started) Claude Code window.
// Used as a fallback for injection while Claude Code is still initializing.
let launchedPaneId: string | undefined;

const POLISH_VOICE_OFF_PATH = join(homedir(), ".claude-voice", "polish-voice-off");

async function isVoicePolishEnabled(): Promise<boolean> {
  try {
    await access(POLISH_VOICE_OFF_PATH);
    return false; // flag file exists → polish off
  } catch {
    return true; // flag file absent → polish on (default)
  }
}

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
  await ctx.reply(`Auto-attached to \`${s.projectName}\`.`, { parse_mode: "Markdown" });
  return { sessionId: s.sessionId, cwd: s.cwd };
}

let activeWatcherStop: (() => void) | null = null;
let activeWatcherOnComplete: (() => void) | null = null;
let compactPollGeneration = 0;

// Snapshot the active session file and its current byte offset before injection.
// Pass this to startInjectionWatcher so the baseline is set before Claude responds,
// avoiding a race where a fast response is written before the watcher is set up.
async function snapshotBaseline(
  cwd: string
): Promise<{ filePath: string; sessionId: string; size: number } | null> {
  const latest = await getLatestSessionFileForCwd(cwd);
  if (!latest) return null;
  const size = await getFileSize(latest.filePath);
  return { ...latest, size };
}

async function startInjectionWatcher(
  attached: { sessionId: string; cwd: string },
  chatId: number,
  onResponse?: (state: SessionResponseState) => Promise<void>,
  onComplete?: () => void,
  preBaseline?: { filePath: string; sessionId: string; size: number } | null
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

  // Increment generation so any in-flight compaction polls from a previous
  // injection know to abort.
  const myGeneration = ++compactPollGeneration;

  let filePath: string;
  let latestSessionId: string;
  let baseline: number;

  if (preBaseline) {
    // Use the pre-injection snapshot — baseline was recorded before Claude responded
    ({ filePath, sessionId: latestSessionId, size: baseline } = preBaseline);
  } else {
    // No pre-snapshot: find the session file now (fallback for waiting-prompt injections)
    const latest = await getLatestSessionFileForCwd(attached.cwd);
    if (!latest) {
      log({ message: `watchForResponse: could not find JSONL for cwd ${attached.cwd}` });
      onComplete?.();
      return;
    }
    filePath = latest.filePath;
    latestSessionId = latest.sessionId;
    baseline = await getFileSize(filePath);
  }

  // If Claude Code restarted and created a new session, update the attached record
  // so notifyResponse (which checks sessionId match) sends to the right session.
  if (latestSessionId !== attached.sessionId) {
    log({ message: `watchForResponse: session rotated ${attached.sessionId.slice(0, 8)} → ${latestSessionId.slice(0, 8)}, updating attached` });
    await writeFile(ATTACHED_SESSION_PATH, `${latestSessionId}\n${attached.cwd}`, "utf8").catch(() => {});
  }

  // Track whether any response text was delivered during this watch session.
  // If onComplete fires with no response delivered, a compaction may have ended
  // the turn before Claude responded — poll for the new post-compact session file.
  let responseDelivered = false;
  const wrappedOnResponse = async (state: SessionResponseState) => {
    responseDelivered = true;
    await (onResponse ?? notifyResponse)(state);
  };

  log({ message: `watchForResponse started for ${latestSessionId.slice(0, 8)}, baseline=${baseline}` });
  activeWatcherOnComplete = onComplete ?? null;
  const watchedFilePath = filePath;
  const watchedCwd = attached.cwd;
  activeWatcherStop = watchForResponse(
    filePath,
    baseline,
    wrappedOnResponse,
    3_600_000,
    () => sendPing("⏳ Still working..."),
    () => {
      activeWatcherOnComplete = null;
      if (!responseDelivered) {
        // No text was delivered before the result event — likely a compaction stop.
        // Poll for the new session file that Claude Code creates after restarting.
        log({ message: `watcher completed with no response for ${watchedCwd}, checking for post-compact session...` });
        void pollForPostCompactionSession(myGeneration, watchedCwd, watchedFilePath, onResponse, onComplete);
      } else {
        onComplete?.();
      }
    }
  );
}

// After a compaction, Claude Code restarts with a new JSONL file. Poll until we
// find a different session file for the same cwd, then restart watching on it.
async function pollForPostCompactionSession(
  generation: number,
  cwd: string,
  oldFilePath: string,
  onResponse?: (state: SessionResponseState) => Promise<void>,
  onComplete?: () => void
): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 3_000));
    // Abort if a new message injection started a fresh watcher generation.
    if (compactPollGeneration !== generation) return;

    const latest = await getLatestSessionFileForCwd(cwd);
    if (latest && latest.filePath !== oldFilePath) {
      log({ message: `post-compact: new session found ${latest.sessionId.slice(0, 8)}, restarting watcher` });
      await writeFile(ATTACHED_SESSION_PATH, `${latest.sessionId}\n${cwd}`, "utf8").catch(() => {});
      activeWatcherOnComplete = onComplete ?? null;
      activeWatcherStop = watchForResponse(
        latest.filePath,
        0,
        async (state) => { await (onResponse ?? notifyResponse)(state); },
        3_600_000,
        () => sendPing("⏳ Still working..."),
        () => {
          activeWatcherOnComplete = null;
          onComplete?.();
        }
      );
      return;
    }
  }
  log({ message: `post-compact: no new session found for ${cwd} after 60s` });
  onComplete?.();
}

async function processTextTurn(ctx: Context, chatId: number, text: string): Promise<void> {
  const attached = await ensureSession(ctx, chatId);
  // Snapshot file position BEFORE injection — avoids missing fast responses where
  // Claude writes to the JSONL before startInjectionWatcher reads the file size.
  const preBaseline = attached ? await snapshotBaseline(attached.cwd) : null;
  const reply = await handleTurn(chatId, text, undefined, attached?.cwd, launchedPaneId);

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
      await startInjectionWatcher(attached, chatId, undefined, () => clearInterval(typingInterval), preBaseline);
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
      const polishEnabled = await isVoicePolishEnabled();
      const polished = polishEnabled ? await polishTranscript(transcript) : transcript;
      log({ chatId, direction: "in", message: `[voice] ${transcript} → polished: ${polished}` });

      const attached = await ensureSession(ctx, chatId);
      const preBaseline = attached ? await snapshotBaseline(attached.cwd) : null;
      const injected = transcript ? `${polished}\n\n[transcribed from voice, may contain inaccuracies]` : polished;
      const reply = await handleTurn(chatId, injected, undefined, attached?.cwd, launchedPaneId);

      if (reply === "__SESSION_PICKER__") {
        await sendSessionPicker(ctx);
        return;
      }

      if (reply === "__INJECTED__") {
        if (transcript) {
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
            await sendMarkdownReply(ctx, `\`[claude-code][${state.projectName}]\` ${state.text.replaceAll(";", ".").replaceAll(":", ".")}`).catch((err) => {
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

          await startInjectionWatcher(attached, chatId, voiceResponseHandler, voiceCompleteHandler, preBaseline);
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

  async function sendClaudeCommand(ctx: Context, command: string): Promise<void> {
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

  bot.command("compact", async (ctx) => {
    await sendClaudeCommand(ctx, "/compact");
  });

  bot.command("polishvoice", async (ctx) => {
    const enabled = await isVoicePolishEnabled();
    if (enabled) {
      await mkdir(join(homedir(), ".claude-voice"), { recursive: true });
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
    launchedPaneId = undefined;
    clearChatState(ctx.chat.id);
    if (activeWatcherStop) {
      activeWatcherStop();
      activeWatcherStop = null;
    }

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
    if (activeWatcherStop) {
      activeWatcherStop();
      activeWatcherStop = null;
    }

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
      // Remove buttons by clearing reply markup — editMessageText can fail silently
      // when the original message contains JSON/special chars in a code block.
      await ctx.editMessageReplyMarkup().catch(() => {});
      return;
    }

    if (data.startsWith("session:")) {
      const sessionId = data.slice("session:".length);
      const session = pendingSessions.get(sessionId);
      if (!session) {
        await ctx.answerCallbackQuery({ text: "Session not found — try /sessions again." });
        return;
      }

      // Check whether Claude Code is already running at this cwd
      const pane = await findClaudePane(session.cwd).catch(() => ({ found: false as const, reason: "no_tmux" as const }));

      if (pane.found) {
        // Claude Code is running — attach immediately
        await mkdir(`${homedir()}/.claude-voice`, { recursive: true });
        await writeFile(ATTACHED_SESSION_PATH, `${session.sessionId}\n${session.cwd}`, "utf8");
        launchedPaneId = undefined; // clear any stale launched pane
        clearChatState(ctx.chat!.id);
        await ctx.answerCallbackQuery({ text: "Attached!" });
        await ctx.reply(`Attached to \`${session.projectName}\`. Send your first message.`, {
          parse_mode: "Markdown",
        });
      } else {
        // No running pane — offer to launch
        await ctx.answerCallbackQuery();
        const keyboard = new InlineKeyboard()
          .text("Launch", `launch:${sessionId}`)
          .text("Launch (skip permissions)", `launch:skip:${sessionId}`)
          .row()
          .text("Cancel", `launch:cancel:${sessionId}`);
        await ctx.reply(
          `No Claude Code running at \`${session.projectName}\`. Launch one?`,
          { parse_mode: "Markdown", reply_markup: keyboard }
        );
      }
      return;
    }

    if (data.startsWith("launch:")) {
      if (data.startsWith("launch:cancel:")) {
        await ctx.answerCallbackQuery({ text: "Cancelled." });
        await ctx.editMessageReplyMarkup();
        return;
      }

      const skipPermissions = data.startsWith("launch:skip:");
      const sessionId = skipPermissions
        ? data.slice("launch:skip:".length)
        : data.slice("launch:".length);

      const session = pendingSessions.get(sessionId);
      if (!session) {
        await ctx.answerCallbackQuery({ text: "Session not found — try /sessions again." });
        return;
      }

      let paneId: string;
      try {
        paneId = await launchClaudeInWindow(session.cwd, session.projectName, skipPermissions);
      } catch (err) {
        await ctx.answerCallbackQuery({ text: "Failed to launch tmux window." });
        log({ message: `launchClaudeInWindow error: ${err instanceof Error ? err.message : String(err)}` });
        return;
      }

      // Attach to this project's cwd — sessionId will be discovered lazily by the watcher
      await mkdir(`${homedir()}/.claude-voice`, { recursive: true });
      await writeFile(ATTACHED_SESSION_PATH, `${session.sessionId}\n${session.cwd}`, "utf8");
      launchedPaneId = paneId; // fallback for injection while Claude Code initializes
      clearChatState(ctx.chat!.id);

      await ctx.answerCallbackQuery({ text: "Launched!" });
      const flag = skipPermissions ? " with `--dangerously-skip-permissions`" : "";
      await ctx.editMessageText(
        `Launching Claude Code${flag} at \`${session.projectName}\`… I'll notify you when it's ready.`,
        { parse_mode: "Markdown" }
      );

      // Poll in the background until Claude Code's pane is detectable, then notify.
      const chatId = ctx.chat!.id;
      const projectName = session.projectName;
      const cwd = session.cwd;
      (async () => {
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2000));
          const found = await findClaudePane(cwd).catch(() => ({ found: false as const, reason: "no_tmux" as const }));
          if (found.found) {
            await bot.api.sendMessage(chatId, `✅ Claude Code is ready at \`${projectName}\`. Send your first message.`, { parse_mode: "Markdown" });
            return;
          }
        }
        await bot.api.sendMessage(chatId, `⚠️ Claude Code at \`${projectName}\` didn't start within 60s — check the tmux window.`, { parse_mode: "Markdown" });
      })().catch((err) => log({ message: `launch ready-poll error: ${err instanceof Error ? err.message : String(err)}` }));

      return;
    }

    if (data.startsWith("detach:")) {
      if (data === "detach:keep") {
        await ctx.answerCallbackQuery({ text: "Kept open." });
        await ctx.editMessageReplyMarkup();
        return;
      }
      if (data.startsWith("detach:close:")) {
        const paneId = data.slice("detach:close:".length);
        await killWindow(paneId).catch((err) => {
          log({ message: `killWindow error: ${err instanceof Error ? err.message : String(err)}` });
        });
        await ctx.answerCallbackQuery({ text: "Closed." });
        await ctx.editMessageText("Detached. tmux window closed.");
        return;
      }
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
