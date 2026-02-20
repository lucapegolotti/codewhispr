import { describe, it, expect, vi, beforeEach } from "vitest";
import { Intent } from "./classifier.js";

// Mock all dependencies before importing loop
vi.mock("./classifier.js", () => ({
  Intent: {
    SUMMARY_REQUEST: "SUMMARY_REQUEST",
    COMMAND_EXECUTION: "COMMAND_EXECUTION",
    FOLLOW_UP_INPUT: "FOLLOW_UP_INPUT",
    GENERAL_CHAT: "GENERAL_CHAT",
    SESSION_LIST: "SESSION_LIST",
    UNKNOWN: "UNKNOWN",
  },
  classifyIntent: vi.fn(),
}));
vi.mock("./summarizer.js", () => ({ summarizeSession: vi.fn() }));
vi.mock("../session/adapter.js", () => ({ runAgentTurn: vi.fn() }));
vi.mock("../session/tmux.js", () => ({ injectInput: vi.fn() }));
vi.mock("../logger.js", () => ({ log: vi.fn() }));

import { classifyIntent } from "./classifier.js";
import { summarizeSession } from "./summarizer.js";
import { runAgentTurn } from "../session/adapter.js";
import { injectInput } from "../session/tmux.js";
import { handleTurn, clearChatState } from "./loop.js";

beforeEach(() => {
  vi.clearAllMocks();
  clearChatState(123);
  clearChatState(42);
});

describe("handleTurn", () => {
  it("calls summarizer for SUMMARY_REQUEST", async () => {
    vi.mocked(classifyIntent).mockResolvedValue(Intent.SUMMARY_REQUEST);
    vi.mocked(summarizeSession).mockResolvedValue("Claude is refactoring sessions.ts");

    const result = await handleTurn(123, "what's happening?");
    expect(summarizeSession).toHaveBeenCalled();
    expect(result).toContain("Claude is refactoring sessions.ts");
  });

  it("injects via tmux for COMMAND_EXECUTION when cwd is known", async () => {
    vi.mocked(classifyIntent).mockResolvedValue(Intent.COMMAND_EXECUTION);
    vi.mocked(injectInput).mockResolvedValue({ found: true, paneId: "%2" });

    const result = await handleTurn(123, "install deps", undefined, "/Users/luca/repos/app");
    expect(injectInput).toHaveBeenCalledWith("/Users/luca/repos/app", "install deps");
    expect(classifyIntent).toHaveBeenCalledWith("install deps", undefined);
    expect(result).toBe("__INJECTED__");
  });

  it("falls back to runAgentTurn for COMMAND_EXECUTION when no pane found", async () => {
    vi.mocked(classifyIntent).mockResolvedValue(Intent.COMMAND_EXECUTION);
    vi.mocked(injectInput).mockResolvedValue({ found: false, reason: "no_claude_pane" });
    vi.mocked(runAgentTurn).mockResolvedValue("Installed 3 packages.");

    const result = await handleTurn(123, "install deps", undefined, "/Users/luca/repos/app");
    expect(runAgentTurn).toHaveBeenCalledWith(123, "install deps");
    expect(result).toContain("Installed 3 packages.");
  });

  it("injects via tmux for FOLLOW_UP_INPUT when cwd is known", async () => {
    vi.mocked(classifyIntent).mockResolvedValue(Intent.FOLLOW_UP_INPUT);
    vi.mocked(injectInput).mockResolvedValue({ found: true, paneId: "%2" });

    const result = await handleTurn(123, "y", undefined, "/Users/luca/repos/app");
    expect(injectInput).toHaveBeenCalledWith("/Users/luca/repos/app", "y");
    expect(result).toBe("__INJECTED__");
  });

  it("falls back to runAgentTurn for FOLLOW_UP_INPUT when no cwd", async () => {
    vi.mocked(classifyIntent).mockResolvedValue(Intent.FOLLOW_UP_INPUT);
    vi.mocked(runAgentTurn).mockResolvedValue("ok");

    await handleTurn(123, "y");
    expect(runAgentTurn).toHaveBeenCalledWith(123, "y");
  });

  it("injects via tmux for GENERAL_CHAT when cwd is known", async () => {
    vi.mocked(classifyIntent).mockResolvedValue(Intent.GENERAL_CHAT);
    vi.mocked(injectInput).mockResolvedValue({ found: true, paneId: "%2" });

    const result = await handleTurn(123, "thanks!", undefined, "/Users/luca/repos/app");
    expect(injectInput).toHaveBeenCalledWith("/Users/luca/repos/app", "thanks!");
    expect(result).toBe("__INJECTED__");
  });

  it("returns no-session message for GENERAL_CHAT without cwd", async () => {
    vi.mocked(classifyIntent).mockResolvedValue(Intent.GENERAL_CHAT);

    const result = await handleTurn(123, "thanks!");
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(result).toMatch(/no session/i);
  });

  it("returns SESSION_PICKER sentinel for SESSION_LIST intent", async () => {
    vi.mocked(classifyIntent).mockResolvedValue(Intent.SESSION_LIST);

    const result = await handleTurn(123, "show sessions");
    expect(result).toBe("__SESSION_PICKER__");
  });

  it("injects via tmux for UNKNOWN intent when cwd is known", async () => {
    vi.mocked(classifyIntent).mockResolvedValue(Intent.UNKNOWN);
    vi.mocked(injectInput).mockResolvedValue({ found: true, paneId: "%2" });

    const result = await handleTurn(123, "???", undefined, "/Users/luca/repos/app");
    expect(injectInput).toHaveBeenCalledWith("/Users/luca/repos/app", "???");
    expect(result).toBe("__INJECTED__");
  });

  it("calls runAgentTurn for COMMAND_EXECUTION when no cwd at all", async () => {
    vi.mocked(classifyIntent).mockResolvedValue(Intent.COMMAND_EXECUTION);
    vi.mocked(runAgentTurn).mockResolvedValue("done");

    const result = await handleTurn(123, "do something");
    expect(injectInput).not.toHaveBeenCalled();
    expect(runAgentTurn).toHaveBeenCalledWith(123, "do something");
    expect(result).toContain("done");
  });

  it("returns ambiguous message when multiple panes found", async () => {
    vi.mocked(classifyIntent).mockResolvedValue(Intent.COMMAND_EXECUTION);
    vi.mocked(injectInput).mockResolvedValue({ found: false, reason: "ambiguous" });

    const result = await handleTurn(123, "run tests", undefined, "/Users/luca/repos/app");
    expect(result).toMatch(/multiple/i);
  });
});

describe("clearChatState", () => {
  it("removes stored state so next turn has no prior context", async () => {
    vi.mocked(classifyIntent).mockResolvedValue(Intent.COMMAND_EXECUTION);
    vi.mocked(injectInput).mockResolvedValue({ found: true, paneId: "%2" });

    // First turn — establishes lastBotMessage state
    await handleTurn(42, "first message", undefined, "/cwd");

    clearChatState(42);

    // After clear, classifyIntent should be called without lastBotMessage context
    vi.mocked(classifyIntent).mockResolvedValue(Intent.GENERAL_CHAT);
    vi.mocked(injectInput).mockResolvedValue({ found: true, paneId: "%2" });

    await handleTurn(42, "second message", undefined, "/cwd");

    // classifyIntent's second call should have no contextMessage (undefined second arg)
    const secondCall = vi.mocked(classifyIntent).mock.calls[1];
    expect(secondCall[1]).toBeUndefined();
  });
});
