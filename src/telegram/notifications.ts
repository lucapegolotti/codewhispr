import { Bot, InlineKeyboard } from "grammy";
import { WaitingType, type SessionWaitingState } from "../session/monitor.js";
import { log } from "../logger.js";

let registeredBot: Bot | null = null;
let registeredChatId: number | null = null;

export function registerForNotifications(bot: Bot, chatId: number): void {
  registeredBot = bot;
  registeredChatId = chatId;
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

export function resolveWaitingAction(callbackData: string): string | null {
  const map: Record<string, string> = {
    "waiting:yes": "y",
    "waiting:no": "n",
    "waiting:enter": "",
  };
  return callbackData in map ? map[callbackData] : null;
}
