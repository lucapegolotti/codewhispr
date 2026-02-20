import chokidar from "chokidar";
import { readFile, stat } from "fs/promises";
import { PROJECTS_PATH } from "./history.js";
import { log } from "../logger.js";

export enum WaitingType {
  YES_NO = "YES_NO",
  ENTER = "ENTER",
  QUESTION = "QUESTION",
}

export type SessionWaitingState = {
  sessionId: string;
  projectName: string;
  cwd: string;
  filePath: string;
  waitingType: WaitingType;
  prompt: string;
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

const YES_NO_PATTERNS = [/\(y\/n\)/i, /\[y\/N\]/i, /confirm\?/i];
const ENTER_PATTERNS = [/press\s+enter/i, /hit\s+enter/i];

export function classifyWaitingType(text: string): WaitingType | null {
  const trimmed = text.trim();

  if (YES_NO_PATTERNS.some((p) => p.test(trimmed))) return WaitingType.YES_NO;
  if (ENTER_PATTERNS.some((p) => p.test(trimmed))) return WaitingType.ENTER;
  if (/\?\s*$/.test(trimmed) && trimmed.length > 10) return WaitingType.QUESTION;

  return null;
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
// Calls onResponse with the first new assistant text found, then stops.
// Used for targeted per-injection response tracking (avoids debounce issues
// when Claude Code continuously writes tool results during processing).
export function watchForResponse(
  filePath: string,
  baselineSize: number,
  onResponse: ResponseCallback,
  timeoutMs = 120_000,
  onPing?: () => void,
  debounceMs = 1000,
  onComplete?: () => void
): () => void {
  const parts = filePath.split("/");
  const sessionId = parts[parts.length - 1].replace(".jsonl", "");
  const projectDir = parts[parts.length - 2];
  const projectName = decodeProjectName(projectDir);
  const cwd = parts.slice(0, -2).join("/"); // approximation; real cwd read from file

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let done = false;
  let lastSentText: string | null = null;
  let completionScheduled = false;

  const watcher = chokidar.watch(filePath, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: false,
  });

  const cleanup = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    clearTimeout(pingId);
    watcher.close();
  };

  const pingId = setTimeout(() => {
    if (!done && lastSentText === null) onPing?.();
  }, 60_000);

  const timeoutId = setTimeout(() => {
    if (!done) {
      done = true;
      log({ message: `watchForResponse timeout for session ${sessionId.slice(0, 8)}` });
      cleanup();
    }
  }, timeoutMs);

  watcher.on("change", () => {
    if (done) return;

    readFile(filePath)
      .then((buf) => {
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
          clearTimeout(timeoutId);
          // Let any pending debounce fire first, then shut down
          setTimeout(() => {
            done = true;
            cleanup();
            log({ message: `watchForResponse: session ${sessionId.slice(0, 8)} completed (result event)` });
            onComplete?.();
          }, debounceMs + 200);
        }

        // No new text, or same text already sent — don't restart debounce
        if (!latestText || latestText === lastSentText) return;

        // New text found — debounce to let Claude finish writing this entry
        if (debounceTimer) clearTimeout(debounceTimer);
        const capturedText = latestText;
        const capturedCwd = latestCwd;

        debounceTimer = setTimeout(async () => {
          if (done || capturedText === lastSentText) return;
          lastSentText = capturedText;
          log({ message: `watchForResponse firing for session ${sessionId.slice(0, 8)}: ${capturedText.slice(0, 60)}` });
          await onResponse({ sessionId, projectName, cwd: capturedCwd, filePath, text: capturedText }).catch(
            (err) => log({ message: `watchForResponse callback error: ${err instanceof Error ? err.message : String(err)}` })
          );
        }, debounceMs);
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
    clearTimeout(timeoutId);
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
