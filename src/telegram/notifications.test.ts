import { describe, it, expect, vi, beforeEach } from "vitest";
import { splitMessage, sendStartupMessage, registerForNotifications } from "./notifications.js";

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

const { readFile, writeFile } = await import("fs/promises");

describe("sendStartupMessage", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("sends startup message to the saved chat ID", async () => {
    vi.mocked(readFile).mockResolvedValue("50620969" as any);
    const mockBot = { api: { sendMessage: vi.fn().mockResolvedValue({}) } } as any;

    await sendStartupMessage(mockBot);

    expect(mockBot.api.sendMessage).toHaveBeenCalledWith(50620969, "claude-voice started.");
  });

  it("does nothing when the chat-id file does not exist", async () => {
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
    const mockBot = { api: { sendMessage: vi.fn() } } as any;

    await sendStartupMessage(mockBot);

    expect(mockBot.api.sendMessage).not.toHaveBeenCalled();
  });

  it("does nothing when the chat-id is not a valid number", async () => {
    vi.mocked(readFile).mockResolvedValue("not-a-number" as any);
    const mockBot = { api: { sendMessage: vi.fn() } } as any;

    await sendStartupMessage(mockBot);

    expect(mockBot.api.sendMessage).not.toHaveBeenCalled();
  });
});

describe("registerForNotifications", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("persists the chat ID to disk", async () => {
    registerForNotifications({} as any, 12345);

    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(writeFile)).toHaveBeenCalledWith(
      expect.stringContaining("chat-id"),
      "12345",
      "utf8"
    );
  });
});

describe("splitMessage", () => {
  it("returns a single chunk when text is under the limit", () => {
    expect(splitMessage("hello world")).toEqual(["hello world"]);
  });

  it("returns a single chunk when text equals the limit exactly", () => {
    const text = "a".repeat(4000);
    expect(splitMessage(text)).toEqual([text]);
  });

  it("splits at the last newline before the limit", () => {
    const first = "a".repeat(3990);
    const second = "b".repeat(100);
    const text = first + "\n" + second;
    const chunks = splitMessage(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(first);
    expect(chunks[1]).toBe(second);
  });

  it("hard-splits at the limit when there is no newline", () => {
    const text = "x".repeat(4500);
    const chunks = splitMessage(text);
    expect(chunks[0]).toHaveLength(4000);
    expect(chunks[1]).toHaveLength(500);
  });

  it("handles three chunks correctly", () => {
    // Two full chunks + a tail
    const chunk = "a".repeat(3999) + "\n";
    const text = chunk + chunk + "end";
    const chunks = splitMessage(text);
    expect(chunks).toHaveLength(3);
    expect(chunks[2]).toBe("end");
  });
});
