import { describe, it, expect } from "vitest";
import { parseIntentResponse, Intent } from "./classifier.js";

describe("parseIntentResponse", () => {
  it("parses SUMMARY_REQUEST", () => {
    expect(parseIntentResponse("SUMMARY_REQUEST")).toBe(Intent.SUMMARY_REQUEST);
  });

  it("parses COMMAND_EXECUTION", () => {
    expect(parseIntentResponse("COMMAND_EXECUTION")).toBe(Intent.COMMAND_EXECUTION);
  });

  it("parses FOLLOW_UP_INPUT", () => {
    expect(parseIntentResponse("FOLLOW_UP_INPUT")).toBe(Intent.FOLLOW_UP_INPUT);
  });

  it("parses GENERAL_CHAT", () => {
    expect(parseIntentResponse("GENERAL_CHAT")).toBe(Intent.GENERAL_CHAT);
  });

  it("parses SESSION_LIST", () => {
    expect(parseIntentResponse("SESSION_LIST")).toBe(Intent.SESSION_LIST);
  });

  it("falls back to UNKNOWN for unrecognized text", () => {
    expect(parseIntentResponse("something random")).toBe(Intent.UNKNOWN);
  });

  it("is case-insensitive", () => {
    expect(parseIntentResponse("summary_request")).toBe(Intent.SUMMARY_REQUEST);
  });

  it("ignores surrounding whitespace", () => {
    expect(parseIntentResponse("  GENERAL_CHAT  ")).toBe(Intent.GENERAL_CHAT);
  });
});
