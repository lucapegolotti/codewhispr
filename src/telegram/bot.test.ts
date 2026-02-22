import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createBot } from "./bot.js";
import { findClaudePane, listTmuxPanes, isClaudePane, launchClaudeInWindow, killWindow, sendKeysToPane, injectInput } from "../session/tmux.js";
import { getAttachedSession, listSessions, getLatestSessionFileForCwd, readSessionLines, parseJsonlLines } from "../session/history.js";
import { unlink, writeFile } from "fs/promises";
import { watchForResponse, getFileSize } from "../session/monitor.js";
import { isServiceInstalled } from "../service/index.js";

vi.mock("../session/tmux.js", () => ({
  findClaudePane: vi.fn(),
  listTmuxPanes: vi.fn(),
  isClaudePane: vi.fn(),
  launchClaudeInWindow: vi.fn(),
  killWindow: vi.fn(),
  injectInput: vi.fn(),
  sendKeysToPane: vi.fn(),
  sendRawKeyToPane: vi.fn(),
}));

vi.mock("../session/history.js", () => ({
  ATTACHED_SESSION_PATH: "/tmp/cv-test/attached",
  getAttachedSession: vi.fn(),
  listSessions: vi.fn(),
  getLatestSessionFileForCwd: vi.fn(),
  readSessionLines: vi.fn().mockResolvedValue([]),
  parseJsonlLines: vi.fn().mockReturnValue({ lastMessage: "", cwd: "", toolCalls: [], allMessages: [] }),
}));

vi.mock("../session/monitor.js", () => ({
  watchForResponse: vi.fn().mockReturnValue(() => {}),
  getFileSize: vi.fn().mockResolvedValue(100),
}));

vi.mock("./notifications.js", () => ({
  registerForNotifications: vi.fn(),
  resolveWaitingAction: vi.fn(),
  notifyResponse: vi.fn(),
  sendPing: vi.fn(),
}));

vi.mock("../session/permissions.js", () => ({
  watchPermissionRequests: vi.fn().mockReturnValue(() => {}),
  respondToPermission: vi.fn(),
}));

vi.mock("../agent/summarizer.js", () => ({
  summarizeSession: vi.fn(),
}));

vi.mock("../voice.js", () => ({
  transcribeAudio: vi.fn(),
  synthesizeSpeech: vi.fn(),
  polishTranscript: vi.fn(),
}));

vi.mock("../narrator.js", () => ({
  narrate: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  log: vi.fn(),
}));

vi.mock("../service/index.js", () => ({
  isServiceInstalled: vi.fn().mockResolvedValue(false),
}));

vi.mock("child_process", () => ({
  spawn: vi.fn().mockReturnValue({ unref: vi.fn() }),
}));

vi.mock("fs/promises", () => ({
  unlink: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(""),
  access: vi.fn().mockRejectedValue(new Error("ENOENT")), // polish voice on by default
  stat: vi.fn().mockResolvedValue({ mtimeMs: Date.now() }),
}));

// ---------------------------------------------------------------------------
// Bot setup helpers
// ---------------------------------------------------------------------------

const BOT_INFO = {
  id: 1,
  is_bot: true as const,
  first_name: "TestBot",
  username: "testbot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
};

type ApiCall = { method: string; payload: Record<string, unknown> };

async function makeBot() {
  const bot = createBot("test-token");
  const apiCalls: ApiCall[] = [];

  // Install a transformer that intercepts all API calls without hitting the network
  bot.api.config.use(async (prev, method, payload, signal) => {
    apiCalls.push({ method, payload: payload as Record<string, unknown> });
    if (method === "getMe") {
      return { ok: true as const, result: BOT_INFO };
    }
    return { ok: true as const, result: {} };
  });

  await bot.init();

  return { bot, apiCalls };
}

function callbackUpdate(data: string, chatId = 12345) {
  return {
    update_id: 1,
    callback_query: {
      id: "cq-id",
      from: { id: chatId, is_bot: false, first_name: "Test" },
      message: {
        message_id: 42,
        date: 0,
        chat: { id: chatId, type: "private" as const, first_name: "Test" },
        text: "original message",
      },
      data,
      chat_instance: "chat",
    },
  };
}

function commandUpdate(command: string, chatId = 12345) {
  const text = command.startsWith("/") ? command : `/${command}`;
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      chat: { id: chatId, type: "private" as const, first_name: "Test" },
      from: { id: chatId, is_bot: false, first_name: "Test" },
      text,
      entities: [{ type: "bot_command" as const, offset: 0, length: text.split(" ")[0].length }],
    },
  };
}

