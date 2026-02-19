import { classifyIntent, Intent } from "./classifier.js";
import { summarizeSession } from "./summarizer.js";
import { runAgentTurn } from "../session/adapter.js";
import { injectInput } from "../session/tmux.js";
import { log } from "../logger.js";

// Per-chat state: tracks last bot message for FOLLOW_UP_INPUT context
const chatState = new Map<number, { lastBotMessage: string; lastCwd?: string }>();

export function updateChatState(chatId: number, lastBotMessage: string, cwd?: string): void {
  chatState.set(chatId, { lastBotMessage, lastCwd: cwd });
}

export async function handleTurn(
  chatId: number,
  userMessage: string,
  lastBotMessage?: string,
  knownCwd?: string
): Promise<string> {
  const state = chatState.get(chatId);
  const contextMessage = lastBotMessage ?? state?.lastBotMessage;
  const cwd = knownCwd ?? state?.lastCwd;

  const intent = await classifyIntent(userMessage, contextMessage);
  log({ chatId, message: `intent: ${intent}` });

  let reply: string;

  switch (intent) {
    case Intent.SUMMARY_REQUEST: {
      reply = await summarizeSession();
      break;
    }

    case Intent.FOLLOW_UP_INPUT: {
      if (cwd) {
        const result = await injectInput(cwd, userMessage);
        if (result.found) {
          reply = `__INJECTED__`;
        } else if (result.reason === "ambiguous") {
          reply = `Multiple Claude sessions found. Please use /sessions to attach to the right one first.`;
        } else {
          // No tmux pane found — fall back to agent turn
          reply = await runAgentTurn(chatId, userMessage);
        }
      } else {
        reply = await runAgentTurn(chatId, userMessage);
      }
      break;
    }

    case Intent.GENERAL_CHAT: {
      if (cwd) {
        const result = await injectInput(cwd, userMessage);
        if (result.found) {
          reply = `__INJECTED__`;
        } else if (result.reason === "ambiguous") {
          reply = `Multiple Claude sessions found. Please use /sessions to attach to the right one first.`;
        } else {
          reply = await runAgentTurn(chatId, userMessage);
        }
      } else {
        reply = "No session attached. Use /sessions to pick one, or send a command.";
      }
      break;
    }

    case Intent.SESSION_LIST: {
      // Signal to bot.ts to show the session picker
      reply = "__SESSION_PICKER__";
      break;
    }

    case Intent.COMMAND_EXECUTION:
    case Intent.UNKNOWN:
    default: {
      if (cwd) {
        const result = await injectInput(cwd, userMessage);
        if (result.found) {
          reply = `__INJECTED__`;
        } else if (result.reason === "ambiguous") {
          reply = `Multiple Claude sessions found. Please use /sessions to attach to the right one first.`;
        } else {
          // No tmux pane found — fall back to Agent SDK
          reply = await runAgentTurn(chatId, userMessage);
        }
      } else {
        reply = await runAgentTurn(chatId, userMessage);
      }
      break;
    }
  }

  // Only persist cwd from internal state (not from caller-supplied knownCwd)
  chatState.set(chatId, { lastBotMessage: reply, lastCwd: state?.lastCwd });
  return reply;
}
