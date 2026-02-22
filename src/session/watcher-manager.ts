import { log } from "../logger.js";
import { ATTACHED_SESSION_PATH, getLatestSessionFileForCwd } from "./history.js";
import { watchForResponse, getFileSize } from "./monitor.js";
import { notifyResponse, notifyImages, sendPing } from "../telegram/notifications.js";
import type { SessionResponseState, DetectedImage } from "./monitor.js";
import { writeFile } from "fs/promises";

type PendingImagesMap = Map<string, DetectedImage[]>;

export class WatcherManager {
  private activeStop: (() => void) | null = null;
  private activeOnComplete: (() => void) | null = null;
  private compactPollGeneration = 0;
  private pendingImages: PendingImagesMap;

  constructor(pendingImages: PendingImagesMap) {
    this.pendingImages = pendingImages;
  }

  get isActive(): boolean {
    return this.activeStop !== null;
  }

  clear(): void {
    this.activeStop?.();
    this.activeStop = null;
    this.activeOnComplete = null;
  }

  /** Stop the current watcher and fire its onComplete (for interrupt flow). */
  stopAndFlush(): void {
    if (this.activeStop) {
      this.activeStop();
      this.activeStop = null;
      this.activeOnComplete?.();
      this.activeOnComplete = null;
    }
  }

  async snapshotBaseline(
    cwd: string
  ): Promise<{ filePath: string; sessionId: string; size: number } | null> {
    const latest = await getLatestSessionFileForCwd(cwd);
    if (!latest) return null;
    const size = await getFileSize(latest.filePath);
    return { ...latest, size };
  }

  async startInjectionWatcher(
    attached: { sessionId: string; cwd: string },
    chatId: number,
    onResponse?: (state: SessionResponseState) => Promise<void>,
    onComplete?: () => void,
    preBaseline?: { filePath: string; sessionId: string; size: number } | null
  ): Promise<void> {
    // Stop any watcher from a previous injection and flush its completion so the
    // previous turn's voice summary is still generated even when a new message
    // interrupts before the result event fires.
    this.stopAndFlush();

    // Increment generation so any in-flight compaction polls from a previous
    // injection know to abort.
    const myGeneration = ++this.compactPollGeneration;

    let filePath: string;
    let latestSessionId: string;
    let baseline: number;

    if (preBaseline) {
      ({ filePath, sessionId: latestSessionId, size: baseline } = preBaseline);
    } else {
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
    this.activeOnComplete = onComplete ?? null;
    const watchedCwd = attached.cwd;
    const pendingImages = this.pendingImages;

    this.activeStop = watchForResponse(
      filePath,
      baseline,
      wrappedOnResponse,
      () => sendPing("⏳ Still working..."),
      () => {
        this.compactPollGeneration++;  // abort any active rotation poll
        this.activeOnComplete = null;
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
    void this.pollForPostCompactionSession(myGeneration, watchedCwd, filePath, onResponse, onComplete);
  }

  private async pollForPostCompactionSession(
    generation: number,
    cwd: string,
    oldFilePath: string,
    onResponse?: (state: SessionResponseState) => Promise<void>,
    onComplete?: () => void
  ): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 3_000));
      if (this.compactPollGeneration !== generation) return;

      const latest = await getLatestSessionFileForCwd(cwd);
      if (latest && latest.filePath !== oldFilePath) {
        log({ message: `post-compact: new session found ${latest.sessionId.slice(0, 8)}, restarting watcher` });
        await writeFile(ATTACHED_SESSION_PATH, `${latest.sessionId}\n${cwd}`, "utf8").catch(() => {});
        this.activeStop?.();  // stop old chokidar watcher before replacing
        this.activeOnComplete = onComplete ?? null;
        this.activeStop = watchForResponse(
          latest.filePath,
          0,
          async (state) => { await (onResponse ?? notifyResponse)(state); },
          () => sendPing("⏳ Still working..."),
          () => {
            this.activeOnComplete = null;
            onComplete?.();
          }
        );
        return;
      }
    }
    log({ message: `post-compact: no new session found for ${cwd} after 60s` });
    onComplete?.();
  }
}
