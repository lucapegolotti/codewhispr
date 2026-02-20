import chokidar from "chokidar";
import { readFile, writeFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { log } from "../logger.js";

const CLAUDE_VOICE_DIR = join(homedir(), ".claude-voice");

export type PermissionRequest = {
  requestId: string;
  toolName: string;
  toolInput: string;
  toolCommand?: string; // actual command extracted from JSONL (e.g. the bash command)
  filePath: string;
};

// Read the JSONL transcript and extract the last tool_use input matching toolName.
async function extractToolCommand(transcriptPath: string, toolName: string): Promise<string | undefined> {
  try {
    const content = await readFile(transcriptPath, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.type !== "assistant") continue;
        const blocks: unknown[] = obj.message?.content ?? [];
        for (let j = blocks.length - 1; j >= 0; j--) {
          const block = blocks[j] as Record<string, unknown>;
          if (block.type !== "tool_use" || block.name !== toolName) continue;
          const input = block.input;
          if (typeof input === "string") return input.slice(0, 300);
          if (input && typeof input === "object") {
            const cmd = (input as Record<string, unknown>).command;
            if (typeof cmd === "string") return cmd.slice(0, 300);
            return JSON.stringify(input).slice(0, 300);
          }
        }
      } catch {
        continue;
      }
    }
  } catch {
    // transcript not readable
  }
  return undefined;
}

export function watchPermissionRequests(
  onRequest: (req: PermissionRequest) => Promise<void>
): () => void {
  const watcher = chokidar.watch(CLAUDE_VOICE_DIR, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    depth: 0,
  });

  watcher.on("add", (filePath: string) => {
    const filename = filePath.split("/").pop() ?? "";
    if (!filename.startsWith("permission-request-") || !filename.endsWith(".json")) return;

    readFile(filePath, "utf8")
      .then(async (raw) => {
        const data = JSON.parse(raw);
        const toolCommand = data.transcriptPath
          ? await extractToolCommand(data.transcriptPath, data.toolName)
          : undefined;
        const req: PermissionRequest = {
          requestId: data.requestId,
          toolName: data.toolName,
          toolInput: data.toolInput,
          toolCommand,
          filePath,
        };
        log({ message: `permission request: ${req.toolName} (${req.requestId.slice(0, 8)})` });
        return onRequest(req);
      })
      .catch((err) => {
        log({ message: `permission watcher error: ${err instanceof Error ? err.message : String(err)}` });
      });
  });

  watcher.on("error", (err: unknown) => {
    log({ message: `permission watcher error: ${err instanceof Error ? err.message : String(err)}` });
  });

  return () => { watcher.close(); };
}

export async function respondToPermission(requestId: string, action: "approve" | "deny"): Promise<void> {
  await mkdir(CLAUDE_VOICE_DIR, { recursive: true });
  const responsePath = join(CLAUDE_VOICE_DIR, `permission-response-${requestId}`);
  await writeFile(responsePath, action, "utf8");
  log({ message: `permission response: ${action} (${requestId.slice(0, 8)})` });
}
