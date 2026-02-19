import Anthropic from "@anthropic-ai/sdk";

let anthropic: Anthropic | null = null;
function getClient(): Anthropic {
  return (anthropic ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));
}

const SYSTEM = `You relay what a coding agent responded. Convert the output to plain text suitable for a Telegram message or voice playback.

Rules:
- No markdown, no code blocks, no bullet points, no headers
- No greetings, openers ("Sure!", "Got it!", "Great!"), sign-offs, or filler
- Length should match the content — short if the answer is short, long if the answer requires it
- If the agent ran commands or edited files, describe what it did and what the results were
- If the agent answered a question, relay the answer directly and completely
- Preserve technical details accurately: file names, error messages, line numbers, command output
- If there were errors, state them plainly`;

export async function narrate(agentResult: string): Promise<string> {
  try {
    const response = await getClient().messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: SYSTEM,
      messages: [{ role: "user", content: agentResult }],
    });
    if (response.content.length === 0) throw new Error("Narrator returned empty content");
    const block = response.content[0];
    if (block.type !== "text") throw new Error("Unexpected narrator response type");
    return block.text;
  } catch (err) {
    throw new Error(`Narrator failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
