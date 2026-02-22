import type { Context } from "grammy";
import { log } from "../../../logger.js";
import { getAttachedSession } from "../../../session/history.js";
import { respondToPermission } from "../../../session/permissions.js";
import { findClaudePane, sendKeysToPane, sendRawKeyToPane } from "../../../session/tmux.js";

export async function handlePermissionCallback(ctx: Context, data: string): Promise<void> {
  const parts = data.split(":");
  const action = parts[1];
  const requestId = parts.slice(2).join(":");
  if (!requestId || (action !== "approve" && action !== "deny")) {
    await ctx.answerCallbackQuery({ text: "Invalid permission request." });
    return;
  }
  await respondToPermission(requestId, action === "deny" ? "deny" : "approve").catch((err) => {
    log({ message: `respondToPermission error: ${err instanceof Error ? err.message : String(err)}` });
  });
  // Also send the matching key to the Claude Code tmux pane so the terminal
  // permission dialog is dismissed even if the user is looking at the terminal.
  const attachedForPerm = await getAttachedSession().catch(() => null);
  if (attachedForPerm) {
    const pane = await findClaudePane(attachedForPerm.cwd).catch(() => ({ found: false as const, reason: "no_tmux" as const }));
    if (pane.found) {
      if (action === "approve") {
        await sendKeysToPane(pane.paneId, "1").catch(() => {});
      } else {
        await sendRawKeyToPane(pane.paneId, "Escape").catch(() => {});
      }
    }
  }
  await ctx.answerCallbackQuery({ text: action === "deny" ? "Denied ❌" : "Approved ✅" });
  await ctx.editMessageReplyMarkup().catch(() => {});
}
