/**
 * Tests for startMonitor's multiple-choice pane-capture path.
 *
 * We mock chokidar (so we control change events without touching the filesystem),
 * tmux (so no real terminal is needed), and fs/promises (so we return canned JSONL).
 * Fake timers let us skip the 3-second debounce without slowing the test suite.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vi.hoisted runs before any imports, so these values are available in vi.mock factories.
const { mockWatcher, watcherEmitter } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("events") as typeof import("events");
  const emitter = new EventEmitter();
  const watcher = {
    on(event: string, handler: (...args: unknown[]) => void) {
      emitter.on(event, handler);
      return this;
    },
    close: vi.fn(),
  };
  return { mockWatcher: watcher, watcherEmitter: emitter };
});

vi.mock("chokidar", () => ({
  default: { watch: vi.fn(() => mockWatcher) },
}));

vi.mock("./tmux.js", () => ({
  findClaudePane: vi.fn(),
  capturePaneContent: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
  stat: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  unlink: vi.fn(),
  appendFile: vi.fn(),
}));

import { startMonitor, WaitingType } from "./monitor.js";
import type { SessionWaitingState } from "./monitor.js";
import { findClaudePane, capturePaneContent } from "./tmux.js";
import { readFile } from "fs/promises";

const PLAN_APPROVAL_PANE = [
  "Claude has written up a plan and is ready to execute. Would you like to proceed?",
  "> 1. Yes, clear context (21% used) and bypass permissions",
  "  2. Yes, and bypass permissions",
  "  3. Yes, manually approve edits",
  "  4. Type here to tell Claude what to change",
  "ctrl-g to edit in Vim · ~/.claude/plans/hazy-purring-fog.md",
].join("\n");

function makeJsonl(text: string, cwd = "/test/project"): string {
  return (
    JSON.stringify({
      type: "assistant",
      cwd,
      message: { content: [{ type: "text", text }] },
    }) + "\n"
  );
}

// Fake JSONL path — must end in .jsonl and live under a project directory
const FAKE_PATH = "/home/user/.claude/projects/-test-project/abc123.jsonl";

describe("startMonitor — multiple choice detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls onWaiting with MULTIPLE_CHOICE when pane shows numbered choices", async () => {
    vi.mocked(readFile).mockResolvedValue(
      makeJsonl("❓ Claude Code needs your approval for the plan") as any
    );
    vi.mocked(findClaudePane).mockResolvedValue({ found: true, paneId: "%1" });
    vi.mocked(capturePaneContent).mockResolvedValue(PLAN_APPROVAL_PANE);

    const received: SessionWaitingState[] = [];
    const stop = startMonitor(async (state) => { received.push(state); });

    watcherEmitter.emit("change", FAKE_PATH);
    await vi.advanceTimersByTimeAsync(3100);

    stop();

    expect(received).toHaveLength(1);
    expect(received[0].waitingType).toBe(WaitingType.MULTIPLE_CHOICE);
    expect(received[0].choices).toEqual([
      "Yes, clear context (21% used) and bypass permissions",
      "Yes, and bypass permissions",
      "Yes, manually approve edits",
      "Type here to tell Claude what to change",
    ]);
  });

  it("does not call onWaiting when pane has no numbered choices", async () => {
    vi.mocked(readFile).mockResolvedValue(
      makeJsonl("I have finished implementing the feature.") as any
    );
    vi.mocked(findClaudePane).mockResolvedValue({ found: true, paneId: "%1" });
    vi.mocked(capturePaneContent).mockResolvedValue(
      "I have finished implementing the feature.\n$ "
    );

    const received: SessionWaitingState[] = [];
    const stop = startMonitor(async (state) => { received.push(state); });

    watcherEmitter.emit("change", FAKE_PATH);
    await vi.advanceTimersByTimeAsync(3100);

    stop();

    expect(received).toHaveLength(0);
  });

  it("does not call onWaiting when tmux pane is not found", async () => {
    vi.mocked(readFile).mockResolvedValue(
      makeJsonl("❓ Claude Code needs your approval for the plan") as any
    );
    vi.mocked(findClaudePane).mockResolvedValue({
      found: false,
      reason: "no_claude_pane",
    });

    const received: SessionWaitingState[] = [];
    const stop = startMonitor(async (state) => { received.push(state); });

    watcherEmitter.emit("change", FAKE_PATH);
    await vi.advanceTimersByTimeAsync(3100);

    stop();

    expect(received).toHaveLength(0);
  });

  it("does not call onWaiting again for the same assistant text", async () => {
    vi.mocked(readFile).mockResolvedValue(
      makeJsonl("❓ Claude Code needs your approval for the plan") as any
    );
    vi.mocked(findClaudePane).mockResolvedValue({ found: true, paneId: "%1" });
    vi.mocked(capturePaneContent).mockResolvedValue(PLAN_APPROVAL_PANE);

    const received: SessionWaitingState[] = [];
    const stop = startMonitor(async (state) => { received.push(state); });

    watcherEmitter.emit("change", FAKE_PATH);
    await vi.advanceTimersByTimeAsync(3100);

    // Second change event with identical text — should be deduplicated
    watcherEmitter.emit("change", FAKE_PATH);
    await vi.advanceTimersByTimeAsync(3100);

    stop();

    expect(received).toHaveLength(1);
  });
});
