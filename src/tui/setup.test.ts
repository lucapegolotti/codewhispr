import { describe, it, expect } from "vitest";
import { escapeEnvValue } from "./setup.js";

describe("setup", () => {
  describe("escapeEnvValue", () => {
    it("escapes backslashes", () => {
      expect(escapeEnvValue("a\\b")).toBe("a\\\\b");
    });

    it("escapes double quotes", () => {
      expect(escapeEnvValue('a"b')).toBe('a\\"b');
    });

    it("escapes dollar signs", () => {
      expect(escapeEnvValue("a$b")).toBe("a\\$b");
    });

    it("escapes all special characters together", () => {
      expect(escapeEnvValue('tok\\en"$val')).toBe('tok\\\\en\\"\\$val');
    });

    it("leaves plain strings unchanged", () => {
      expect(escapeEnvValue("abc123:xyz")).toBe("abc123:xyz");
    });
  });
});
