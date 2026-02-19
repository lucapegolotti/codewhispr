import chokidar from "chokidar";
import { readFile } from "fs/promises";
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

export function startMonitor(onWaiting: WaitingCallback, onResponse?: ResponseCallback): () => void {
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
      } else if (onResponse) {
        log({ message: `session ${sessionId.slice(0, 8)} responded: ${lastText.slice(0, 80)}` });
        await onResponse({ sessionId, projectName, cwd, filePath, text: lastText }).catch(
          (err) => log({ message: `response notification error: ${err instanceof Error ? err.message : String(err)}` })
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
