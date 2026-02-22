import type { Bot, Context } from "grammy";
import { log } from "../../../logger.js";
import { ATTACHED_SESSION_PATH } from "../../../session/history.js";
import { findClaudePane, launchClaudeInWindow } from "../../../session/tmux.js";
import { pendingSessions, setLaunchedPaneId } from "../sessions.js";
import { writeFile, mkdir } from "fs/promises";
import { homedir } from "os";

export async function handleLaunchCallback(ctx: Context, data: string, bot: Bot): Promise<void> {
  if (data.startsWith("launch:cancel:")) {
    await ctx.answerCallbackQuery({ text: "Cancelled." });
    await ctx.editMessageReplyMarkup();
    return;
  }

  const skipPermissions = data.startsWith("launch:skip:");
  const sessionId = skipPermissions
    ? data.slice("launch:skip:".length)
    : data.slice("launch:".length);

  const session = pendingSessions.get(sessionId);
  if (!session) {
    await ctx.answerCallbackQuery({ text: "Session not found — try /sessions again." });
    return;
  }

  let paneId: string;
  try {
    paneId = await launchClaudeInWindow(session.cwd, session.projectName, skipPermissions);
  } catch (err) {
    await ctx.answerCallbackQuery({ text: "Failed to launch tmux window." });
    log({ message: `launchClaudeInWindow error: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }

  await mkdir(`${homedir()}/.codewhispr`, { recursive: true });
  await writeFile(ATTACHED_SESSION_PATH, `${session.sessionId}\n${session.cwd}`, "utf8");
  setLaunchedPaneId(paneId);

  await ctx.answerCallbackQuery({ text: "Launched!" });
  const flag = skipPermissions ? " with `--dangerously-skip-permissions`" : "";
  await ctx.editMessageText(
    `Launching Claude Code${flag} at \`${session.projectName}\`… I'll notify you when it's ready.`,
    { parse_mode: "Markdown" }
  );

  // Poll in the background until Claude Code's pane is detectable, then notify.
  const chatId = ctx.chat!.id;
  const projectName = session.projectName;
  const cwd = session.cwd;
  (async () => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const found = await findClaudePane(cwd).catch(() => ({ found: false as const, reason: "no_tmux" as const }));
      if (found.found) {
        await bot.api.sendMessage(chatId, `✅ Claude Code is ready at \`${projectName}\`. Send your first message.`, { parse_mode: "Markdown" });
        return;
      }
    }
    await bot.api.sendMessage(chatId, `⚠️ Claude Code at \`${projectName}\` didn't start within 60s — check the tmux window.`, { parse_mode: "Markdown" });
  })().catch((err) => log({ message: `launch ready-poll error: ${err instanceof Error ? err.message : String(err)}` }));
}
