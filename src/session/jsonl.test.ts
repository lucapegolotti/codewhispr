import { describe, it, expect } from "vitest";
import {
  parseAssistantText,
  extractCwd,
  findResultEvent,
  findExitPlanMode,
  extractWrittenImagePaths,
  findLastToolUse,
} from "./jsonl.js";

function assistantLine(text: string, cwd = "/tmp/project", model?: string): string {
  return JSON.stringify({
    type: "assistant",
    cwd,
    message: { content: [{ type: "text", text }], ...(model ? { model } : {}) },
  });
}

function userLine(): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: "hi" } });
}

function exitPlanLine(plan?: string): string {
  return JSON.stringify({
    type: "assistant",
    cwd: "/tmp/proj",
    message: { content: [{ type: "tool_use", id: "toolu_1", name: "ExitPlanMode", input: plan ? { plan } : {} }] },
  });
}

function resultLine(): string {
  return JSON.stringify({ type: "result", source: "stop-hook" });
}

function writeLine(filePath: string): string {
  return JSON.stringify({
    type: "assistant",
    cwd: "/tmp/proj",
    message: { content: [{ type: "tool_use", id: "toolu_w", name: "Write", input: { file_path: filePath, content: "data" } }] },
  });
}

function bashLine(command: string): string {
  return JSON.stringify({
    type: "assistant",
    cwd: "/tmp/proj",
    message: { content: [{ type: "tool_use", id: "toolu_b", name: "Bash", input: { command } }] },
  });
}

describe("parseAssistantText", () => {
  it("finds the latest assistant text block", () => {
    const lines = [assistantLine("First"), assistantLine("Second")];
    expect(parseAssistantText(lines)).toEqual({ text: "Second", cwd: "/tmp/project", model: undefined });
  });

  it("returns cwd and model", () => {
    const lines = [assistantLine("Hello", "/home/user", "claude-opus-4-6")];
    expect(parseAssistantText(lines)).toEqual({ text: "Hello", cwd: "/home/user", model: "claude-opus-4-6" });
  });

  it("stops at user boundary", () => {
    const lines = [assistantLine("Old"), userLine(), assistantLine("New")];
    expect(parseAssistantText(lines).text).toBe("New");
  });

  it("returns null for empty lines", () => {
    expect(parseAssistantText([])).toEqual({ text: null, cwd: null, model: undefined });
  });

  it("skips whitespace-only text", () => {
    const lines = [assistantLine("Real text"), JSON.stringify({
      type: "assistant", cwd: "/tmp", message: { content: [{ type: "text", text: "   " }] },
    })];
    expect(parseAssistantText(lines).text).toBe("Real text");
  });

  it("skips malformed JSON lines", () => {
    const lines = ["not json", assistantLine("Valid")];
    expect(parseAssistantText(lines).text).toBe("Valid");
  });
});

describe("extractCwd", () => {
  it("finds the first cwd", () => {
    const lines = [assistantLine("A", "/first"), assistantLine("B", "/second")];
    expect(extractCwd(lines)).toBe("/first");
  });

  it("returns null when no cwd", () => {
    expect(extractCwd([userLine()])).toBeNull();
  });
});

describe("findResultEvent", () => {
  it("detects result event", () => {
    expect(findResultEvent([assistantLine("text"), resultLine()])).toBe(true);
  });

  it("returns false when no result", () => {
    expect(findResultEvent([assistantLine("text")])).toBe(false);
  });

  it("handles malformed lines", () => {
    expect(findResultEvent(["not json", resultLine()])).toBe(true);
  });
});

describe("findExitPlanMode", () => {
  it("detects ExitPlanMode", () => {
    expect(findExitPlanMode([exitPlanLine()])).toEqual({ found: true, planText: null });
  });

  it("extracts plan text", () => {
    expect(findExitPlanMode([exitPlanLine("My plan")])).toEqual({ found: true, planText: "My plan" });
  });

  it("stops at user boundary", () => {
    const lines = [exitPlanLine(), userLine(), assistantLine("Later")];
    expect(findExitPlanMode(lines)).toEqual({ found: false, planText: null });
  });

  it("returns not-found for empty lines", () => {
    expect(findExitPlanMode([])).toEqual({ found: false, planText: null });
  });
});

describe("extractWrittenImagePaths", () => {
  it("finds image paths from Write tool_use", () => {
    const lines = [writeLine("/tmp/out.png"), writeLine("/tmp/code.ts")];
    expect(extractWrittenImagePaths(lines)).toEqual(["/tmp/out.png"]);
  });

  it("finds multiple image extensions", () => {
    const lines = [writeLine("/a.png"), writeLine("/b.jpg"), writeLine("/c.gif"), writeLine("/d.webp")];
    expect(extractWrittenImagePaths(lines)).toEqual(["/a.png", "/b.jpg", "/c.gif", "/d.webp"]);
  });

  it("returns empty for no images", () => {
    expect(extractWrittenImagePaths([assistantLine("text")])).toEqual([]);
  });
});

describe("findLastToolUse", () => {
  it("finds the last Bash command", () => {
    const lines = [bashLine("ls"), bashLine("npm test")];
    expect(findLastToolUse(lines, "Bash")).toBe("npm test");
  });

  it("returns undefined for non-matching tool", () => {
    const lines = [bashLine("ls")];
    expect(findLastToolUse(lines, "Write")).toBeUndefined();
  });

  it("truncates long commands", () => {
    const longCmd = "x".repeat(500);
    const lines = [bashLine(longCmd)];
    expect(findLastToolUse(lines, "Bash")!.length).toBe(300);
  });

  it("handles JSON input without command field", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "/a.ts", content: "hello" } }] },
    });
    const result = findLastToolUse([line], "Write");
    expect(result).toContain("file_path");
  });
});
