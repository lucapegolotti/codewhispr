import Anthropic from "@anthropic-ai/sdk";
import { getAttachedSession, getSessionFilePath, readSessionLines, parseJsonlLines } from "../session/history.js";
import { log } from "../logger.js";

let anthropic: Anthropic | null = null;
function getClient(): Anthropic {
  return (anthropic ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));
}

const SYSTEM = `Summarize the current state of a Claude Code coding session.

Be concise and actionable. Cover:
- What task is currently being worked on
- What actions were taken recently (files edited, commands run)
- Any errors encountered
- Whether there is a pending prompt waiting for input
- What would logically come next

Plain text only. No markdown, no bullet points, no headers. 3-6 sentences maximum.`;

export async function summarizeSession(sessionId?: string): Promise<string> {
  const attached = await getAttachedSession();
  const targetId = sessionId ?? attached?.sessionId;

  if (!targetId) {
    return "No session is currently attached. Use /sessions to pick one.";
  }

  const filePath = await getSessionFilePath(targetId);
  if (!filePath) {
    return "Could not find the session file. The session may have been cleared.";
  }

  const allLines = await readSessionLines(filePath);
  const recentLines = allLines.slice(-60);
  const parsed = parseJsonlLines(recentLines);

  if (parsed.allMessages.length === 0 && parsed.toolCalls.length === 0) {
    return "The session exists but has no readable history yet.";
  }

  const toolSummary = parsed.toolCalls
    .slice(-10)
    .map((t) => `${t.name}(${JSON.stringify(t.input).slice(0, 60)})`)
    .join(", ");

  const context = [
    parsed.allMessages.length > 0
      ? `Recent assistant messages:\n${parsed.allMessages.slice(-5).join("\n\n")}`
      : "",
    toolSummary ? `Recent tool calls: ${toolSummary}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const response = await getClient().messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      system: SYSTEM,
      messages: [{ role: "user", content: context }],
    });
    const block = response.content[0];
    if (block.type !== "text") throw new Error("Unexpected summarizer response");
    return block.text;
  } catch (err) {
    log({ message: `summarizer error: ${err instanceof Error ? err.message : String(err)}` });
    return `Last message: ${parsed.lastMessage || "(none)"}`;
  }
}
