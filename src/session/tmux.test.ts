import { describe, it, expect } from "vitest";
import { findBestPane, type TmuxPane } from "./tmux.js";

const panes: TmuxPane[] = [
  { paneId: "%1", command: "node", cwd: "/Users/luca/repositories/my-app" },
  { paneId: "%2", command: "claude", cwd: "/Users/luca/repositories/my-app" },
  { paneId: "%3", command: "claude", cwd: "/Users/luca/repositories/other-app" },
  { paneId: "%4", command: "bash", cwd: "/Users/luca/repositories/my-app" },
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

  it("returns first claude pane when multiple match cwd", () => {
    const dupe: TmuxPane[] = [
      { paneId: "%2", command: "claude", cwd: "/Users/luca/repositories/my-app" },
      { paneId: "%5", command: "claude", cwd: "/Users/luca/repositories/my-app" },
    ];
    const result = findBestPane(dupe, "/Users/luca/repositories/my-app");
    expect(result?.paneId).toBe("%2");
  });

  it("falls back to parent directory match", () => {
    const result = findBestPane(panes, "/Users/luca/repositories/my-app/subdir");
    expect(result?.paneId).toBe("%2");
  });
});
