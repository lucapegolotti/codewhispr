import { query } from "@anthropic-ai/claude-agent-sdk";
import { narrate } from "./narrator.js";
import { log, logEmitter } from "./logger.js";
import { homedir } from "os";
import { readFile, readdir, stat } from "fs/promises";
import { createReadStream } from "fs";
import { createInterface } from "readline";

const sessions = new Map<number, string>();

const ATTACHED_SESSION_PATH = `${homedir()}/.claude-voice/attached`;

export type SessionInfo = {
  sessionId: string;
  cwd: string;
  projectName: string;
  lastMessage: string;
  mtime: Date;
};

const PROJECTS_PATH = `${homedir()}/.claude/projects`;

const SYSTEM_PROMPT = `You are a coding assistant accessed via Telegram.
When the user mentions a project by name, look for it in ${homedir()}/repositories/.
If the project directory is ambiguous, ask the user to clarify.
Keep responses concise.`;

type AttachedSession = { sessionId: string; cwd: string };

async function getAttachedSession(): Promise<AttachedSession | null> {
  try {
    const content = await readFile(ATTACHED_SESSION_PATH, "utf8");
    const [sessionId, cwd] = content.trim().split("\n");
    if (!sessionId) return null;
    return { sessionId, cwd: cwd || homedir() };
  } catch {
    return null;
  }
}

export async function listSessions(limit = 5): Promise<SessionInfo[]> {
  const results: SessionInfo[] = [];

  let projectDirs: string[];
  try {
    projectDirs = await readdir(PROJECTS_PATH);
  } catch {
    return [];
  }

  for (const dir of projectDirs) {
    const dirPath = `${PROJECTS_PATH}/${dir}`;
    let files: string[];
    try {
      files = (await readdir(dirPath)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const file of files) {
      const sessionId = file.replace(".jsonl", "");
      const filePath = `${dirPath}/${file}`;

      let mtime: Date;
      try {
        mtime = (await stat(filePath)).mtime;
      } catch {
        continue;
      }

      // Decode project name: "-Users-luca-repositories-foo" -> "foo"
      const encoded = dir.replace(/^-/, "").replace(/-/g, "/");
      const projectName = encoded.split("/").pop() || dir;

      // Read jsonl: collect cwd from first assistant line, lastMessage from last text block
      let cwd = homedir();
      let lastMessage = "";

      const rl = createInterface({
        input: createReadStream(filePath),
        crlfDelay: Infinity,
      });

      try {
        for await (const line of rl) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            if (entry.type === "assistant") {
              if (entry.cwd && cwd === homedir()) cwd = entry.cwd;
              const textBlocks = (entry.message?.content ?? []).filter(
                (c: { type: string }) => c.type === "text"
              );
              if (textBlocks.length > 0) {
                lastMessage = textBlocks[textBlocks.length - 1].text.slice(0, 100).replace(/\n/g, " ");
              }
            }
          } catch {
            // skip malformed lines
          }
        }
      } catch {
        // skip unreadable files
      } finally {
        rl.close();
      }

      results.push({ sessionId, cwd, projectName, lastMessage, mtime });
    }
  }

  results.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return results.slice(0, limit);
}

export function getActiveSessions(): number[] {
  return [...sessions.keys()];
}

export async function runAgentTurn(chatId: number, userMessage: string): Promise<string> {
  const attached = await getAttachedSession();
  const existingSessionId = attached?.sessionId ?? sessions.get(chatId);

  if (attached) {
    log({ chatId, message: `joining attached session ${attached.sessionId.slice(0, 8)}... (${attached.cwd})` });
  } else if (existingSessionId) {
    log({ chatId, message: `resuming session ${existingSessionId.slice(0, 8)}...` });
  } else {
    log({ chatId, message: "starting new session" });
  }

  let result = "";
  let capturedSessionId: string | undefined;

  for await (const message of query({
    prompt: userMessage,
    options: attached
      ? { resume: attached.sessionId, cwd: attached.cwd }
      : {
          allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
          permissionMode: "acceptEdits",
          cwd: homedir(),
          ...(existingSessionId
            ? { resume: existingSessionId }
            : { systemPrompt: SYSTEM_PROMPT }),
        },
  })) {
    if (message.type === "system" && message.subtype === "init" && !attached) {
      capturedSessionId = message.session_id;
    }
    if (message.type === "result" && message.subtype === "success") {
      result = message.result;
    }
    if (message.type === "result" && message.subtype !== "success") {
      const detail = "error_message" in message ? `: ${message.error_message}` : "";
      throw new Error(`Agent error (${message.subtype}${detail})`);
    }
  }

  if (capturedSessionId && !attached) {
    sessions.set(chatId, capturedSessionId);
    log({ chatId, message: "session established" });
    logEmitter.emit("session");
  }

  return narrate(result || "The agent completed the task but produced no output.");
}
