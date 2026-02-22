import { describe, it, expect } from "vitest";
import { findBestPane, type TmuxPane } from "./tmux.js";

const panes: TmuxPane[] = [
  { paneId: "%1", shellPid: 100, command: "node", cwd: "/Users/luca/repositories/my-app" },
  { paneId: "%2", shellPid: 200, command: "claude", cwd: "/Users/luca/repositories/my-app" },
  { paneId: "%3", shellPid: 300, command: "claude", cwd: "/Users/luca/repositories/other-app" },
  { paneId: "%4", shellPid: 400, command: "bash", cwd: "/Users/luca/repositories/my-app" },
];

// Claude Code sets process.title to its version string (e.g. "2.1.47")
const versionPanes: TmuxPane[] = [
  { paneId: "%1", shellPid: 100, command: "node", cwd: "/Users/luca/repositories/my-app" },
  { paneId: "%2", shellPid: 200, command: "2.1.47", cwd: "/Users/luca/repositories/my-app" },
  { paneId: "%3", shellPid: 300, command: "2.1.47", cwd: "/Users/luca/repositories/other-app" },
  { paneId: "%4", shellPid: 400, command: "bash", cwd: "/Users/luca/repositories/my-app" },
];

describe("findBestPane", () => {
  it("returns pane running claude in matching cwd", () => {
    const result = findBestPane(panes, "/Users/luca/repositories/my-app");
    expect(result.map((p) => p.paneId)).toEqual(["%2"]);
  });

  it("returns empty when no claude pane matches cwd", () => {
    const result = findBestPane(panes, "/Users/luca/repositories/nonexistent");
    expect(result).toHaveLength(0);
  });

  it("returns empty when no claude panes exist", () => {
    const noClaude = panes.filter((p) => p.command !== "claude");
    const result = findBestPane(noClaude, "/Users/luca/repositories/my-app");
    expect(result).toHaveLength(0);
  });

  it("returns all matching panes when multiple share the same cwd (caller resolves by start time)", () => {
    const dupe: TmuxPane[] = [
      { paneId: "%2", shellPid: 200, command: "claude", cwd: "/Users/luca/repositories/my-app" },
      { paneId: "%5", shellPid: 500, command: "claude", cwd: "/Users/luca/repositories/my-app" },
    ];
    const result = findBestPane(dupe, "/Users/luca/repositories/my-app");
    expect(result.map((p) => p.paneId)).toEqual(["%2", "%5"]);
  });

  it("falls back to parent directory match", () => {
    const result = findBestPane(panes, "/Users/luca/repositories/my-app/subdir");
    expect(result.map((p) => p.paneId)).toEqual(["%2"]);
  });

  it("matches pane whose command is a version string (Claude Code sets process.title)", () => {
    const result = findBestPane(versionPanes, "/Users/luca/repositories/my-app");
    expect(result.map((p) => p.paneId)).toEqual(["%2"]);
  });

  it("returns empty for version panes when no cwd matches", () => {
    const result = findBestPane(versionPanes, "/Users/luca/repositories/nonexistent");
    expect(result).toHaveLength(0);
  });
});

describe("launchClaudeInWindow and killWindow", () => {
  it("are exported from tmux.ts", async () => {
    const mod = await import("./tmux.js");
    expect(typeof mod.launchClaudeInWindow).toBe("function");
    expect(typeof mod.killWindow).toBe("function");
  });
});

describe("sendInterrupt", () => {
  it("is exported from tmux.ts", async () => {
    const mod = await import("./tmux.js");
    expect(typeof mod.sendInterrupt).toBe("function");
  });
});
