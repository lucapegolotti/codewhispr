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

// Plan approval text is handled by notifyWaiting — skip here to avoid sending
// a buttonless duplicate before the proper waiting notification arrives.
const PLAN_APPROVAL_RE = /needs your approval for the plan/i;

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

export class NotificationService {
  private bot: Bot | null = null;
  private chatId: number | null = null;

  register(bot: Bot, chatId: number): void {
    this.bot = bot;
    this.chatId = chatId;
    mkdir(CODEWHISPR_DIR, { recursive: true })
      .then(() => writeFile(CHAT_ID_PATH, String(chatId), "utf8"))
      .catch(() => {});
  }

  async sendPing(text: string): Promise<void> {
    if (!this.bot || !this.chatId) return;
    await sendMarkdownMessage(this.bot, this.chatId, text);
  }

  async notifyWaiting(state: SessionWaitingState): Promise<void> {
    if (!this.bot || !this.chatId) return;

    const keyboard = buildWaitingKeyboard(state.waitingType, state.choices);

    try {
      if (state.prompt) {
        await sendMarkdownMessage(this.bot, this.chatId, state.prompt);
      }
      const header = `⚠️ Claude is waiting in \`${state.projectName}\`:`;
      await this.bot.api.sendMessage(this.chatId, header, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
      });
      log({ chatId: this.chatId, message: `notified: ${state.projectName} waiting (${state.waitingType})` });
    } catch (err) {
      log({ message: `failed to send waiting notification: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  async notifyResponse(state: SessionResponseState): Promise<void> {
    if (!this.bot || !this.chatId) return;
    if (PLAN_APPROVAL_RE.test(state.text)) return;

    const attached = await getAttachedSession().catch(() => null);
    if (!attached || attached.sessionId !== state.sessionId) return;

    const modelSuffix = state.model ? ` (${friendlyModelName(state.model)})` : "";
    const text = `\`${state.projectName}${modelSuffix}:\` ${state.text.replace(/:$/m, "")}`;
    try {
      await sendMarkdownMessage(this.bot, this.chatId, text);
      log({ chatId: this.chatId, message: `notified response: ${state.projectName} (${state.text.slice(0, 60)})` });
    } catch (err) {
      log({ message: `failed to send response notification: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  async notifyPermission(req: PermissionRequest): Promise<void> {
    if (!this.bot || !this.chatId) return;

    const commandLine = req.toolName === "Bash" && req.toolCommand
      ? `\n\`\`\`\n${req.toolCommand}\n\`\`\``
      : "";
    const text = `🔐 *Claude needs your permission to use ${req.toolName}*${commandLine}`;
    const keyboard = new InlineKeyboard()
      .text("Yes", `perm:approve:${req.requestId}`)
      .text("No", `perm:deny:${req.requestId}`);

    try {
      await this.bot.api.sendMessage(this.chatId, text, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
      });
      log({ chatId: this.chatId, message: `permission notification: ${req.toolName} (${req.requestId.slice(0, 8)})` });
    } catch {
      try {
        await this.bot.api.sendMessage(
          this.chatId,
          req.toolInput,
          { reply_markup: keyboard }
        );
      } catch (err) {
        log({ message: `failed to send permission notification: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
  }

  async notifyImages(images: DetectedImage[], key: string): Promise<void> {
    if (!this.bot || !this.chatId) return;
    const n = images.length;
    const keyboard = new InlineKeyboard()
      .text(`All (${n})`, `images:send:all:${key}`)
      .text("Part", `images:part:${key}`)
      .text("None", `images:skip:${key}`);
    await this.bot.api.sendMessage(
      this.chatId,
      `📸 Found ${n} image${n === 1 ? "" : "s"} in this response. Send ${n === 1 ? "it" : "them"}?`,
      { reply_markup: keyboard }
    ).catch((err) => log({ message: `notifyImages error: ${err instanceof Error ? err.message : String(err)}` }));
  }
}

// Singleton instance
export const notifications = new NotificationService();

// ---------------------------------------------------------------------------
// Module-level exports — thin wrappers for backwards compatibility
// ---------------------------------------------------------------------------

export function registerForNotifications(bot: Bot, chatId: number): void {
  notifications.register(bot, chatId);
}

export async function sendPing(text: string): Promise<void> {
  return notifications.sendPing(text);
}

export async function notifyWaiting(state: SessionWaitingState): Promise<void> {
  return notifications.notifyWaiting(state);
}

export async function notifyResponse(state: SessionResponseState): Promise<void> {
  return notifications.notifyResponse(state);
}

export async function notifyPermission(req: PermissionRequest): Promise<void> {
  return notifications.notifyPermission(req);
}

export async function notifyImages(images: DetectedImage[], key: string): Promise<void> {
  return notifications.notifyImages(images, key);
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

/**
 * Convert a model ID to a compact friendly name.
 */
export function friendlyModelName(modelId: string): string {
  const bare = modelId.replace(/^claude-/, "");
  const parts = bare.split("-");

  const nameParts: string[] = [];
  const versionParts: string[] = [];
  let seenNumeric = false;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/^\d+$/.test(parts[i])) {
      versionParts.unshift(parts[i]);
      seenNumeric = true;
    } else {
      nameParts.unshift(...parts.slice(0, i + 1));
      break;
    }
  }
  if (!seenNumeric) return bare;

  if (versionParts.length > 0 && versionParts[versionParts.length - 1].length >= 8) {
    versionParts.pop();
  }

  const name = nameParts.join("-");
  const version = versionParts.join(".");
  return version ? `${name} ${version}` : name;
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
