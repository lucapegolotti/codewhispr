import { Bot, InlineKeyboard } from "grammy";
import { WaitingType, type SessionWaitingState, type SessionResponseState, type DetectedImage } from "../session/monitor.js";
import type { PermissionRequest } from "../session/permissions.js";
import { getAttachedSession } from "../session/history.js";
import { log } from "../logger.js";
import { writeFile, readFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { sendMarkdownMessage } from "./utils.js";

const CODEWHISPR_DIR = join(homedir(), ".codewhispr");
const CHAT_ID_PATH = join(CODEWHISPR_DIR, "chat-id");

let registeredBot: Bot | null = null;
let registeredChatId: number | null = null;

export async function sendPing(text: string): Promise<void> {
  if (!registeredBot || !registeredChatId) return;
  await registeredBot.api.sendMessage(registeredChatId, text).catch(() => {});
}

export function registerForNotifications(bot: Bot, chatId: number): void {
  registeredBot = bot;
  registeredChatId = chatId;
  mkdir(CODEWHISPR_DIR, { recursive: true })
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
    return;
  }
  const attached = await getAttachedSession().catch(() => null);
  const sessionMsg = attached
    ? `Attached: \`${attached.sessionId.slice(0, 8)}…\``
    : "No session attached — use /sessions to pick one.";
  try {
    await bot.api.sendMessage(chatId, `codewhispr started\\. ${sessionMsg}`, { parse_mode: "MarkdownV2" });
  } catch {
    await bot.api.sendMessage(chatId, `codewhispr started. ${attached ? "Attached: " + attached.sessionId.slice(0, 8) : "No session attached."}`).catch(() => {});
  }
}

function buildWaitingKeyboard(waitingType: WaitingType, choices?: string[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (waitingType === WaitingType.YES_NO) {
    kb.text("Yes", "waiting:yes").text("No", "waiting:no").row();
  } else if (waitingType === WaitingType.ENTER) {
    kb.text("Continue ↩", "waiting:enter").row();
  } else if (waitingType === WaitingType.MULTIPLE_CHOICE && choices) {
    for (let i = 0; i < choices.length; i++) {
      const label = choices[i].length > 40 ? choices[i].slice(0, 38) + "…" : choices[i];
      kb.text(`${i + 1}. ${label}`, `waiting:choice:${i + 1}`).row();
    }
  }
  kb.text("Send custom input", "waiting:custom").text("Ignore", "waiting:ignore");
  return kb;
}

export async function notifyWaiting(state: SessionWaitingState): Promise<void> {
  if (!registeredBot || !registeredChatId) return;

  const prompt = state.prompt.slice(0, 200);
  const text = `⚠️ Claude is waiting in \`${state.projectName}\`:\n\n_"${prompt}"_`;
  const keyboard = buildWaitingKeyboard(state.waitingType, state.choices);

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

  const text = `\`${state.projectName}:\` ${state.text.replaceAll(";", ".").replaceAll(":", ".")}`;
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

export async function notifyImages(images: DetectedImage[], key: string): Promise<void> {
  if (!registeredBot || !registeredChatId) return;
  const n = images.length;
  const keyboard = new InlineKeyboard()
    .text(`All (${n})`, `images:send:all:${key}`)
    .text("Part", `images:part:${key}`)
    .text("None", `images:skip:${key}`);
  await registeredBot.api.sendMessage(
    registeredChatId,
    `📸 Found ${n} image${n === 1 ? "" : "s"} in this response. Send ${n === 1 ? "it" : "them"}?`,
    { reply_markup: keyboard }
  ).catch((err) => log({ message: `notifyImages error: ${err instanceof Error ? err.message : String(err)}` }));
}

export function resolveWaitingAction(callbackData: string): string | null {
  const map: Record<string, string> = {
    "waiting:yes": "y",
    "waiting:no": "n",
    "waiting:enter": "",
  };
  if (callbackData in map) return map[callbackData];
  const choiceMatch = callbackData.match(/^waiting:choice:(\d+)$/);
  if (choiceMatch) return choiceMatch[1];
  return null;
}
