import { describe, it, expect, vi, beforeEach } from "vitest";
import { createBot } from "./bot.js";
import { findClaudePane, launchClaudeInWindow, killWindow } from "../session/tmux.js";
import { getAttachedSession, listSessions } from "../session/history.js";
import { handleTurn, clearChatState } from "../agent/loop.js";
import { unlink, writeFile } from "fs/promises";
import { watchForResponse, getFileSize } from "../session/monitor.js";

vi.mock("../session/tmux.js", () => ({
  findClaudePane: vi.fn(),
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
}));

vi.mock("../agent/loop.js", () => ({
  handleTurn: vi.fn(),
  clearChatState: vi.fn(),
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
    vi.mocked(listSessions).mockResolvedValue([SESSION]);
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
    cwd: "/proj",
    projectName: "myproject",
    lastMessage: "",
    mtime: new Date(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function setupWithSessions(bot: Awaited<ReturnType<typeof makeBot>>["bot"], apiCalls: ApiCall[]) {
    vi.mocked(listSessions).mockResolvedValue([SESSION]);
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

    expect(launchClaudeInWindow).toHaveBeenCalledWith("/proj", "myproject", false);
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

    expect(launchClaudeInWindow).toHaveBeenCalledWith("/proj", "myproject", true);
  });
});
