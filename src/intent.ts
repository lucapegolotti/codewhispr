import Anthropic from "@anthropic-ai/sdk";

let anthropic: Anthropic | null = null;
function getClient(): Anthropic {
  return (anthropic ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));
}

const SYSTEM = `You classify user messages. Answer with a single word: "sessions" if the message is asking to see a list of available Claude Code sessions or to pick/switch/connect to a session, otherwise "other". No punctuation, no explanation.`;

export async function detectSessionListIntent(text: string): Promise<boolean> {
  const response = await getClient().messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 5,
    system: SYSTEM,
    messages: [{ role: "user", content: text }],
  });
  const block = response.content[0];
  if (block.type !== "text") return false;
  return block.text.trim().toLowerCase().startsWith("sessions");
}
