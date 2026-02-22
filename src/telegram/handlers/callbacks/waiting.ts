import type { Context } from "grammy";
import { getAttachedSession } from "../../../session/history.js";
import { injectInput } from "../../../session/tmux.js";
import { resolveWaitingAction } from "../../notifications.js";
import { startInjectionWatcher, snapshotBaseline } from "../text.js";

export async function handleWaitingCallback(ctx: Context, data: string): Promise<void> {
  if (data === "waiting:ignore") {
    await ctx.answerCallbackQuery({ text: "Ignored." });
    return;
  }
  if (data === "waiting:custom") {
    await ctx.answerCallbackQuery({ text: "Send your input as a text message." });
    return;
  }
  const input = resolveWaitingAction(data);
  if (input !== null) {
    const attached = await getAttachedSession();
    if (attached) {
      const preBaseline = await snapshotBaseline(attached.cwd);
      const result = await injectInput(attached.cwd, input);
      if (result.found) {
        await ctx.answerCallbackQuery({ text: "Sent!" });
        await ctx.reply(`Sent "${input || "↩"}". Claude is resuming.`);
        await startInjectionWatcher(attached, ctx.chat!.id, undefined, undefined, preBaseline);
      } else {
        await ctx.answerCallbackQuery({ text: "Could not find tmux pane." });
      }
    } else {
      await ctx.answerCallbackQuery({ text: "No attached session." });
    }
  }
}
