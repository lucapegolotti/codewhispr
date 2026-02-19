import { query } from "@anthropic-ai/claude-agent-sdk";
import { narrate } from "./narrator.js";
import { log, logEmitter } from "./logger.js";
import { homedir } from "os";
import { readFile } from "fs/promises";

const sessions = new Map<number, string>();

const ATTACHED_SESSION_PATH = `${homedir()}/.claude-voice/attached`;

const SYSTEM_PROMPT = `You are a coding assistant accessed via Telegram.
When the user mentions a project by name, look for it in ${homedir()}/repositories/.
If the project directory is ambiguous, ask the user to clarify.
Keep responses concise.`;

async function getAttachedSessionId(): Promise<string | null> {
  try {
    const id = await readFile(ATTACHED_SESSION_PATH, "utf8");
    return id.trim() || null;
  } catch {
    return null;
  }
}

export function getActiveSessions(): number[] {
  return [...sessions.keys()];
}

export async function runAgentTurn(chatId: number, userMessage: string): Promise<string> {
  const attachedSessionId = await getAttachedSessionId();
  const existingSessionId = attachedSessionId ?? sessions.get(chatId);

  if (attachedSessionId) {
    log({ chatId, message: `joining attached session ${attachedSessionId.slice(0, 8)}...` });
  } else if (!existingSessionId) {
    log({ chatId, message: "starting new session" });
  }

  let result = "";
  let capturedSessionId: string | undefined;

  for await (const message of query({
    prompt: userMessage,
    options: {
      allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
      permissionMode: "acceptEdits",
      cwd: homedir(),
      ...(existingSessionId
        ? { resume: existingSessionId }
        : { systemPrompt: SYSTEM_PROMPT }),
    },
  })) {
    if (message.type === "system" && message.subtype === "init" && !existingSessionId) {
      capturedSessionId = message.session_id;
    }
    if (message.type === "result" && message.subtype === "success") {
      result = message.result;
    }
    if (message.type === "result" && message.subtype !== "success") {
      throw new Error(`Agent error (${message.subtype})`);
    }
  }

  if (capturedSessionId && !attachedSessionId) {
    sessions.set(chatId, capturedSessionId);
    log({ chatId, message: "session established" });
    logEmitter.emit("session");
  }

  return narrate(result || "The agent completed the task but produced no output.");
}
