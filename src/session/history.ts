import { createReadStream } from "fs";
import { createInterface } from "readline";
import { readdir, readFile, stat } from "fs/promises";
import { homedir } from "os";

export const PROJECTS_PATH = `${homedir()}/.claude/projects`;
export const ATTACHED_SESSION_PATH = `${homedir()}/.codewhispr/attached`;

export type SessionInfo = {
  sessionId: string;
  cwd: string;
  projectName: string;
  lastMessage: string;
  mtime: Date;
};

export type ToolCall = {
  name: string;
  input: Record<string, unknown>;
};

export type ParsedSession = {
  cwd: string;
  lastMessage: string;
  toolCalls: ToolCall[];
  allMessages: string[];
};

const WAITING_PATTERNS = [
  /press\s+enter/i,
  /\(y\/n\)/i,
  /\[y\/N\]/i,
  /confirm\?/i,
  /provide\s+(your\s+)?input/i,
  /waiting\s+for\s+(user\s+)?input/i,
];

export function extractWaitingPrompt(text: string): string | null {
  const trimmed = text.trim();
  const endsWithQuestion = /\?\s*$/.test(trimmed);
  const endsWithPrompt = /[>:]\s*$/.test(trimmed);
  const matchesPattern = WAITING_PATTERNS.some((p) => p.test(trimmed));

  if (matchesPattern || endsWithQuestion || endsWithPrompt) {
    return trimmed;
  }
  return null;
}

export function parseJsonlLines(lines: string[]): ParsedSession {
  let cwd = homedir();
  let lastMessage = "";
  const toolCalls: ToolCall[] = [];
  const allMessages: string[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "assistant") {
        if (entry.cwd && cwd === homedir()) cwd = entry.cwd;
        const content: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }> =
          entry.message?.content ?? [];
        for (const block of content) {
          if (block.type === "text" && block.text) {
            lastMessage = block.text.slice(0, 200).replace(/\n/g, " ");
            allMessages.push(block.text);
          }
          if (block.type === "tool_use" && block.name) {
            toolCalls.push({ name: block.name, input: block.input ?? {} });
          }
        }
      }
    } catch {
      // skip malformed lines
    }
  }

  return { cwd, lastMessage, toolCalls, allMessages };
}

export async function readSessionLines(filePath: string): Promise<string[]> {
  const lines: string[] = [];
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      lines.push(line);
    }
  } finally {
    rl.close();
  }
  return lines;
}

// Returns the most recently modified session per project directory, sorted by
// recency. One entry per project eliminates duplicates from multi-session projects.
export async function listSessions(limit = 20, projectsPath = PROJECTS_PATH): Promise<SessionInfo[]> {
  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsPath);
  } catch {
    return [];
  }

  const results: SessionInfo[] = [];

  for (const dir of projectDirs) {
    const dirPath = `${projectsPath}/${dir}`;
    let files: string[];
    try {
      files = (await readdir(dirPath)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    // Pick only the most recently modified session file for this project
    let bestFile: string | null = null;
    let bestMtime = new Date(0);
    for (const file of files) {
      try {
        const m = (await stat(`${dirPath}/${file}`)).mtime;
        if (m > bestMtime) { bestMtime = m; bestFile = file; }
      } catch {
        continue;
      }
    }
    if (!bestFile) continue;

    const sessionId = bestFile.replace(".jsonl", "");
    const filePath = `${dirPath}/${bestFile}`;
    const encoded = dir.replace(/^-/, "").replace(/-/g, "/");
    const projectName = encoded.split("/").pop() || dir;

    const lines = await readSessionLines(filePath).catch(() => []);
    const parsed = parseJsonlLines(lines);

    results.push({
      sessionId,
      cwd: parsed.cwd,
      projectName,
      lastMessage: parsed.lastMessage,
      mtime: bestMtime,
    });
  }

  results.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return results.slice(0, limit);
}

export async function getAttachedSession(): Promise<{ sessionId: string; cwd: string } | null> {
  try {
    const content = await readFile(ATTACHED_SESSION_PATH, "utf8");
    const [sessionId, cwd] = content.trim().split("\n");
    if (!sessionId) return null;
    return { sessionId, cwd: cwd || homedir() };
  } catch {
    return null;
  }
}

export async function getSessionFilePath(sessionId: string): Promise<string | null> {
  let projectDirs: string[];
  try {
    projectDirs = await readdir(PROJECTS_PATH);
  } catch {
    return null;
  }
  for (const dir of projectDirs) {
    const candidate = `${PROJECTS_PATH}/${dir}/${sessionId}.jsonl`;
    try {
      await stat(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

// Returns true if the JSONL file contains at least one assistant message.
// Files that only contain file-history-snapshot entries are not real session files.
async function hasAssistantMessages(filePath: string): Promise<boolean> {
  try {
    const content = await readFile(filePath, "utf8");
    return content.includes('"type":"assistant"');
  } catch {
    return false;
  }
}

// Returns the most recently modified session JSONL for the given working directory.
// Prefers files that contain actual conversation data (assistant messages) over
// metadata-only files (e.g. file-history-snapshot entries created at startup).
// Used when the attached session ID may be stale (e.g. Claude Code restarted and
// created a new session UUID while the bot was still watching the old one).
export async function getLatestSessionFileForCwd(
  cwd: string
): Promise<{ filePath: string; sessionId: string } | null> {
  // Claude Code encodes the cwd as a directory name by replacing all non-alphanumeric
  // characters (slashes, underscores, dots, etc.) with "-".
  // e.g. /home/luca_dev/repositories/foo → -home-luca-dev-repositories-foo
  const dirName = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const projectDir = `${PROJECTS_PATH}/${dirName}`;

  let files: string[];
  try {
    files = (await readdir(projectDir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }

  // Collect files with their mtimes
  const entries: { file: string; mtime: Date }[] = [];
  for (const file of files) {
    try {
      const m = (await stat(`${projectDir}/${file}`)).mtime;
      entries.push({ file, mtime: m });
    } catch {
      continue;
    }
  }
  if (entries.length === 0) return null;

  // Sort by mtime descending
  entries.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  // Prefer the most recently modified file that has actual conversation content.
  // Fall back to the most recently modified file if none have assistant messages.
  for (const entry of entries) {
    const filePath = `${projectDir}/${entry.file}`;
    if (await hasAssistantMessages(filePath)) {
      return { filePath, sessionId: entry.file.replace(".jsonl", "") };
    }
  }

  // No conversation files found — return most recent (new session not yet responded to)
  const best = entries[0];
  return {
    filePath: `${projectDir}/${best.file}`,
    sessionId: best.file.replace(".jsonl", ""),
  };
}
