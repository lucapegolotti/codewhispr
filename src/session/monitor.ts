import chokidar from "chokidar";
import { readFile, stat } from "fs/promises";
import { PROJECTS_PATH } from "./history.js";
import { log } from "../logger.js";
import { parseAssistantText, extractCwd, findResultEvent, findExitPlanMode, extractWrittenImagePaths } from "./jsonl.js";

export enum WaitingType {
  YES_NO = "YES_NO",
  ENTER = "ENTER",
  MULTIPLE_CHOICE = "MULTIPLE_CHOICE",
}

export type SessionWaitingState = {
  sessionId: string;
  projectName: string;
  cwd: string;
  filePath: string;
  waitingType: WaitingType;
  prompt: string;
  choices?: string[];
};

export type WaitingCallback = (state: SessionWaitingState) => Promise<void>;

export type SessionResponseState = {
  sessionId: string;
  projectName: string;
  cwd: string;
  filePath: string;
  text: string;
  model?: string;
};

export type ResponseCallback = (state: SessionResponseState) => Promise<void>;

export type DetectedImage = { mediaType: string; data: string };
export type ImagesCallback = (images: DetectedImage[]) => Promise<void>;

const YES_NO_PATTERNS = [/\(y\/n\)/i, /\[y\/N\]/i, /confirm\?/i];
const ENTER_PATTERNS = [/press\s+enter/i, /hit\s+enter/i];

export function classifyWaitingType(text: string): WaitingType | null {
  const trimmed = text.trim();

  if (YES_NO_PATTERNS.some((p) => p.test(trimmed))) return WaitingType.YES_NO;
  if (ENTER_PATTERNS.some((p) => p.test(trimmed))) return WaitingType.ENTER;

  return null;
}


function decodeProjectName(dir: string): string {
  const encoded = dir.replace(/^-/, "").replace(/-/g, "/");
  return encoded.split("/").pop() || dir;
}

export async function getLastAssistantEntry(filePath: string): Promise<{
  text: string | null;
  hasExitPlanMode: boolean;
  planText: string | null;
}> {
  try {
    const content = await readFile(filePath, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    const { text } = parseAssistantText(lines);
    const { found: hasExitPlanMode, planText } = findExitPlanMode(lines);
    return { text, hasExitPlanMode, planText };
  } catch {
    // file unreadable
  }
  return { text: null, hasExitPlanMode: false, planText: null };
}

function sessionIdFromPath(filePath: string): { sessionId: string; projectDir: string } {
  const parts = filePath.split("/");
  const filename = parts[parts.length - 1];
  const projectDir = parts[parts.length - 2];
  return { sessionId: filename.replace(".jsonl", ""), projectDir };
}

const DEBOUNCE_MS = 3000;

export function startMonitor(onWaiting: WaitingCallback, watchPath: string = PROJECTS_PATH): () => void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // Track last text we notified per file to avoid duplicate notifications
  const lastNotified = new Map<string, string>();
  // Track when each entry was last updated so we can sweep stale entries
  const lastNotifiedTime = new Map<string, number>();

  // Sweep stale entries every 10 minutes to prevent unbounded growth
  const SWEEP_INTERVAL = 10 * 60_000;
  const SWEEP_MAX_AGE = 60 * 60_000; // 1 hour
  const sweepId = setInterval(() => {
    const now = Date.now();
    for (const [key, time] of lastNotifiedTime) {
      if (now - time > SWEEP_MAX_AGE) {
        lastNotified.delete(key);
        lastNotifiedTime.delete(key);
      }
    }
  }, SWEEP_INTERVAL);

  // Watch the directory directly — chokidar glob patterns don't reliably
  // fire change events on macOS for files in ~/.claude/projects subdirs.
  const watcher = chokidar.watch(watchPath, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: false,
    depth: 2,
  });

  watcher.on("change", (filePath: string) => {
    if (!filePath.endsWith(".jsonl")) return;
    const existing = timers.get(filePath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      timers.delete(filePath);

      const { text: lastText, hasExitPlanMode, planText } = await getLastAssistantEntry(filePath);

      // Dedup: for ExitPlanMode use planText as the stable key (lastText can
      // change if more content lands in the file after the initial event,
      // which would cause a spurious second notification with the old approach).
      // For waiting prompts, key on the prompt text itself.
      const dedupKey = hasExitPlanMode
        ? `exit|${planText ?? ""}`
        : `${lastText ?? ""}`;
      if (lastNotified.get(filePath) === dedupKey) return;
      // Only update dedup after we know there's something actionable
      // (checked below) — prevents suppressing future events on no-op visits.

      const { sessionId, projectDir } = sessionIdFromPath(filePath);
      const projectName = decodeProjectName(projectDir);

      let cwd = "";
      try {
        const content = await readFile(filePath, "utf8");
        const allLines = content.trim().split("\n").filter(Boolean);
        cwd = extractCwd(allLines) ?? "";
      } catch {
        // ignore
      }

      const waitingType = lastText ? classifyWaitingType(lastText) : null;

      if (waitingType) {
        lastNotified.set(filePath, dedupKey);
        lastNotifiedTime.set(filePath, Date.now());
        log({ message: `session ${sessionId.slice(0, 8)} waiting (${waitingType}): ${lastText!.slice(0, 80)}` });
        await onWaiting({ sessionId, projectName, cwd, filePath, waitingType, prompt: lastText! }).catch(
          (err) => log({ message: `notification error: ${err instanceof Error ? err.message : String(err)}` })
        );
      } else if (hasExitPlanMode) {
        // ExitPlanMode is detected in the JSONL — the plan approval choices are
        // always the same fixed set, so we fire immediately without pane capture.
        lastNotified.set(filePath, dedupKey);
        lastNotifiedTime.set(filePath, Date.now());
        const choices = [
          "Yes, clear context and bypass permissions",
          "Yes, bypass permissions",
          "Yes, manually approve edits",
          "Type here to tell Claude what to change",
        ];
        log({ message: `session ${sessionId.slice(0, 8)} ExitPlanMode detected, cwd=${cwd}` });
        await onWaiting({
          sessionId, projectName, cwd, filePath,
          waitingType: WaitingType.MULTIPLE_CHOICE,
          prompt: planText ?? lastText ?? "",
          choices,
        }).catch(
          (err) => log({ message: `notification error: ${err instanceof Error ? err.message : String(err)}` })
        );
      }
      // else: no actionable signal — skip without updating dedup so we can
      // react if the file is updated again with new content.
    }, DEBOUNCE_MS);

    timers.set(filePath, timer);
  });

  watcher.on("error", (err: unknown) => {
    log({ message: `monitor error: ${err instanceof Error ? err.message : String(err)}` });
  });

  return () => {
    watcher.close();
    clearInterval(sweepId);
    for (const t of timers.values()) clearTimeout(t);
  };
}