function textUpdate(text: string, chatId = 12345) {
  return {
    update_id: 2,
    message: {
      message_id: 2,
      date: 0,
      chat: { id: chatId, type: "private" as const, first_name: "Test" },
      from: { id: chatId, is_bot: false, first_name: "Test" },
      text,
    },
  };
}

// ---------------------------------------------------------------------------
// /clear then question — session rotation e2e (bot handler level)
//
// Verifies that when the user sends /clear followed by a question, the bot
// sets up the watcher on the NEW session file (created after /clear), not the
// old one.
//
// Key mechanics:
//  - /clear is a bot command: handled by bot.command("clear") → sendKeysToPane only,
//    NO watcher is set up (Claude Code has no response for /clear itself)
//  - The question is a plain text message: handled by processTextTurn →
//    snapshotBaseline → getLatestSessionFileForCwd → startInjectionWatcher →
//    watchForResponse
//
// Reproduces the bug where the new session file had file-history-snapshot
// metadata (non-empty, no assistant messages), was skipped by
// getLatestSessionFileForCwd, and the bot watched the old file forever.
// ---------------------------------------------------------------------------

describe("e2e: /clear then question — watchForResponse called on new session file", () => {
  const CWD = "/proj/myapp";
  const NEW_SESSION = { sessionId: "new-session-id", filePath: "/new-session-id.jsonl" };

  beforeEach(() => {
    vi.clearAllMocks();
    // /clear goes through bot.command("clear") → getAttachedSession + findClaudePane + sendKeysToPane
    vi.mocked(getAttachedSession).mockResolvedValue({ sessionId: "old-session-id", cwd: CWD });
    vi.mocked(findClaudePane).mockResolvedValue({ found: true, paneId: "%1" });
    // question goes through processTextTurn → getLatestSessionFileForCwd must return new session
    vi.mocked(getLatestSessionFileForCwd).mockResolvedValue(NEW_SESSION);
    vi.mocked(getFileSize).mockResolvedValue(0);
    vi.mocked(injectInput).mockResolvedValue({ found: true, paneId: "%1" });
  });

  afterEach(() => {
    vi.mocked(getLatestSessionFileForCwd).mockReset();
    vi.mocked(injectInput).mockReset();
    vi.mocked(getAttachedSession).mockReset();
    vi.mocked(findClaudePane).mockReset();
  });

  it("after /clear, question message watches the new session file", async () => {
    const { bot } = await makeBot();

    let capturedWatchPath: string | null = null;
    vi.mocked(watchForResponse).mockImplementation((filePath) => {
      capturedWatchPath = filePath;
      return () => {};
    });

    // Message 1: /clear → bot.command("clear") → sendKeysToPane only, NO watcher
    await bot.handleUpdate(commandUpdate("/clear") as any);
    expect(capturedWatchPath).toBeNull(); // confirmed: /clear does not start a watcher

    // Message 2: question → processTextTurn → snapshotBaseline → watchForResponse
    // After /clear, getLatestSessionFileForCwd returns the new session (with metadata)
    await bot.handleUpdate(textUpdate("Does Claude Code fire a hook on Ctrl+C?") as any);

    // The watcher must be on the NEW session file, not the old one
    expect(capturedWatchPath).toBe(NEW_SESSION.filePath);
  });
});

// ---------------------------------------------------------------------------
// /detach command
// ---------------------------------------------------------------------------

