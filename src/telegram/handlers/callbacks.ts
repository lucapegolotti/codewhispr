import { Bot, InlineKeyboard } from "grammy";
import { clearChatState } from "../../agent/loop.js";
import { log } from "../../logger.js";
import { ATTACHED_SESSION_PATH, getAttachedSession } from "../../session/history.js";
import { findClaudePane, injectInput, sendKeysToPane, sendRawKeyToPane, launchClaudeInWindow, killWindow } from "../../session/tmux.js";
import { resolveWaitingAction } from "../notifications.js";
import { respondToPermission } from "../../session/permissions.js";
import { pendingSessions, setLaunchedPaneId } from "./sessions.js";
import { startInjectionWatcher } from "./text.js";
import { writeFile, mkdir } from "fs/promises";
import { homedir } from "os";

export function registerCallbacks(bot: Bot): void {
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    if (data.startsWith("waiting:")) {
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
          const result = await injectInput(attached.cwd, input);
          if (result.found) {
            await ctx.answerCallbackQuery({ text: "Sent!" });
            await ctx.reply(`Sent "${input || "↩"}". Claude is resuming.`);
            await startInjectionWatcher(attached, ctx.chat!.id, undefined, undefined);
          } else {
            await ctx.answerCallbackQuery({ text: "Could not find tmux pane." });
          }
        } else {
          await ctx.answerCallbackQuery({ text: "No attached session." });
        }
      }
      return;
    }

    if (data.startsWith("perm:")) {
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
      // Remove buttons by clearing reply markup — editMessageText can fail silently
      // when the original message contains JSON/special chars in a code block.
      await ctx.editMessageReplyMarkup().catch(() => {});
      return;
    }

    if (data.startsWith("session:")) {
      const sessionId = data.slice("session:".length);
      const session = pendingSessions.get(sessionId);
      if (!session) {
        await ctx.answerCallbackQuery({ text: "Session not found — try /sessions again." });
        return;
      }

      // Check whether Claude Code is already running at this cwd
      const pane = await findClaudePane(session.cwd).catch(() => ({ found: false as const, reason: "no_tmux" as const }));

      if (pane.found) {
        // Claude Code is running — attach immediately
        await mkdir(`${homedir()}/.claude-voice`, { recursive: true });
        await writeFile(ATTACHED_SESSION_PATH, `${session.sessionId}\n${session.cwd}`, "utf8");
        setLaunchedPaneId(undefined); // clear any stale launched pane
        clearChatState(ctx.chat!.id);
        await ctx.answerCallbackQuery({ text: "Attached!" });
        await ctx.reply(`Attached to \`${session.projectName}\`. Send your first message.`, {
          parse_mode: "Markdown",
        });
      } else {
        // No running pane — offer to launch
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
      return;
    }

    if (data.startsWith("launch:")) {
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

      // Attach to this project's cwd — sessionId will be discovered lazily by the watcher
      await mkdir(`${homedir()}/.claude-voice`, { recursive: true });
      await writeFile(ATTACHED_SESSION_PATH, `${session.sessionId}\n${session.cwd}`, "utf8");
      setLaunchedPaneId(paneId); // fallback for injection while Claude Code initializes
      clearChatState(ctx.chat!.id);

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

      return;
    }

    if (data.startsWith("detach:")) {
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
        return;
      }
    }
  });
}
