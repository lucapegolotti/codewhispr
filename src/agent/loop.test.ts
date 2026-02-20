import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleTurn, clearChatState } from "./loop.js";
import { injectInput } from "../session/tmux.js";

vi.mock("../session/tmux.js");
vi.mock("../logger.js");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleTurn", () => {
  it("returns __INJECTED__ when cwd is given and pane is found", async () => {
    vi.mocked(injectInput).mockResolvedValue({ found: true, paneId: "%1" });
    const result = await handleTurn(123, "run tests", undefined, "/Users/luca/repos/app");
    expect(result).toBe("__INJECTED__");
  });

  it("returns no-running message when cwd given but pane not found", async () => {
    vi.mocked(injectInput).mockResolvedValue({ found: false, reason: "no_claude_pane" });
    const result = await handleTurn(123, "run tests", undefined, "/Users/luca/repos/app");
    expect(result).toMatch(/no claude code running/i);
  });

  it("returns no-running message when cwd given but result is ambiguous", async () => {
    vi.mocked(injectInput).mockResolvedValue({ found: false, reason: "ambiguous" });
    const result = await handleTurn(123, "run tests", undefined, "/Users/luca/repos/app");
    expect(result).toMatch(/no claude code running/i);
  });

  it("returns no-session message when no cwd provided", async () => {
    const result = await handleTurn(123, "hello");
    expect(result).toMatch(/no session attached/i);
    expect(injectInput).not.toHaveBeenCalled();
  });

  it("clearChatState does not throw", () => {
    expect(() => clearChatState(123)).not.toThrow();
  });
});
