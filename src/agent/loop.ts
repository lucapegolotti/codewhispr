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

export function clearChatState(chatId: number): void {
  chatState.delete(chatId);
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

  const agentReply = (text: string) => `\`[agent]\` ${text}`;

  switch (intent) {
    case Intent.SUMMARY_REQUEST: {
      reply = agentReply(await summarizeSession());
      break;
    }

    case Intent.FOLLOW_UP_INPUT: {
      if (cwd) {
        const result = await injectInput(cwd, userMessage);
        if (result.found) {
          reply = `__INJECTED__`;
        } else if (result.reason === "ambiguous") {
          reply = `No Claude Code running in the attached project. Start Claude Code there, or use /sessions to switch.`;
        } else {
          // No tmux pane found — fall back to agent turn
          reply = agentReply(await runAgentTurn(chatId, userMessage));
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
          reply = `No Claude Code running in the attached project. Start Claude Code there, or use /sessions to switch.`;
        } else {
          reply = agentReply(await runAgentTurn(chatId, userMessage));
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
          reply = `No Claude Code running in the attached project. Start Claude Code there, or use /sessions to switch.`;
        } else {
          // No tmux pane found — fall back to Agent SDK
          reply = agentReply(await runAgentTurn(chatId, userMessage));
        }
      } else {
        reply = await runAgentTurn(chatId, userMessage);
      }
      break;
    }
  }

  // Don't store sentinel values — they would corrupt intent context for the next turn
  if (reply !== "__INJECTED__" && reply !== "__SESSION_PICKER__") {
    chatState.set(chatId, { lastBotMessage: reply, lastCwd: state?.lastCwd });
  }
  return reply;
}
