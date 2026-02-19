import { describe, it, expect } from "vitest";
import { findBestPane, type TmuxPane } from "./tmux.js";

const panes: TmuxPane[] = [
  { paneId: "%1", command: "node", cwd: "/Users/luca/repositories/my-app", lastUsed: 100 },
  { paneId: "%2", command: "claude", cwd: "/Users/luca/repositories/my-app", lastUsed: 200 },
  { paneId: "%3", command: "claude", cwd: "/Users/luca/repositories/other-app", lastUsed: 150 },
  { paneId: "%4", command: "bash", cwd: "/Users/luca/repositories/my-app", lastUsed: 50 },
];

// Claude Code sets process.title to its version string (e.g. "2.1.47")
const versionPanes: TmuxPane[] = [
  { paneId: "%1", command: "node", cwd: "/Users/luca/repositories/my-app", lastUsed: 100 },
  { paneId: "%2", command: "2.1.47", cwd: "/Users/luca/repositories/my-app", lastUsed: 200 },
  { paneId: "%3", command: "2.1.47", cwd: "/Users/luca/repositories/other-app", lastUsed: 150 },
  { paneId: "%4", command: "bash", cwd: "/Users/luca/repositories/my-app", lastUsed: 50 },
];

describe("findBestPane", () => {
  it("returns pane running claude in matching cwd", () => {
    const result = findBestPane(panes, "/Users/luca/repositories/my-app");
    expect(result?.paneId).toBe("%2");
  });

  it("returns null when no claude pane matches cwd", () => {
    const result = findBestPane(panes, "/Users/luca/repositories/nonexistent");
    expect(result).toBeNull();
  });

  it("returns null when no claude panes exist", () => {
    const noClaude = panes.filter((p) => p.command !== "claude");
    const result = findBestPane(noClaude, "/Users/luca/repositories/my-app");
    expect(result).toBeNull();
  });

  it("picks most recently used when multiple claude panes share the same cwd", () => {
    const dupe: TmuxPane[] = [
      { paneId: "%2", command: "claude", cwd: "/Users/luca/repositories/my-app", lastUsed: 100 },
      { paneId: "%5", command: "claude", cwd: "/Users/luca/repositories/my-app", lastUsed: 300 },
    ];
    const result = findBestPane(dupe, "/Users/luca/repositories/my-app");
    expect(result?.paneId).toBe("%5");
  });

  it("falls back to parent directory match", () => {
    const result = findBestPane(panes, "/Users/luca/repositories/my-app/subdir");
    expect(result?.paneId).toBe("%2");
  });

  it("matches pane whose command is a version string (Claude Code sets process.title)", () => {
    const result = findBestPane(versionPanes, "/Users/luca/repositories/my-app");
    expect(result?.paneId).toBe("%2");
  });

  it("returns null for version panes when no cwd matches", () => {
    const result = findBestPane(versionPanes, "/Users/luca/repositories/nonexistent");
    expect(result).toBeNull();
  });
});
