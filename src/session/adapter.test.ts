import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));
vi.mock("../narrator.js", () => ({ narrate: vi.fn(async (s: string) => s) }));
vi.mock("../logger.js", () => ({
  log: vi.fn(),
  logEmitter: { emit: vi.fn() },
}));
vi.mock("./history.js", () => ({
  getAttachedSession: vi.fn().mockResolvedValue(null),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { clearAdapterSession, getActiveSessions, runAgentTurn } from "./adapter.js";

beforeEach(() => vi.clearAllMocks());

describe("clearAdapterSession", () => {
  it("removes a session so it no longer appears in getActiveSessions", async () => {
    vi.mocked(query).mockImplementation(async function* () {
      yield { type: "system", subtype: "init", session_id: "abc-session-123" };
      yield { type: "result", subtype: "success", result: "done" };
    });

    await runAgentTurn(99, "do something");
    expect(getActiveSessions()).toContain(99);

    clearAdapterSession(99);
    expect(getActiveSessions()).not.toContain(99);
  });

  it("is a no-op for a chat ID with no session", () => {
    expect(() => clearAdapterSession(9999)).not.toThrow();
    expect(getActiveSessions()).not.toContain(9999);
  });
});
