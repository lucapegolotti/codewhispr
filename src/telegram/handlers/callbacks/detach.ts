import type { Context } from "grammy";
import { log } from "../../../logger.js";
import { killWindow } from "../../../session/tmux.js";

export async function handleDetachCallback(ctx: Context, data: string): Promise<void> {
  if (data === "detach:keep") {
    await ctx.answerCallbackQuery({ text: "Kept open." });
    await ctx.editMessageReplyMarkup();
    return;
  }
  if (data.startsWith("detach:close:")) {
    const paneId = data.slice("detach:close:".length);
    await killWindow(paneId).catch((err) => {
      log({ message: `killWindow error: ${err instanceof Error ? err.message : String(err)}` });
    });
    await ctx.answerCallbackQuery({ text: "Closed." });
    await ctx.editMessageText("Detached. tmux window closed.");
  }
}
