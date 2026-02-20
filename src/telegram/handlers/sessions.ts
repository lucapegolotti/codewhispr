import { Context, InlineKeyboard } from "grammy";
import { listSessions } from "../../session/history.js";

export const pendingSessions = new Map<string, { sessionId: string; cwd: string; projectName: string }>();

export let launchedPaneId: string | undefined;

export function setLaunchedPaneId(id: string | undefined): void {
  launchedPaneId = id;
}

export function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds <= 0) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export async function sendSessionPicker(ctx: Context): Promise<void> {
  const sessions = await listSessions();
  if (sessions.length === 0) {
    await ctx.reply("No sessions found.");
    return;
  }

  const keyboard = new InlineKeyboard();
  pendingSessions.clear();
  for (const s of sessions) {
    pendingSessions.set(s.sessionId, s);
    keyboard.text(`${s.projectName} · ${timeAgo(s.mtime)}`, `session:${s.sessionId}`).row();
  }

  const lines = sessions.map((s) => {
    const preview = s.lastMessage ? `  "${s.lastMessage}"` : "  (no messages)";
    return `• ${s.projectName} · ${timeAgo(s.mtime)}\n${preview}`;
  });

  await ctx.reply(`Available sessions:\n\n${lines.join("\n\n")}`, { reply_markup: keyboard });
}
