import { describe, it, expect } from "vitest";
import { splitMessage } from "./utils.js";

describe("splitMessage", () => {
  it("returns single chunk when text fits within limit", () => {
    expect(splitMessage("hello", 100)).toEqual(["hello"]);
  });

  it("splits at newline boundary when text exceeds limit", () => {
    const text = "line one\nline two\nline three";
    const chunks = splitMessage(text, 15);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c) => expect(c.length).toBeLessThanOrEqual(15));
  });

  it("falls back to hard split when no newline found within limit", () => {
    const text = "a".repeat(50);
    const chunks = splitMessage(text, 20);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c) => expect(c.length).toBeLessThanOrEqual(20));
  });

  it("returns empty array for empty string", () => {
    expect(splitMessage("", 100)).toEqual([]);
  });
});
