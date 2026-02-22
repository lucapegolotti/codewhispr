import chokidar from "chokidar";
import { readFile, stat } from "fs/promises";
import { PROJECTS_PATH } from "./history.js";
import { log } from "../logger.js";
import { findClaudePane, capturePaneContent } from "./tmux.js";

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

// Extract numbered choices from a tmux pane capture.
// Matches lines like "> 1. Some option" or "  2. Another option"
// Returns the choice labels if at least 2 are found, otherwise null.
export function parseMultipleChoices(paneContent: string): string[] | null {
  const matches = [...paneContent.matchAll(/^[\s>]*(\d+)\.\s+(.+)$/gm)];
  if (matches.length < 2) return null;
  // Verify indices are sequential starting from 1
  const indices = matches.map((m) => parseInt(m[1], 10));
  if (indices[0] !== 1) return null;
  return matches.map((m) => m[2].trim());
}

function decodeProjectName(dir: string): string {
  const encoded = dir.replace(/^-/, "").replace(/-/g, "/");
  return encoded.split("/").pop() || dir;
}

async function getLastAssistantText(filePath: string): Promise<string | null> {
  try {
    const content = await readFile(filePath, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type !== "assistant") continue;
        const textBlocks = (entry.message?.content ?? []).filter(
          (c: { type: string }) => c.type === "text"
        );
        if (textBlocks.length > 0) {
          return textBlocks[textBlocks.length - 1].text;
        }
      } catch {
        continue;
      }
    }
  } catch {
    // file unreadable
  }
  return null;
}

function sessionIdFromPath(filePath: string): { sessionId: string; projectDir: string } {
  const parts = filePath.split("/");
  const filename = parts[parts.length - 1];
  const projectDir = parts[parts.length - 2];
  return { sessionId: filename.replace(".jsonl", ""), projectDir };
}

const DEBOUNCE_MS = 3000;

