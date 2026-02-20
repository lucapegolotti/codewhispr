import { describe, it, expect } from "vitest";
import { splitMessage } from "./notifications.js";

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
