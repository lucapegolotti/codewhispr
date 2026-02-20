import { Bot, InlineKeyboard } from "grammy";
import { WaitingType, type SessionWaitingState, type SessionResponseState } from "../session/monitor.js";
import type { PermissionRequest } from "../session/permissions.js";
import { getAttachedSession } from "../session/history.js";
import { log } from "../logger.js";
import { writeFile, readFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

const CLAUDE_VOICE_DIR = join(homedir(), ".claude-voice");
const CHAT_ID_PATH = join(CLAUDE_VOICE_DIR, "chat-id");

let registeredBot: Bot | null = null;
let registeredChatId: number | null = null;

export function splitMessage(text: string, limit = 4000): string[] {
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

async function sendMarkdownMessage(bot: Bot, chatId: number, text: string): Promise<void> {
  for (const chunk of splitMessage(text)) {
    try {
      await bot.api.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
    } catch {
      await bot.api.sendMessage(chatId, chunk);
    }
  }
}

export async function sendPing(text: string): Promise<void> {
  if (!registeredBot || !registeredChatId) return;
  await registeredBot.api.sendMessage(registeredChatId, text).catch(() => {});
}

export function registerForNotifications(bot: Bot, chatId: number): void {
  registeredBot = bot;
  registeredChatId = chatId;
  mkdir(CLAUDE_VOICE_DIR, { recursive: true })
    .then(() => writeFile(CHAT_ID_PATH, String(chatId), "utf8"))
    .catch(() => {});
}

export async function sendStartupMessage(bot: Bot): Promise<void> {
  let chatId: number;
  try {
    const raw = await readFile(CHAT_ID_PATH, "utf8");
    chatId = parseInt(raw.trim(), 10);
    if (!Number.isFinite(chatId)) return;
  } catch {
    return; // no saved chat ID yet
  }
  await bot.api.sendMessage(chatId, "claude-voice started.").catch(() => {});
}

function buildWaitingKeyboard(waitingType: WaitingType): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (waitingType === WaitingType.YES_NO) {
    kb.text("Yes", "waiting:yes").text("No", "waiting:no").row();
  } else if (waitingType === WaitingType.ENTER) {
    kb.text("Continue ↩", "waiting:enter").row();
  }
  kb.text("Send custom input", "waiting:custom").text("Ignore", "waiting:ignore");
  return kb;
}

export async function notifyWaiting(state: SessionWaitingState): Promise<void> {
  if (!registeredBot || !registeredChatId) return;

  const prompt = state.prompt.slice(0, 200);
  const text = `⚠️ Claude is waiting in \`${state.projectName}\`:\n\n_"${prompt}"_`;
  const keyboard = buildWaitingKeyboard(state.waitingType);

  try {
    await registeredBot.api.sendMessage(registeredChatId, text, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
    log({ chatId: registeredChatId, message: `notified: ${state.projectName} waiting (${state.waitingType})` });
  } catch (err) {
    log({ message: `failed to send waiting notification: ${err instanceof Error ? err.message : String(err)}` });
  }
}

export async function notifyResponse(state: SessionResponseState): Promise<void> {
  if (!registeredBot || !registeredChatId) return;

  // Only notify for the attached session to avoid spam from other projects
  const attached = await getAttachedSession().catch(() => null);
  if (!attached || attached.sessionId !== state.sessionId) return;

  const text = `\`[claude-code][${state.projectName}]\` ${state.text.replaceAll(";", ".")}`;
  try {
    await sendMarkdownMessage(registeredBot, registeredChatId, text);
    log({ chatId: registeredChatId, message: `notified response: ${state.projectName} (${state.text.slice(0, 60)})` });
  } catch (err) {
    log({ message: `failed to send response notification: ${err instanceof Error ? err.message : String(err)}` });
  }
}

export async function notifyPermission(req: PermissionRequest): Promise<void> {
  if (!registeredBot || !registeredChatId) return;

  // Only show the command for Bash — other tools (Task, etc.) produce verbose JSON
  const commandLine = req.toolName === "Bash" && req.toolCommand
    ? `\n\`\`\`\n${req.toolCommand}\n\`\`\``
    : "";
  const text = `🔐 *Claude needs your permission to use ${req.toolName}*${commandLine}`;
  const keyboard = new InlineKeyboard()
    .text("Yes", `perm:approve:${req.requestId}`)
    .text("No", `perm:deny:${req.requestId}`);

  try {
    await registeredBot.api.sendMessage(registeredChatId, text, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
    log({ chatId: registeredChatId, message: `permission notification: ${req.toolName} (${req.requestId.slice(0, 8)})` });
  } catch {
    try {
      await registeredBot.api.sendMessage(
        registeredChatId,
        req.toolInput,
        { reply_markup: keyboard }
      );
    } catch (err) {
      log({ message: `failed to send permission notification: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
}

export function resolveWaitingAction(callbackData: string): string | null {
  const map: Record<string, string> = {
    "waiting:yes": "y",
    "waiting:no": "n",
    "waiting:enter": "",
  };
  return callbackData in map ? map[callbackData] : null;
}