export function startMonitor(onWaiting: WaitingCallback): () => void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // Track last text we notified per file to avoid duplicate notifications
  const lastNotified = new Map<string, string>();

  // Watch the directory directly — chokidar glob patterns don't reliably
  // fire change events on macOS for files in ~/.claude/projects subdirs.
  const watcher = chokidar.watch(PROJECTS_PATH, {
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

      const lastText = await getLastAssistantText(filePath);
      if (!lastText) return;

      // Skip if we already notified about this exact text
      if (lastNotified.get(filePath) === lastText) return;
      lastNotified.set(filePath, lastText);

      const { sessionId, projectDir } = sessionIdFromPath(filePath);
      const projectName = decodeProjectName(projectDir);

      let cwd = "";
      try {
        const content = await readFile(filePath, "utf8");
        const lines = content.trim().split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.type === "assistant" && entry.cwd) {
              cwd = entry.cwd;
              break;
            }
          } catch {
            continue;
          }
        }
      } catch {
        // ignore
      }

      const waitingType = classifyWaitingType(lastText);

      if (waitingType) {
        log({ message: `session ${sessionId.slice(0, 8)} waiting (${waitingType}): ${lastText.slice(0, 80)}` });
        await onWaiting({ sessionId, projectName, cwd, filePath, waitingType, prompt: lastText }).catch(
          (err) => log({ message: `notification error: ${err instanceof Error ? err.message : String(err)}` })
        );
      } else {
        // Try to detect a multiple-choice prompt from the terminal pane content.
        // Claude Code's plan approval and similar UIs render numbered options that
        // don't match the simple y/n or Enter patterns above.
        try {
          const pane = await findClaudePane(cwd);
          if (pane.found) {
            const paneText = await capturePaneContent(pane.paneId);
            const choices = parseMultipleChoices(paneText);
            if (choices) {
              log({ message: `session ${sessionId.slice(0, 8)} waiting (MULTIPLE_CHOICE): ${choices.length} choices` });
              await onWaiting({
                sessionId, projectName, cwd, filePath,
                waitingType: WaitingType.MULTIPLE_CHOICE,
                prompt: lastText,
                choices,
              }).catch(
                (err) => log({ message: `notification error: ${err instanceof Error ? err.message : String(err)}` })
              );
            }
          }
        } catch {
          // tmux not available or pane not found — skip
        }
      }
    }, DEBOUNCE_MS);

    timers.set(filePath, timer);
  });

  watcher.on("error", (err: unknown) => {
    log({ message: `monitor error: ${err instanceof Error ? err.message : String(err)}` });
  });

  return () => {
    watcher.close();
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
    watcher.close();
  };

  const pingId = setTimeout(() => {
    if (!done && lastSentText === null) onPing?.();
  }, 60_000);

  watcher.on("change", () => {
    if (done) return;

    readFile(filePath)
      .then(async (buf) => {
        if (done) return;
        const newContent = buf.subarray(baselineSize).toString("utf8");
        const lines = newContent.split("\n").filter(Boolean);

        // Find the latest assistant text written so far
        let latestText: string | null = null;
        let latestCwd = cwd;
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const entry = JSON.parse(lines[i]);
            if (entry.type !== "assistant") continue;
            const textBlocks = (entry.message?.content ?? []).filter(
              (c: { type: string }) => c.type === "text"
            );
            if (textBlocks.length === 0) continue;
            const text: string = textBlocks[textBlocks.length - 1].text;
            if (!text.trim()) continue;
            latestText = text;
            if (entry.cwd) latestCwd = entry.cwd;
            break;
          } catch {
            continue;
          }
        }

        // Collect images from tool_result blocks (deduplicated by tool_use_id + image index)
        if (onImages) {
          // Detect image files written via the Write tool
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              if (entry.type !== "assistant") continue;
              const content: unknown[] = entry.message?.content ?? [];
              for (const block of content) {
                if (typeof block !== "object" || block === null) continue;
                const b = block as Record<string, unknown>;
                if (b["type"] !== "tool_use" || b["name"] !== "Write") continue;
                const input = b["input"] as Record<string, unknown> | undefined;
                const fp = input?.["file_path"] as string | undefined;
                if (fp && /\.(png|jpg|jpeg|gif|webp)$/i.test(fp)) {
                  writtenImagePaths.add(fp);
                }
              }
            } catch { continue; }
          }
        }

        // Detect Claude Code turn completion via the result event (written by Stop hook)
        const isComplete = lines.some((line) => {
          try {
            return JSON.parse(line).type === "result";
          } catch {
            return false;
          }
        });

        if (isComplete && !completionScheduled) {
          completionScheduled = true;
          // Send any text visible right now, then wait briefly before closing.
          // The Stop hook writes the result event concurrently with Claude Code
          // flushing the final JSONL entry — a short delay lets that write land
          // so we don't miss the last text block.
          if (latestText && latestText !== lastSentText) {
            lastSentText = latestText;
            log({ message: `watchForResponse firing for session ${sessionId.slice(0, 8)}: ${latestText.slice(0, 60)}` });
            pendingResponse = onResponse({ sessionId, projectName, cwd: latestCwd, filePath, text: latestText }).catch(
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
              let finalText: string | null = null;
              let finalCwd = cwd;
              for (let i = finalLines.length - 1; i >= 0; i--) {
                try {
                  const entry = JSON.parse(finalLines[i]);
                  if (entry.type !== "assistant") continue;
                  const textBlocks = (entry.message?.content ?? []).filter(
                    (c: { type: string }) => c.type === "text"
                  );
                  if (textBlocks.length === 0) continue;
                  const text: string = textBlocks[textBlocks.length - 1].text;
                  if (!text.trim()) continue;
                  finalText = text;
                  if (entry.cwd) finalCwd = entry.cwd;
                  break;
                } catch { continue; }
              }
              if (finalText && finalText !== lastSentText) {
                lastSentText = finalText;
                log({ message: `watchForResponse final-flush for session ${sessionId.slice(0, 8)}: ${finalText.slice(0, 60)}` });
                await onResponse({ sessionId, projectName, cwd: finalCwd, filePath, text: finalText }).catch(
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
        pendingResponse = onResponse({ sessionId, projectName, cwd: latestCwd, filePath, text: latestText }).catch(
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
