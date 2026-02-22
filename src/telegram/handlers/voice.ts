import { Context, InputFile } from "grammy";
import { log } from "../../logger.js";
import { injectInput } from "../../session/tmux.js";
import { transcribeAudio, synthesizeSpeech, polishTranscript, sanitizeForTts } from "../../voice.js";
import { narrate } from "../../narrator.js";
import { sendMarkdownReply } from "../utils.js";
import { launchedPaneId } from "./sessions.js";
import { ensureSession, snapshotBaseline, startInjectionWatcher } from "./text.js";
import type { SessionResponseState } from "../../session/monitor.js";
import { access } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

const POLISH_VOICE_OFF_PATH = join(homedir(), ".codewhispr", "polish-voice-off");

async function isVoicePolishEnabled(): Promise<boolean> {
  try {
    await access(POLISH_VOICE_OFF_PATH);
    return false; // flag file exists → polish off
  } catch {
    return true; // flag file absent → polish on (default)
  }
}

export async function handleVoice(ctx: Context, chatId: number, token: string): Promise<void> {
  await ctx.replyWithChatAction("record_voice");

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

  if (!attached) {
    const msg = "No session attached. Use /sessions to pick one.";
    const audioReply = await synthesizeSpeech(sanitizeForTts(msg));
    await ctx.replyWithVoice(new InputFile(audioReply, "reply.mp3"));
    return;
  }

  const preBaseline = await snapshotBaseline(attached.cwd);
  const injected = transcript ? `${polished}\n\n[transcribed from voice, may contain inaccuracies]` : polished;

  log({ chatId, message: `inject: ${injected.slice(0, 80)}` });
  const result = await injectInput(attached.cwd, injected, launchedPaneId);

  if (!result.found) {
    const msg = "No Claude Code running at this session. Start it, or use /sessions to switch.";
    const audioReply = await synthesizeSpeech(sanitizeForTts(msg));
    await ctx.replyWithVoice(new InputFile(audioReply, "reply.mp3"));
    return;
  }

  if (transcript) {
    await ctx.reply(`[transcription] ${polished}`);
    log({ chatId, direction: "out", message: `[transcription] ${polished.slice(0, 80)}` });
  }
  await ctx.replyWithChatAction("typing");
  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction("typing").catch(() => {});
  }, 4000);

  const allBlocks: string[] = [];

  const voiceResponseHandler = async (state: SessionResponseState) => {
    await sendMarkdownReply(ctx, `\`[claude-code][${state.projectName}]\` ${state.text.replace(/:$/m, "")}`).catch((err) => {
      log({ chatId, message: `stream text error: ${err instanceof Error ? err.message : String(err)}` });
    });
    log({ chatId, direction: "out", message: `[stream] ${state.text.slice(0, 80)}` });
    allBlocks.push(state.text);
  };

  const voiceCompleteHandler = () => {
    clearInterval(typingInterval);
    if (allBlocks.length === 0) return;
    narrate(allBlocks.join("\n\n"), polished)
      .then((summary) => synthesizeSpeech(sanitizeForTts(summary)).then((audio) => {
        ctx.replyWithVoice(new InputFile(audio, "reply.mp3"));
        log({ chatId, direction: "out", message: `[voice response] ${summary.slice(0, 80)}` });
      }))
      .catch((err) => {
        log({ chatId, message: `Voice response error: ${err instanceof Error ? err.message : String(err)}` });
      });
  };

  await startInjectionWatcher(attached, chatId, voiceResponseHandler, voiceCompleteHandler, preBaseline);
}
