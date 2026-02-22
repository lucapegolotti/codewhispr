import { describe, it, expect } from "vitest";
import { parseTableLines, preprocessCell, renderTableAsPng } from "./tableImage.js";

describe("preprocessCell", () => {
  it("replaces ✅ with ✓", () => {
    expect(preprocessCell("✅ Accepted")).toBe("✓ Accepted");
  });

  it("replaces ❌ with ✗", () => {
    expect(preprocessCell("❌ Skipped")).toBe("✗ Skipped");
  });

  it("strips unknown emoji", () => {
    expect(preprocessCell("🦊 fox")).toBe("fox");
  });

  it("leaves plain text unchanged", () => {
    expect(preprocessCell("Hello world")).toBe("Hello world");
  });
});

describe("parseTableLines", () => {
  it("extracts headers and rows, discarding separator lines", () => {
    const lines = ["| A | B |", "|---|---|", "| x | y |", "| p | q |"];
    const { headers, rows } = parseTableLines(lines);
    expect(headers).toEqual(["A", "B"]);
    expect(rows).toEqual([["x", "y"], ["p", "q"]]);
  });

  it("handles a header-only table", () => {
    const lines = ["| H1 | H2 |", "|---|---|"];
    const { headers, rows } = parseTableLines(lines);
    expect(headers).toEqual(["H1", "H2"]);
    expect(rows).toHaveLength(0);
  });

  it("strips leading/trailing pipes and trims whitespace", () => {
    const lines = ["| A |", "|---|", "|  hello  |"];
    const { headers, rows } = parseTableLines(lines);
    expect(headers).toEqual(["A"]);
    expect(rows[0]).toEqual(["hello"]);
  });
});

describe("renderTableAsPng", () => {
  it("returns a non-empty PNG buffer", () => {
    const lines = ["| File | Lines |", "|---|---|", "| bot.test.ts | 415 |"];
    const buf = renderTableAsPng(lines);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(100);
    // PNG magic bytes
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50); // P
    expect(buf[2]).toBe(0x4e); // N
    expect(buf[3]).toBe(0x47); // G
  });

  it("renders a table with emoji cells without throwing", () => {
    const lines = [
      "| State | Old | New |",
      "|---|---|---|",
      "| Empty | ❌ Skipped | ✅ Accepted |",
      "| snapshot | ✅ Skipped | ✅ Skipped |",
    ];
    expect(() => renderTableAsPng(lines)).not.toThrow();
  });

  it("produces wider images for more columns", () => {
    const narrow = renderTableAsPng(["| A |", "|---|", "| 1 |"]);
    const wide = renderTableAsPng(["| A | B | C | D |", "|---|---|---|---|", "| 1 | 2 | 3 | 4 |"]);
    // PNG width is encoded at bytes 16-19 as big-endian uint32
    const widthOf = (buf: Buffer) => buf.readUInt32BE(16);
    expect(widthOf(wide)).toBeGreaterThan(widthOf(narrow));
  });
});
