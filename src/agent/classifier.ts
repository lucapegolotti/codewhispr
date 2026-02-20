import Anthropic from "@anthropic-ai/sdk";

export enum Intent {
  SUMMARY_REQUEST = "SUMMARY_REQUEST",
  COMMAND_EXECUTION = "COMMAND_EXECUTION",
  FOLLOW_UP_INPUT = "FOLLOW_UP_INPUT",
  GENERAL_CHAT = "GENERAL_CHAT",
  SESSION_LIST = "SESSION_LIST",
  UNKNOWN = "UNKNOWN",
}

let anthropic: Anthropic | null = null;
function getClient(): Anthropic {
  return (anthropic ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));
}

const SYSTEM = `Classify the user message into exactly one of these intents. Respond with the intent name only, no punctuation, no explanation.

SUMMARY_REQUEST — explicitly asking for a recap or summary of the session (e.g. "summarize", "what have we done so far", "give me a recap", "tldr")
COMMAND_EXECUTION — asking Claude to do something or check something: run code, edit files, install deps, fix bugs, check git status, verify changes, answer questions about the project
FOLLOW_UP_INPUT — a short reply to a pending prompt (y, n, yes, no, ok, continue, a number, a filename)
GENERAL_CHAT — greeting, thanks, or small talk unrelated to any project or coding task
SESSION_LIST — asking to list, pick, switch, or attach to a Claude Code session
UNKNOWN — anything else`;

export function parseIntentResponse(raw: string): Intent {
  const normalized = raw.trim().toUpperCase();
  const valid = Object.values(Intent) as string[];
  if (valid.includes(normalized)) return normalized as Intent;
  return Intent.UNKNOWN;
}

export async function classifyIntent(
  userMessage: string,
  lastBotMessage?: string
): Promise<Intent> {
  const context = lastBotMessage
    ? `Previous bot message: "${lastBotMessage}"\n\nUser message: "${userMessage}"`
    : `User message: "${userMessage}"`;

  try {
    const response = await getClient().messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      system: SYSTEM,
      messages: [{ role: "user", content: context }],
    });
    const block = response.content[0];
    if (block.type !== "text") return Intent.UNKNOWN;
    return parseIntentResponse(block.text);
  } catch {
    return Intent.UNKNOWN;
  }
}
