import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared mock for the Anthropic messages.create function so we can control it per-test
// without fighting the module-level singleton in voice.ts.
const mockCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  // Must use a real function (not an arrow function) so it can be called with `new`
  function MockAnthropic() {
    return { messages: { create: mockCreate } };
  }
  return { default: MockAnthropic };
});

// Also mock openai so voice.ts can be imported without OPENAI_API_KEY
vi.mock("openai", () => {
  function MockOpenAI() {
    return {
      audio: {
        transcriptions: { create: vi.fn() },
        speech: { create: vi.fn() },
      },
    };
  }
  return { default: MockOpenAI };
});

import { polishTranscript } from "./voice.js";

beforeEach(() => vi.clearAllMocks());

describe("polishTranscript", () => {
  it("returns cleaned text from the model response", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "Run the test suite." }],
    });

    const result = await polishTranscript("uh run the uh tests please");
    expect(result).toBe("Run the test suite.");
  });

  it("passes the raw transcript in the user message content", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "Install dependencies." }],
    });

    await polishTranscript("install the things");
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            content: expect.stringContaining("install the things"),
          }),
        ]),
      })
    );
  });

  it("falls back to raw transcript when model returns a non-text block", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "tool_use", id: "x", name: "y", input: {} }],
    });

    const result = await polishTranscript("some raw input");
    expect(result).toBe("some raw input");
  });
});
