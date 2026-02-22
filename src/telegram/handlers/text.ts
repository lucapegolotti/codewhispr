import { Context } from "grammy";
import { handleTurn, clearChatState } from "../../agent/loop.js";
import { log } from "../../logger.js";
import { ATTACHED_SESSION_PATH, getAttachedSession, listSessions, getLatestSessionFileForCwd } from "../../session/history.js";
import { watchForResponse, getFileSize } from "../../session/monitor.js";
import { notifyResponse, notifyImages, sendPing } from "../notifications.js";
import { sendMarkdownReply } from "../utils.js";
import { sendSessionPicker, launchedPaneId } from "./sessions.js";
import { findClaudePane, sendInterrupt } from "../../session/tmux.js";
import type { SessionResponseState, DetectedImage } from "../../session/monitor.js";
import { pendingImages, pendingImageCount, clearPendingImageCount } from "./callbacks/index.js";
import { InputFile } from "grammy";
import { writeFile, mkdir, readFile } from "fs/promises";
import { homedir } from "os";
import { WatcherManager } from "../../session/watcher-manager.js";

// Singleton watcher manager — shared with commands.ts via re-exports
export const watcherManager = new WatcherManager(pendingImages);

// Re-export for backwards compatibility with existing consumers
export const snapshotBaseline = (cwd: string) => watcherManager.snapshotBaseline(cwd);
export const startInjectionWatcher = (
  attached: { sessionId: string; cwd: string },
  chatId: number,
  onResponse?: (state: SessionResponseState) => Promise<void>,
  onComplete?: () => void,
  preBaseline?: { filePath: string; sessionId: string; size: number } | null
) => watcherManager.startInjectionWatcher(attached, chatId, onResponse, onComplete, preBaseline);
export function clearActiveWatcher(): void { watcherManager.clear(); }

// Ask Claude Code for image files it created and offer them via the image picker.
// Used by the /images command.
export async function fetchAndOfferImages(cwd: string): Promise<void> {
  const result = await (await import("../../session/tmux.js")).injectInput(
    cwd,
    "List only the absolute file paths of image files you created in this session, one per line. Reply with ONLY the paths, nothing else."
  );
  if (!result.found) return;

  const latest = await getLatestSessionFileForCwd(cwd);
  if (!latest) return;
  const baseline = await getFileSize(latest.filePath);

  await new Promise<void>((resolve) => {
    const stop = watchForResponse(
      latest.filePath,
      baseline,
      async (state) => {
        stop();
        const paths = state.text
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => /^\/\S+\.(png|jpg|jpeg|gif|webp)$/i.test(l));

        const images: DetectedImage[] = [];
        for (const p of paths) {
          try {
            const buf = await readFile(p);
            const ext = p.split(".").pop()!.toLowerCase();
            const mediaType = ext === "jpg" || ext === "jpeg" ? "image/jpeg"
              : ext === "gif" ? "image/gif"
              : ext === "webp" ? "image/webp"
              : "image/png";
            images.push({ mediaType, data: buf.toString("base64") });
          } catch { /* file not found — skip */ }
        }

        if (images.length > 0) {
          const key = `${Date.now()}`;
          pendingImages.set(key, images);
          await notifyImages(images, key);
        } else {
          await (await import("../notifications.js")).sendPing("No image files found.");
        }
        resolve();
      },
      undefined,
      () => resolve()
    );
    setTimeout(resolve, 30_000);
  });
}

export async function ensureSession(
  ctx: Context,
  chatId: number
): Promise<{ sessionId: string; cwd: string } | null> {
  const existing = await getAttachedSession();
  if (existing) return existing;

  const recent = await listSessions(1);
  if (recent.length === 0) return null;

  const s = recent[0];
  await mkdir(`${homedir()}/.codewhispr`, { recursive: true });
  await writeFile(ATTACHED_SESSION_PATH, `${s.sessionId}\n${s.cwd}`, "utf8");
  clearChatState(chatId);
  await ctx.reply(`Auto-attached to \`${s.projectName}\`.`, { parse_mode: "Markdown" });
  return { sessionId: s.sessionId, cwd: s.cwd };
}

export async function processTextTurn(ctx: Context, chatId: number, text: string): Promise<void> {
  // Handle "Part" image count reply
  if (pendingImageCount) {
    const parsed = parseInt(text.trim(), 10);
    if (!isNaN(parsed) && parsed >= 1) {
      const { key, max } = pendingImageCount;
      clearPendingImageCount();
      const n = Math.min(parsed, max);
      const images = pendingImages.get(key);
      if (images) {
        pendingImages.delete(key);
        // Shuffle and pick n at random
        const shuffled = [...images].sort(() => Math.random() - 0.5).slice(0, n);
        for (const img of shuffled) {
          const buf = Buffer.from(img.data, "base64");
          const ext = img.mediaType.split("/")[1] ?? "jpg";
          const file = new InputFile(buf, `image.${ext}`);
          await ctx.replyWithPhoto(file).catch(async () => {
            await ctx.replyWithDocument(file).catch(() => {});
          });
        }
      }
      return;
    }
    // Not a number — fall through to normal message handling
    clearPendingImageCount();
  }

  const attached = await ensureSession(ctx, chatId);

  // If Claude is currently processing (active watcher), interrupt it with Ctrl+C
  // so the new message takes effect immediately instead of queuing after the current turn.
  if (watcherManager.isActive && attached) {
    const pane = await findClaudePane(attached.cwd);
    if (pane.found) {
      log({ message: `Interrupting Claude Code (Ctrl+C) for new message` });
      // Stop old watcher first so it doesn't process the interrupt's result event
      watcherManager.stopAndFlush();
      await sendInterrupt(pane.paneId);
      // Wait for Claude to write interrupted state to JSONL before snapshotting baseline
      await new Promise((r) => setTimeout(r, 600));
    }
  }

  // Snapshot file position BEFORE injection — avoids missing fast responses where
  // Claude writes to the JSONL before startInjectionWatcher reads the file size.
  const preBaseline = attached ? await watcherManager.snapshotBaseline(attached.cwd) : null;
  const reply = await handleTurn(chatId, text, undefined, attached?.cwd, launchedPaneId);

  if (reply === "__SESSION_PICKER__") {
    await sendSessionPicker(ctx);
    return;
  }

  if (reply === "__INJECTED__") {
    await ctx.replyWithChatAction("typing");
    const typingInterval = setInterval(() => {
      ctx.replyWithChatAction("typing").catch(() => {});
    }, 4000);
    if (attached) {
      await watcherManager.startInjectionWatcher(attached, chatId, undefined, () => clearInterval(typingInterval), preBaseline);
    } else {
      clearInterval(typingInterval);
    }
    return;
  }

  log({ chatId, direction: "out", message: reply });
  await sendMarkdownReply(ctx, reply);
}
