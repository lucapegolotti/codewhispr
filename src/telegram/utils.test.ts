import { describe, it, expect } from "vitest";
import { splitMessage, splitAtTables } from "./utils.js";

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

describe("splitAtTables", () => {
  it("returns a single text part when there are no tables", () => {
    const parts = splitAtTables("Just some plain text.\nAnother line.");
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("text");
  });

  it("returns a single table part for a pure table", () => {
    const input = "| A | B |\n|---|---|\n| x | y |";
    const parts = splitAtTables(input);
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("table");
    if (parts[0].type === "table") {
      expect(parts[0].lines).toHaveLength(3);
    }
  });

  it("splits text/table/text correctly", () => {
    const input = "Intro\n| A |\n|---|\n| 1 |\nOutro";
    const parts = splitAtTables(input);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatchObject({ type: "text", content: "Intro" });
    expect(parts[1].type).toBe("table");
    expect(parts[2]).toMatchObject({ type: "text", content: "Outro" });
  });

  it("handles multiple tables separated by text", () => {
    const input = "Before\n| A |\n|---|\n| 1 |\nMiddle\n| B |\n|---|\n| 2 |\nAfter";
    const parts = splitAtTables(input);
    expect(parts).toHaveLength(5);
    expect(parts.filter((p) => p.type === "table")).toHaveLength(2);
    expect(parts.filter((p) => p.type === "text")).toHaveLength(3);
  });

  it("handles adjacent tables with no text between them", () => {
    const input = "| A |\n|---|\n| 1 |\n| B |\n|---|\n| 2 |";
    // All lines start with | so treated as one table block
    const parts = splitAtTables(input);
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("table");
  });
});
