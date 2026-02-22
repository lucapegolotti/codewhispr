/**
 * Shared JSONL parsing utilities.
 *
 * All functions operate on arrays of raw JSONL line strings and are pure
 * (no I/O). The callers are responsible for reading/streaming the file.
 */

export type ContentBlock = {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
};

export type AssistantEntry = {
  type: "assistant";
  cwd?: string;
  message?: {
    content?: ContentBlock[];
    model?: string;
  };
};

/**
 * Find the latest assistant text block, scanning backwards from the end.
 * Stops at a user/human turn boundary. Returns the text, cwd, and model.
 */
export function parseAssistantText(
  lines: string[]
): { text: string | null; cwd: string | null; model: string | undefined } {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === "user") break;
      if (entry.type !== "assistant") continue;
      const blocks: ContentBlock[] = entry.message?.content ?? [];
      const textBlocks = blocks.filter((c) => c.type === "text");
      if (textBlocks.length === 0) continue;
      const text = textBlocks[textBlocks.length - 1].text;
      if (!text?.trim()) continue;
      return {
        text,
        cwd: entry.cwd ?? null,
        model: entry.message?.model,
      };
    } catch {
      continue;
    }
  }
  return { text: null, cwd: null, model: undefined };
}

/**
 * Extract the cwd from the first assistant entry that has one.
 */
export function extractCwd(lines: string[]): string | null {
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "assistant" && entry.cwd) return entry.cwd;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Check whether any line is a `{"type":"result"}` event (from the Stop hook).
 */
export function findResultEvent(lines: string[]): boolean {
  return lines.some((line) => {
    try {
      return JSON.parse(line).type === "result";
    } catch {
      return false;
    }
  });
}

/**
 * Detect an ExitPlanMode tool_use in the latest assistant turn (scanning
 * backwards, stopping at user boundary). Returns the plan text if present.
 */
export function findExitPlanMode(
  lines: string[]
): { found: boolean; planText: string | null } {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === "user") break;
      if (entry.type !== "assistant") continue;
      const blocks: ContentBlock[] = entry.message?.content ?? [];
      const exitBlock = blocks.find(
        (c) => c.type === "tool_use" && c.name === "ExitPlanMode"
      );
      if (exitBlock) {
        const planText = (exitBlock.input?.plan as string) ?? null;
        return { found: true, planText };
      }
    } catch {
      continue;
    }
  }
  return { found: false, planText: null };
}

/**
 * Extract file paths of images written via the Write tool.
 */
export function extractWrittenImagePaths(lines: string[]): string[] {
  const paths: string[] = [];
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
          paths.push(fp);
        }
      }
    } catch {
      continue;
    }
  }
  return paths;
}

/**
 * Find the last tool_use block for a given tool name, scanning backwards.
 * Returns the tool input (as string for string inputs, or the command field,
 * or JSON-stringified object), truncated to maxLength.
 */
export function findLastToolUse(
  lines: string[],
  toolName: string,
  maxLength = 300
): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type !== "assistant") continue;
      const blocks: unknown[] = entry.message?.content ?? [];
      for (let j = blocks.length - 1; j >= 0; j--) {
        const block = blocks[j] as Record<string, unknown>;
        if (block.type !== "tool_use" || block.name !== toolName) continue;
        const input = block.input;
        if (typeof input === "string") return input.slice(0, maxLength);
        if (input && typeof input === "object") {
          const cmd = (input as Record<string, unknown>).command;
          if (typeof cmd === "string") return cmd.slice(0, maxLength);
          return JSON.stringify(input).slice(0, maxLength);
        }
      }
    } catch {
      continue;
    }
  }
  return undefined;
}
