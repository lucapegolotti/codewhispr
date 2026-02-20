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
  filePath: string;
};

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
      .then((raw) => {
        const data = JSON.parse(raw);
        const req: PermissionRequest = {
          requestId: data.requestId,
          toolName: data.toolName,
          toolInput: data.toolInput,
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

export async function respondToPermission(requestId: string, approved: boolean): Promise<void> {
  await mkdir(CLAUDE_VOICE_DIR, { recursive: true });
  const responsePath = join(CLAUDE_VOICE_DIR, `permission-response-${requestId}`);
  await writeFile(responsePath, approved ? "approve" : "deny", "utf8");
  log({ message: `permission response: ${approved ? "approved" : "denied"} (${requestId.slice(0, 8)})` });
}