// Watches a specific JSONL file for new assistant text after a given byte offset.
// Fires onResponse immediately for each new text block (no debounce — the Stop
// hook's result event is the authoritative signal for turn completion).
// When the result event is detected, any unsent last text is delivered first,
// then onComplete is called.
export function watchForResponse(
  filePath: string,
  baselineSize: number,
  onResponse: ResponseCallback,
  onPing?: () => void,
  onComplete?: () => void,
  onImages?: ImagesCallback
): () => void {
  const parts = filePath.split("/");
  const sessionId = parts[parts.length - 1].replace(".jsonl", "");
  const projectDir = parts[parts.length - 2];
  const projectName = decodeProjectName(projectDir);
  const cwd = parts.slice(0, -2).join("/"); // approximation; real cwd read from file

  let done = false;
  let lastSentText: string | null = null;
  let completionScheduled = false;
  const detectedImages: DetectedImage[] = [];
  // Image files written via the Write tool (detected by file extension)
  const writtenImagePaths = new Set<string>();
  // Tracks an in-flight onResponse promise so the complete path can await it
  // before calling onComplete, preventing a race where two rapid chokidar events
  // cause onComplete to fire while onResponse is still awaiting the Telegram API.
  let pendingResponse: Promise<void> = Promise.resolve();

  const watcher = chokidar.watch(filePath, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: false,
  });

  const cleanup = () => {
    clearTimeout(pingId);
    clearTimeout(maxLifetimeId);
    watcher.close();
  };

  const pingId = setTimeout(() => {
    if (!done && lastSentText === null) onPing?.();
  }, 60_000);

  // Safety timeout: if no result event arrives within 10 minutes, clean up
  // to prevent leaked watchers from accumulating indefinitely.
  const MAX_LIFETIME = 10 * 60_000;
  const maxLifetimeId = setTimeout(() => {
    if (done) return;
    done = true;
    cleanup();
    log({ message: `watchForResponse: session ${sessionId.slice(0, 8)} timed out after ${MAX_LIFETIME / 60_000}min` });
    onComplete?.();
  }, MAX_LIFETIME);

  watcher.on("change", () => {
    if (done) return;

    readFile(filePath)
      .then(async (buf) => {
        if (done) return;
        const newContent = buf.subarray(baselineSize).toString("utf8");
        const lines = newContent.split("\n").filter(Boolean);

        // Find the latest assistant text written so far
        const parsed = parseAssistantText(lines);
        const latestText = parsed.text;
        const latestCwd = parsed.cwd ?? cwd;
        const latestModel = parsed.model;

        // Collect image files written via the Write tool
        if (onImages) {
          for (const fp of extractWrittenImagePaths(lines)) {
            writtenImagePaths.add(fp);
          }
        }

        // Detect Claude Code turn completion via the result event (written by Stop hook)
        const isComplete = findResultEvent(lines);

        if (isComplete && !completionScheduled) {
          completionScheduled = true;
          // Send any text visible right now, then wait briefly before closing.
          // The Stop hook writes the result event concurrently with Claude Code
          // flushing the final JSONL entry — a short delay lets that write land
          // so we don't miss the last text block.
          if (latestText && latestText !== lastSentText) {
            lastSentText = latestText;
            log({ message: `watchForResponse firing for session ${sessionId.slice(0, 8)}: ${latestText.slice(0, 60)}` });
            pendingResponse = onResponse({ sessionId, projectName, cwd: latestCwd, filePath, text: latestText, model: latestModel }).catch(
              (err) => log({ message: `watchForResponse callback error: ${err instanceof Error ? err.message : String(err)}` })
            );
            await pendingResponse;
          }
          setTimeout(async () => {
            if (done) return;
            done = true;
            cleanup();
            // Final read — catch any text written after the result event
            try {
              const finalBuf = await readFile(filePath);
              const finalLines = finalBuf.subarray(baselineSize).toString("utf8").split("\n").filter(Boolean);
              const final = parseAssistantText(finalLines);
              if (final.text && final.text !== lastSentText) {
                lastSentText = final.text;
                log({ message: `watchForResponse final-flush for session ${sessionId.slice(0, 8)}: ${final.text.slice(0, 60)}` });
                await onResponse({ sessionId, projectName, cwd: final.cwd ?? cwd, filePath, text: final.text, model: final.model }).catch(
                  (err) => log({ message: `watchForResponse callback error: ${err instanceof Error ? err.message : String(err)}` })
                );
              }
            } catch { /* file unreadable */ }
            await pendingResponse;
            log({ message: `watchForResponse: session ${sessionId.slice(0, 8)} completed (result event)` });
            onComplete?.();
            if (onImages) {
              // Read any image files written via Write tool and add to detected list
              for (const imgPath of writtenImagePaths) {
                try {
                  const imgBuf = await readFile(imgPath);
                  const ext = imgPath.split(".").pop()!.toLowerCase();
                  const mediaType = ext === "jpg" || ext === "jpeg" ? "image/jpeg"
                    : ext === "gif" ? "image/gif"
                    : ext === "webp" ? "image/webp"
                    : "image/png";
                  detectedImages.push({ mediaType, data: imgBuf.toString("base64") });
                } catch { /* file unreadable — skip */ }
              }
              if (detectedImages.length > 0) {
                await onImages(detectedImages).catch(
                  (err) => log({ message: `watchForResponse onImages error: ${err instanceof Error ? err.message : String(err)}` })
                );
              }
            }
          }, 500);
          return;
        }

        // No new text, or already sent — nothing to do
        if (!latestText || latestText === lastSentText) return;

        // Fire immediately — no debounce needed since the Stop hook signals completion
        lastSentText = latestText;
        log({ message: `watchForResponse firing for session ${sessionId.slice(0, 8)}: ${latestText.slice(0, 60)}` });
        pendingResponse = onResponse({ sessionId, projectName, cwd: latestCwd, filePath, text: latestText, model: latestModel }).catch(
          (err) => log({ message: `watchForResponse callback error: ${err instanceof Error ? err.message : String(err)}` })
        );
        await pendingResponse;
      })
      .catch(() => {
        // file unreadable — keep watching
      });
  });

  watcher.on("error", (err: unknown) => {
    log({ message: `watchForResponse error: ${err instanceof Error ? err.message : String(err)}` });
  });

  return () => {
    done = true;
    cleanup();
  };
}

export async function getFileSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return 0;
  }
}
