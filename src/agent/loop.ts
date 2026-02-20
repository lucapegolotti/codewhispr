import { injectInput } from "../session/tmux.js";
import { log } from "../logger.js";

// no-op: chat state removed in zero-cost routing refactor
export function clearChatState(_chatId: number): void {}

export async function handleTurn(
  chatId: number,
  userMessage: string,
  _lastBotMessage?: string,
  knownCwd?: string,
  fallbackPaneId?: string
): Promise<string> {
  if (!knownCwd) {
    return "No session attached. Use /sessions to pick one.";
  }

  log({ chatId, message: `inject: ${userMessage.slice(0, 80)}` });
  const result = await injectInput(knownCwd, userMessage, fallbackPaneId);
  if (result.found) {
    return "__INJECTED__";
  }
  return "No Claude Code running at this session. Start it, or use /sessions to switch.";
}