describe("/detach command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows close-window keyboard when Claude Code pane is running", async () => {
    const { bot, apiCalls } = await makeBot();

    vi.mocked(getAttachedSession).mockResolvedValue({ sessionId: "s1", cwd: "/proj" });
    vi.mocked(findClaudePane).mockResolvedValue({ found: true, paneId: "%5" });

    await bot.handleUpdate(commandUpdate("/detach") as any);

    expect(vi.mocked(unlink)).toHaveBeenCalled();
    const sendMessages = apiCalls.filter((c) => c.method === "sendMessage");
    const texts = sendMessages.map((c) => c.payload.text as string);
    expect(texts.some((t) => t.includes("Close the tmux Claude Code window"))).toBe(true);
  });

  it("sends simple Detached message when no Claude Code pane is running", async () => {
    const { bot, apiCalls } = await makeBot();

    vi.mocked(getAttachedSession).mockResolvedValue({ sessionId: "s1", cwd: "/proj" });
    vi.mocked(findClaudePane).mockResolvedValue({ found: false, reason: "no_claude_pane" });

    await bot.handleUpdate(commandUpdate("/detach") as any);

    const sendMessages = apiCalls.filter((c) => c.method === "sendMessage");
    const texts = sendMessages.map((c) => c.payload.text as string);
    expect(texts.some((t) => t === "Detached.")).toBe(true);
  });

  it("detaches even when no session is attached", async () => {
    const { bot, apiCalls } = await makeBot();

    vi.mocked(getAttachedSession).mockResolvedValue(null);

    await bot.handleUpdate(commandUpdate("/detach") as any);

    expect(vi.mocked(unlink)).toHaveBeenCalled();
    const sendMessages = apiCalls.filter((c) => c.method === "sendMessage");
    const texts = sendMessages.map((c) => c.payload.text as string);
    expect(texts.some((t) => t === "Detached.")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// detach: callbacks
// ---------------------------------------------------------------------------

describe("detach: callbacks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("detach:keep removes buttons without changing text", async () => {
    const { bot, apiCalls } = await makeBot();

    await bot.handleUpdate(callbackUpdate("detach:keep") as any);

    const answers = apiCalls.filter((c) => c.method === "answerCallbackQuery");
    expect(answers.some((c) => c.payload.text === "Kept open.")).toBe(true);
    const edits = apiCalls.filter((c) => c.method === "editMessageReplyMarkup");
    expect(edits.length).toBeGreaterThan(0);
  });

  it("detach:close:<paneId> kills the tmux window", async () => {
    const { bot, apiCalls } = await makeBot();

    vi.mocked(killWindow).mockResolvedValue(undefined);

    await bot.handleUpdate(callbackUpdate("detach:close:%5") as any);

    expect(killWindow).toHaveBeenCalledWith("%5");

    const answers = apiCalls.filter((c) => c.method === "answerCallbackQuery");
    expect(answers.some((c) => c.payload.text === "Closed.")).toBe(true);

    const edits = apiCalls.filter((c) => c.method === "editMessageText");
    expect(edits.some((c) => c.payload.text === "Detached. tmux window closed.")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// session: callbacks
// ---------------------------------------------------------------------------

describe("session: callbacks", () => {
  const SESSION = {
    sessionId: "s1",
    cwd: "/proj",
    projectName: "myproject",
    lastMessage: "",
    mtime: new Date(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function setupWithSessions(bot: Awaited<ReturnType<typeof makeBot>>["bot"], apiCalls: ApiCall[]) {
    const pane = { paneId: "%1", cwd: SESSION.cwd, command: "claude", shellPid: 0 };
    vi.mocked(listTmuxPanes).mockResolvedValue([pane]);
    vi.mocked(isClaudePane).mockReturnValue(true);
    vi.mocked(getLatestSessionFileForCwd).mockResolvedValue({ sessionId: SESSION.sessionId, filePath: `/tmp/${SESSION.sessionId}.jsonl` });
    vi.mocked(readSessionLines).mockResolvedValue([]);
    vi.mocked(parseJsonlLines).mockReturnValue({ lastMessage: SESSION.lastMessage, cwd: SESSION.cwd, toolCalls: [], allMessages: [] });
    await bot.handleUpdate(commandUpdate("/sessions") as any);
    // Clear apiCalls after /sessions so we start fresh for the actual test assertions
    apiCalls.length = 0;
  }

  it("attaches immediately when Claude Code is already running", async () => {
    const { bot, apiCalls } = await makeBot();
    await setupWithSessions(bot, apiCalls);

    vi.mocked(findClaudePane).mockResolvedValue({ found: true, paneId: "%3" });
    vi.mocked(getAttachedSession).mockResolvedValue(null);

    await bot.handleUpdate(callbackUpdate("session:s1") as any);

    expect(writeFile).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("s1"),
      expect.anything()
    );
    const sendMessages = apiCalls.filter((c) => c.method === "sendMessage");
    const texts = sendMessages.map((c) => c.payload.text as string);
    expect(texts.some((t) => t.includes("Attached"))).toBe(true);
  });

  it("shows launch prompt when Claude Code is not running", async () => {
    const { bot, apiCalls } = await makeBot();
    await setupWithSessions(bot, apiCalls);

    vi.mocked(findClaudePane).mockResolvedValue({ found: false, reason: "no_claude_pane" });

    await bot.handleUpdate(callbackUpdate("session:s1") as any);

    const sendMessages = apiCalls.filter((c) => c.method === "sendMessage");
    const texts = sendMessages.map((c) => c.payload.text as string);
    expect(texts.some((t) => t.includes("Launch"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// launch: callbacks
// ---------------------------------------------------------------------------

describe("launch: callbacks", () => {
  const SESSION = {
    sessionId: "s1",
    cwd: "/proj/myproject",
    projectName: "myproject",
    lastMessage: "",
    mtime: new Date(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function setupWithSessions(bot: Awaited<ReturnType<typeof makeBot>>["bot"], apiCalls: ApiCall[]) {
    const pane = { paneId: "%1", cwd: SESSION.cwd, command: "claude", shellPid: 0 };
    vi.mocked(listTmuxPanes).mockResolvedValue([pane]);
    vi.mocked(isClaudePane).mockReturnValue(true);
    vi.mocked(getLatestSessionFileForCwd).mockResolvedValue({ sessionId: SESSION.sessionId, filePath: `/tmp/${SESSION.sessionId}.jsonl` });
    vi.mocked(readSessionLines).mockResolvedValue([]);
    vi.mocked(parseJsonlLines).mockReturnValue({ lastMessage: SESSION.lastMessage, cwd: SESSION.cwd, toolCalls: [], allMessages: [] });
    await bot.handleUpdate(commandUpdate("/sessions") as any);
    apiCalls.length = 0;
  }

  it("launch:cancel removes keyboard", async () => {
    const { bot, apiCalls } = await makeBot();
    await setupWithSessions(bot, apiCalls);

    await bot.handleUpdate(callbackUpdate("launch:cancel:s1") as any);

    const answers = apiCalls.filter((c) => c.method === "answerCallbackQuery");
    expect(answers.some((c) => c.payload.text === "Cancelled.")).toBe(true);
    const edits = apiCalls.filter((c) => c.method === "editMessageReplyMarkup");
    expect(edits.length).toBeGreaterThan(0);
  });

  it("launch:<id> launches Claude Code and shows launching message", async () => {
    const { bot, apiCalls } = await makeBot();
    await setupWithSessions(bot, apiCalls);

    vi.mocked(launchClaudeInWindow).mockResolvedValue("%9");
    // findClaudePane always returns found so the first poll (at t=2000ms) fires immediately
    vi.mocked(findClaudePane).mockResolvedValue({ found: true, paneId: "%9" });

    await bot.handleUpdate(callbackUpdate("launch:s1") as any);

    expect(launchClaudeInWindow).toHaveBeenCalledWith("/proj/myproject", "myproject", false);
    expect(writeFile).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("s1"),
      expect.anything()
    );

    const editTexts = apiCalls
      .filter((c) => c.method === "editMessageText")
      .map((c) => c.payload.text as string);
    expect(editTexts.some((t) => t.includes("Launching"))).toBe(true);

    // The polling loop waits 2000ms before the first findClaudePane call.
    // Give it a little extra buffer to fire and send the ready message.
    await new Promise((r) => setTimeout(r, 2100));

    const sendMessages = apiCalls.filter((c) => c.method === "sendMessage");
    const texts = sendMessages.map((c) => c.payload.text as string);
    expect(texts.some((t) => t.includes("ready"))).toBe(true);
  }, 10000);

  it("launch:skip:<id> launches with dangerously-skip-permissions", async () => {
    const { bot, apiCalls } = await makeBot();
    await setupWithSessions(bot, apiCalls);

    vi.mocked(launchClaudeInWindow).mockResolvedValue("%9");
    vi.mocked(findClaudePane).mockResolvedValue({ found: false, reason: "no_claude_pane" });

    await bot.handleUpdate(callbackUpdate("launch:skip:s1") as any);

    expect(launchClaudeInWindow).toHaveBeenCalledWith("/proj/myproject", "myproject", true);
  });
});

// ---------------------------------------------------------------------------
// /help command
// ---------------------------------------------------------------------------

describe("/help command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replies with a list including all major commands", async () => {
    const { bot, apiCalls } = await makeBot();
    await bot.handleUpdate(commandUpdate("/help") as any);
    const texts = apiCalls.filter((c) => c.method === "sendMessage").map((c) => c.payload.text as string);
    expect(texts.length).toBeGreaterThan(0);
    const combined = texts.join("\n");
    expect(combined).toMatch(/sessions/i);
    expect(combined).toMatch(/detach/i);
    expect(combined).toMatch(/status/i);
    expect(combined).toMatch(/help/i);
  });
});

// ---------------------------------------------------------------------------
// /restart command
// ---------------------------------------------------------------------------

describe("/restart command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replies with a restarting message", async () => {
    const { bot, apiCalls } = await makeBot();
    await bot.handleUpdate(commandUpdate("/restart") as any);
    const texts = apiCalls.filter((c) => c.method === "sendMessage").map((c) => c.payload.text as string);
    expect(texts.some((t) => /restart/i.test(t))).toBe(true);
  });

  it("persists chat-id before replying", async () => {
    const { bot } = await makeBot();
    await bot.handleUpdate(commandUpdate("/restart", 99999) as any);
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining("chat-id"),
      "99999",
      "utf8"
    );
  });
});

// ---------------------------------------------------------------------------
// /model command
// ---------------------------------------------------------------------------

describe("/model command", () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  // Run no-key test first — cache starts null, stays null (fetchModels returns [] without setting cache)
  it("shows fallback keyboard when ANTHROPIC_API_KEY is unset", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { bot, apiCalls } = await makeBot();
    await bot.handleUpdate(commandUpdate("/model") as any);

    const sends = apiCalls.filter((c) => c.method === "sendMessage");
    expect(sends.length).toBeGreaterThan(0);
    const keyboard = sends[0].payload.reply_markup as any;
    const labels = keyboard.inline_keyboard.flat().map((b: any) => b.text);
    expect(labels).toContain("Default (Sonnet)");
    expect(labels).toContain("Opus 4.6");
    expect(labels).toContain("Sonnet 4.6");
    expect(labels).toContain("Haiku 4.5");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Cache still null — fetch rejects → returns []
  it("shows fallback keyboard when API fetch fails", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    fetchSpy.mockRejectedValue(new Error("network error"));

    const { bot, apiCalls } = await makeBot();
    await bot.handleUpdate(commandUpdate("/model") as any);

    const sends = apiCalls.filter((c) => c.method === "sendMessage");
    const keyboard = sends[0].payload.reply_markup as any;
    const labels = keyboard.inline_keyboard.flat().map((b: any) => b.text);
    expect(labels).toContain("Default (Sonnet)");
    expect(labels).toContain("Opus 4.6");
  });

  // This test populates the cache — runs last in this describe block
  it("shows API models when fetch succeeds", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "claude-opus-4-6", display_name: "Claude Opus 4.6" },
          { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" },
        ],
      }),
    });

    const { bot, apiCalls } = await makeBot();
    await bot.handleUpdate(commandUpdate("/model") as any);

    const sends = apiCalls.filter((c) => c.method === "sendMessage");
    const keyboard = sends[0].payload.reply_markup as any;
    const labels = keyboard.inline_keyboard.flat().map((b: any) => b.text);
    expect(labels).toContain("Default (Sonnet)");
    expect(labels).toContain("Claude Opus 4.6");
    expect(labels).toContain("Claude Sonnet 4.6");
    // Should NOT have the hardcoded fallbacks
    expect(labels).not.toContain("Haiku 4.5");
  });
});

// ---------------------------------------------------------------------------
// model: callbacks
// ---------------------------------------------------------------------------

describe("model: callbacks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends /model command to tmux pane on happy path", async () => {
    const { bot, apiCalls } = await makeBot();

    vi.mocked(getAttachedSession).mockResolvedValue({ sessionId: "s1", cwd: "/proj" });
    vi.mocked(findClaudePane).mockResolvedValue({ found: true, paneId: "%3" });

    await bot.handleUpdate(callbackUpdate("model:claude-opus-4-6") as any);

    expect(sendKeysToPane).toHaveBeenCalledWith("%3", "/model claude-opus-4-6");
    const answers = apiCalls.filter((c) => c.method === "answerCallbackQuery");
    expect(answers.some((c) => c.payload.text === "Switched to claude-opus-4-6")).toBe(true);
    const edits = apiCalls.filter((c) => c.method === "editMessageText");
    expect(edits.some((c) => (c.payload.text as string).includes("claude-opus-4-6"))).toBe(true);
  });

  it("answers with error when no session is attached", async () => {
    const { bot, apiCalls } = await makeBot();

    vi.mocked(getAttachedSession).mockResolvedValue(null);

    await bot.handleUpdate(callbackUpdate("model:claude-opus-4-6") as any);

    const answers = apiCalls.filter((c) => c.method === "answerCallbackQuery");
    expect(answers.some((c) => c.payload.text === "No session attached.")).toBe(true);
    expect(sendKeysToPane).not.toHaveBeenCalled();
  });

  it("answers with error when no tmux pane is found", async () => {
    const { bot, apiCalls } = await makeBot();

    vi.mocked(getAttachedSession).mockResolvedValue({ sessionId: "s1", cwd: "/proj" });
    vi.mocked(findClaudePane).mockResolvedValue({ found: false, reason: "no_claude_pane" });

    await bot.handleUpdate(callbackUpdate("model:claude-opus-4-6") as any);

    const answers = apiCalls.filter((c) => c.method === "answerCallbackQuery");
    expect(answers.some((c) => c.payload.text === "Could not find the Claude Code tmux pane.")).toBe(true);
    expect(sendKeysToPane).not.toHaveBeenCalled();
  });
});
