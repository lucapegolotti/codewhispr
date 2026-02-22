import type { Context } from "grammy";
import { getAttachedSession } from "../../../session/history.js";
import { findClaudePane, sendKeysToPane } from "../../../session/tmux.js";

export async function handleModelCallback(ctx: Context, data: string): Promise<void> {
  const modelId = data.slice("model:".length);
  const attached = await getAttachedSession().catch(() => null);
  if (!attached) {
    await ctx.answerCallbackQuery({ text: "No session attached." });
    return;
  }
  const pane = await findClaudePane(attached.cwd).catch(() => ({ found: false as const, reason: "no_tmux" as const }));
  if (!pane.found) {
    await ctx.answerCallbackQuery({ text: "Could not find the Claude Code tmux pane." });
    return;
  }
  await sendKeysToPane(pane.paneId, `/model ${modelId}`);
  await ctx.answerCallbackQuery({ text: `Switched to ${modelId}` });
  await ctx.editMessageText(`Model set to \`${modelId}\`.`, { parse_mode: "Markdown" });
}
