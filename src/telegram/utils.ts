import type { Context, Bot } from "grammy";

export function splitMessage(text: string, limit = 4000): string[] {
  if (!text) return [];
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt <= 0) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export async function sendMarkdownReply(ctx: Context, text: string): Promise<void> {
  for (const chunk of splitMessage(text)) {
    try {
      await ctx.reply(chunk, { parse_mode: "Markdown" });
    } catch {
      await ctx.reply(chunk);
    }
  }
}

export async function sendMarkdownMessage(bot: Bot, chatId: number, text: string): Promise<void> {
  for (const chunk of splitMessage(text)) {
    try {
      await bot.api.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
    } catch {
      await bot.api.sendMessage(chatId, chunk);
    }
  }
}
