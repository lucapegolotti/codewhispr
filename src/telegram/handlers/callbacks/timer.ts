import type { Context } from "grammy";
import { setTimerSetup } from "../timer.js";

export async function handleTimerCallback(ctx: Context, data: string): Promise<void> {
  if (data === "timer:confirm") {
    setTimerSetup({ phase: "awaiting_frequency" });
    await ctx.answerCallbackQuery({ text: "OK!" });
    await ctx.reply("How often (in minutes)?");
    return;
  }

  if (data === "timer:cancel") {
    setTimerSetup(null);
    await ctx.answerCallbackQuery({ text: "Cancelled." });
    return;
  }
}
