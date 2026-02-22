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
import { pendingImages, pendingImageCount, clearPendingImageCount } from "./callbacks.js";
import { InputFile } from "grammy";
import { writeFile, mkdir, readFile } from "fs/promises";
import { homedir } from "os";
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

export let activeWatcherStop: (() => void) | null = null;
export let activeWatcherOnComplete: (() => void) | null = null;
let compactPollGeneration = 0;

export function clearActiveWatcher(): void {
  activeWatcherStop?.();
  activeWatcherStop = null;
  activeWatcherOnComplete = null;
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

// Snapshot the active session file and its current byte offset before injection.
// Pass this to startInjectionWatcher so the baseline is set before Claude responds,
// avoiding a race where a fast response is written before the watcher is set up.
export async function snapshotBaseline(
  cwd: string
): Promise<{ filePath: string; sessionId: string; size: number } | null> {
  const latest = await getLatestSessionFileForCwd(cwd);
  if (!latest) return null;
  const size = await getFileSize(latest.filePath);
  return { ...latest, size };
}

export async function startInjectionWatcher(
  attached: { sessionId: string; cwd: string },
  chatId: number,
  onResponse?: (state: SessionResponseState) => Promise<void>,
  onComplete?: () => void,
  preBaseline?: { filePath: string; sessionId: string; size: number } | null
): Promise<void> {
  // Stop any watcher from a previous injection and flush its completion so the
  // previous turn's voice summary is still generated even when a new message
  // interrupts before the result event fires.
  if (activeWatcherStop) {
    activeWatcherStop();
    activeWatcherStop = null;
    activeWatcherOnComplete?.();
    activeWatcherOnComplete = null;
  }

  // Increment generation so any in-flight compaction polls from a previous
  // injection know to abort.
  const myGeneration = ++compactPollGeneration;

  let filePath: string;
  let latestSessionId: string;
  let baseline: number;

  if (preBaseline) {
    // Use the pre-injection snapshot — baseline was recorded before Claude responded
    ({ filePath, sessionId: latestSessionId, size: baseline } = preBaseline);
  } else {
    // No pre-snapshot: find the session file now (fallback for waiting-prompt injections)
    const latest = await getLatestSessionFileForCwd(attached.cwd);
    if (!latest) {
      log({ message: `watchForResponse: could not find JSONL for cwd ${attached.cwd}` });
      onComplete?.();
      return;
    }
    filePath = latest.filePath;
    latestSessionId = latest.sessionId;
    baseline = await getFileSize(filePath);
  }

  // If Claude Code restarted and created a new session, update the attached record
  // so notifyResponse (which checks sessionId match) sends to the right session.
  if (latestSessionId !== attached.sessionId) {
    log({ message: `watchForResponse: session rotated ${attached.sessionId.slice(0, 8)} → ${latestSessionId.slice(0, 8)}, updating attached` });
    await writeFile(ATTACHED_SESSION_PATH, `${latestSessionId}\n${attached.cwd}`, "utf8").catch(() => {});
  }

  let responseDelivered = false;
  const wrappedOnResponse = async (state: SessionResponseState) => {
    await (onResponse ?? notifyResponse)(state);
    responseDelivered = true;
  };

  log({ message: `watchForResponse started for ${latestSessionId.slice(0, 8)}, baseline=${baseline}` });
  activeWatcherOnComplete = onComplete ?? null;
  const watchedCwd = attached.cwd;
  activeWatcherStop = watchForResponse(
    filePath,
    baseline,
    wrappedOnResponse,
    () => sendPing("⏳ Still working..."),
    () => {
      compactPollGeneration++;  // abort any active rotation poll
      activeWatcherOnComplete = null;
      onComplete?.();
      if (!responseDelivered) void sendPing("✅ Done.");
    },
    async (images: DetectedImage[]) => {
      const key = `${Date.now()}`;
      pendingImages.set(key, images);
      await notifyImages(images, key);
    }
  );

  // Start polling for session rotation (compaction / plan approval) in the background.
  void pollForPostCompactionSession(myGeneration, watchedCwd, filePath, onResponse, onComplete);
}

// After a compaction, Claude Code restarts with a new JSONL file. Poll until we
// find a different session file for the same cwd, then restart watching on it.
async function pollForPostCompactionSession(
  generation: number,
  cwd: string,
  oldFilePath: string,
  onResponse?: (state: SessionResponseState) => Promise<void>,
  onComplete?: () => void
): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 3_000));
    // Abort if a new message injection started a fresh watcher generation.
    if (compactPollGeneration !== generation) return;

    const latest = await getLatestSessionFileForCwd(cwd);
    if (latest && latest.filePath !== oldFilePath) {
      log({ message: `post-compact: new session found ${latest.sessionId.slice(0, 8)}, restarting watcher` });
      await writeFile(ATTACHED_SESSION_PATH, `${latest.sessionId}\n${cwd}`, "utf8").catch(() => {});
      activeWatcherStop?.();  // stop old chokidar watcher before replacing
      activeWatcherOnComplete = onComplete ?? null;
      activeWatcherStop = watchForResponse(
        latest.filePath,
        0,
        async (state) => { await (onResponse ?? notifyResponse)(state); },
        () => sendPing("⏳ Still working..."),
        () => {
          activeWatcherOnComplete = null;
          onComplete?.();
        }
      );
      return;
    }
  }
  log({ message: `post-compact: no new session found for ${cwd} after 60s` });
  onComplete?.();
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
  if (activeWatcherStop && attached) {
    const pane = await findClaudePane(attached.cwd);
    if (pane.found) {
      log({ message: `Interrupting Claude Code (Ctrl+C) for new message` });
      // Stop old watcher first so it doesn't process the interrupt's result event
      activeWatcherStop();
      activeWatcherStop = null;
      activeWatcherOnComplete?.();   // clears the old typing interval
      activeWatcherOnComplete = null;
      await sendInterrupt(pane.paneId);
      // Wait for Claude to write interrupted state to JSONL before snapshotting baseline
      await new Promise((r) => setTimeout(r, 600));
    }
  }

  // Snapshot file position BEFORE injection — avoids missing fast responses where
  // Claude writes to the JSONL before startInjectionWatcher reads the file size.
  const preBaseline = attached ? await snapshotBaseline(attached.cwd) : null;
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
      await startInjectionWatcher(attached, chatId, undefined, () => clearInterval(typingInterval), preBaseline);
    } else {
      clearInterval(typingInterval);
    }
    return;
  }

  log({ chatId, direction: "out", message: reply });
  await sendMarkdownReply(ctx, reply);
}
