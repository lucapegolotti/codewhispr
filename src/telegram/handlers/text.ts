import { Context } from "grammy";
import { handleTurn, clearChatState } from "../../agent/loop.js";
import { log } from "../../logger.js";
import { ATTACHED_SESSION_PATH, getAttachedSession, listSessions, getLatestSessionFileForCwd } from "../../session/history.js";
import { watchForResponse, getFileSize } from "../../session/monitor.js";
import { notifyResponse, notifyImages, sendPing } from "../notifications.js";
import { sendMarkdownReply } from "../utils.js";
import { sendSessionPicker, launchedPaneId } from "./sessions.js";
import type { SessionResponseState, DetectedImage } from "../../session/monitor.js";
import { pendingImages, pendingImageCount, clearPendingImageCount } from "./callbacks.js";
import { InputFile } from "grammy";
import { writeFile, mkdir, readFile, stat } from "fs/promises";
import { homedir } from "os";
// After a turn completes, scan Bash tool_result outputs for image file paths.
// When a script prints something like "/tmp/chart.png", we detect and offer it.
// Only images created/modified after startTime are included to avoid false positives
// from pre-existing files whose paths happen to appear in tool output.
async function scanForScriptImages(filePath: string, baseline: number, startTime: number): Promise<void> {
  const buf = await readFile(filePath).catch(() => null);
  if (!buf) return;
  const lines = buf.subarray(baseline).toString("utf8").split("\n").filter(Boolean);
  const seenPaths = new Set<string>();
  const images: DetectedImage[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "user") continue;
      const content: unknown[] = entry.message?.content ?? [];
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b["type"] !== "tool_result") continue;
        // Only look at text tool_results (Bash stdout), not image ones
        const text = typeof b["content"] === "string" ? b["content"] : null;
        if (!text) continue;
        for (const rawLine of text.split("\n")) {
          const candidate = rawLine.trim();
          // Require an absolute path with no spaces to avoid false positives
          if (/^\/\S+\.(png|jpg|jpeg|gif|webp)$/i.test(candidate) && !seenPaths.has(candidate)) {
            seenPaths.add(candidate);
            try {
              const fileStat = await stat(candidate);
              // Skip files that predate this turn — they weren't created by this session
              if (fileStat.mtimeMs < startTime) continue;
              const imgBuf = await readFile(candidate);
              const ext = candidate.split(".").pop()!.toLowerCase();
              const mediaType =
                ext === "jpg" || ext === "jpeg" ? "image/jpeg" :
                ext === "gif" ? "image/gif" :
                ext === "webp" ? "image/webp" : "image/png";
              images.push({ mediaType, data: imgBuf.toString("base64") });
            } catch { /* file doesn't exist — skip */ }
          }
        }
      }
    } catch { continue; }
  }

  if (images.length > 0) {
    const key = `${Date.now()}`;
    pendingImages.set(key, images);
    await notifyImages(images, key);
  }
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

  // Track whether any response text was delivered during this watch session.
  // If onComplete fires with no response delivered, a compaction may have ended
  // the turn before Claude responded — poll for the new post-compact session file.
  let responseDelivered = false;
  const wrappedOnResponse = async (state: SessionResponseState) => {
    responseDelivered = true;
    await (onResponse ?? notifyResponse)(state);
  };

  log({ message: `watchForResponse started for ${latestSessionId.slice(0, 8)}, baseline=${baseline}` });
  activeWatcherOnComplete = onComplete ?? null;
  const watchedFilePath = filePath;
  const watchedCwd = attached.cwd;
  const watcherStartTime = Date.now();
  activeWatcherStop = watchForResponse(
    filePath,
    baseline,
    wrappedOnResponse,
    () => sendPing("⏳ Still working..."),
    () => {
      activeWatcherOnComplete = null;
      onComplete?.();
      void scanForScriptImages(watchedFilePath, baseline, watcherStartTime);
      if (!responseDelivered) {
        // Result event fired but no text was delivered — silent task completion.
        void sendPing("✅ Done.");
      }
    },
    async (images: DetectedImage[]) => {
      const key = `${Date.now()}`;
      pendingImages.set(key, images);
      await notifyImages(images, key);
    }
  );
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
