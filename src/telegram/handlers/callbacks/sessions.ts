import { type Context, InlineKeyboard } from "grammy";
import { ATTACHED_SESSION_PATH } from "../../../session/history.js";
import { findClaudePane } from "../../../session/tmux.js";
import { pendingSessions, setLaunchedPaneId } from "../sessions.js";
import { writeFile, mkdir } from "fs/promises";
import { homedir } from "os";

export async function handleSessionCallback(ctx: Context, data: string): Promise<void> {
  const sessionId = data.slice("session:".length);
  const session = pendingSessions.get(sessionId);
  if (!session) {
    await ctx.answerCallbackQuery({ text: "Session not found — try /sessions again." });
    return;
  }

  const pane = await findClaudePane(session.cwd).catch(() => ({ found: false as const, reason: "no_tmux" as const }));

  if (pane.found) {
    await mkdir(`${homedir()}/.codewhispr`, { recursive: true });
    await writeFile(ATTACHED_SESSION_PATH, `${session.sessionId}\n${session.cwd}`, "utf8");
    setLaunchedPaneId(undefined);
    await ctx.answerCallbackQuery({ text: "Attached!" });
    await ctx.reply(`Attached to \`${session.projectName}\`. Send your first message.`, {
      parse_mode: "Markdown",
    });
  } else {
    await ctx.answerCallbackQuery();
    const keyboard = new InlineKeyboard()
      .text("Launch", `launch:${sessionId}`)
      .text("Launch (skip permissions)", `launch:skip:${sessionId}`)
      .row()
      .text("Cancel", `launch:cancel:${sessionId}`);
    await ctx.reply(
      `No Claude Code running at \`${session.projectName}\`. Launch one?`,
      { parse_mode: "Markdown", reply_markup: keyboard }
    );
  }
}
