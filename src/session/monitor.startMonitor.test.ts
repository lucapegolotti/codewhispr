/**
 * Tests for startMonitor's waiting-state detection.
 *
 * We mock chokidar (so we control change events without touching the filesystem),
 * and fs/promises (so we return canned JSONL).
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

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
  stat: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  unlink: vi.fn(),
  appendFile: vi.fn(),
  realpath: vi.fn().mockImplementation(async (p: string) => p),
}));

import { startMonitor, WaitingType } from "./monitor.js";
import type { SessionWaitingState } from "./monitor.js";
import { readFile } from "fs/promises";

const HARDCODED_CHOICES = [
  "Yes, clear context and bypass permissions",
  "Yes, bypass permissions",
  "Yes, manually approve edits",
  "Type here to tell Claude what to change",
];

function makeJsonl(text: string, cwd = "/test/project"): string {
  return (
    JSON.stringify({
      type: "assistant",
      cwd,
      message: { content: [{ type: "text", text }] },
    }) + "\n"
  );
}

function makeExitPlanModeJsonl(cwd = "/test/project"): string {
  return (
    JSON.stringify({
      type: "assistant",
      cwd,
      message: {
        content: [
          { type: "tool_use", id: "toolu_exitplan", name: "ExitPlanMode", input: {} },
        ],
      },
    }) + "\n"
  );
}

function makeExitPlanModeWithPlanInputJsonl(plan: string, cwd = "/test/project"): string {
  return (
    JSON.stringify({
      type: "assistant",
      cwd,
      message: {
        content: [
          { type: "tool_use", id: "toolu_exitplan", name: "ExitPlanMode", input: { plan } },
        ],
      },
    }) + "\n"
  );
}

function makeExitPlanModeWithTextJsonl(text: string, cwd = "/test/project"): string {
  return (
    JSON.stringify({
      type: "assistant",
      cwd,
      message: {
        content: [
          { type: "text", text },
          { type: "tool_use", id: "toolu_exitplan", name: "ExitPlanMode", input: {} },
        ],
      },
    }) + "\n"
  );
}

// Fake JSONL path — must end in .jsonl and live under a project directory
const FAKE_PATH = "/home/user/.claude/projects/-test-project/abc123.jsonl";

describe("startMonitor — waiting-state detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires MULTIPLE_CHOICE with hardcoded choices when ExitPlanMode entry is detected", async () => {
    vi.mocked(readFile).mockResolvedValue(makeExitPlanModeJsonl() as any);

    const received: SessionWaitingState[] = [];
    const stop = startMonitor(async (state) => { received.push(state); });

    watcherEmitter.emit("change", FAKE_PATH);
    await vi.advanceTimersByTimeAsync(3100);

    stop();

    expect(received).toHaveLength(1);
    expect(received[0].waitingType).toBe(WaitingType.MULTIPLE_CHOICE);
    expect(received[0].choices).toEqual(HARDCODED_CHOICES);
  });

  it("sets prompt to the accompanying text block when present", async () => {
    vi.mocked(readFile).mockResolvedValue(
      makeExitPlanModeWithTextJsonl("Here is the plan...") as any
    );

    const received: SessionWaitingState[] = [];
    const stop = startMonitor(async (state) => { received.push(state); });

    watcherEmitter.emit("change", FAKE_PATH);
    await vi.advanceTimersByTimeAsync(3100);

    stop();

    expect(received).toHaveLength(1);
    expect(received[0].waitingType).toBe(WaitingType.MULTIPLE_CHOICE);
    expect(received[0].prompt).toBe("Here is the plan...");
    expect(received[0].choices).toEqual(HARDCODED_CHOICES);
  });

  it("does not call onWaiting again for the same ExitPlanMode entry (dedup)", async () => {
    vi.mocked(readFile).mockResolvedValue(makeExitPlanModeJsonl() as any);

    const received: SessionWaitingState[] = [];
    const stop = startMonitor(async (state) => { received.push(state); });

    watcherEmitter.emit("change", FAKE_PATH);
    await vi.advanceTimersByTimeAsync(3100);

    // Second change event with identical content — should be deduplicated
    watcherEmitter.emit("change", FAKE_PATH);
    await vi.advanceTimersByTimeAsync(3100);

    stop();

    expect(received).toHaveLength(1);
  });

  it("does not call onWaiting for a plain text entry with no waiting pattern", async () => {
    vi.mocked(readFile).mockResolvedValue(
      makeJsonl("I have finished implementing the feature.") as any
    );

    const received: SessionWaitingState[] = [];
    const stop = startMonitor(async (state) => { received.push(state); });

    watcherEmitter.emit("change", FAKE_PATH);
    await vi.advanceTimersByTimeAsync(3100);

    stop();

    expect(received).toHaveLength(0);
  });

  it("false-positive regression: numbered list text with no ExitPlanMode does not call onWaiting", async () => {
    vi.mocked(readFile).mockResolvedValue(
      makeJsonl("1. Add X\n2. Refactor Y") as any
    );

    const received: SessionWaitingState[] = [];
    const stop = startMonitor(async (state) => { received.push(state); });

    watcherEmitter.emit("change", FAKE_PATH);
    await vi.advanceTimersByTimeAsync(3100);

    stop();

    expect(received).toHaveLength(0);
  });

  it("uses input.plan as prompt when ExitPlanMode has plan in input", async () => {
    vi.mocked(readFile).mockResolvedValue(
      makeExitPlanModeWithPlanInputJsonl("## My Plan\n1. Step one\n2. Step two") as any
    );

    const received: SessionWaitingState[] = [];
    const stop = startMonitor(async (state) => { received.push(state); });

    watcherEmitter.emit("change", FAKE_PATH);
    await vi.advanceTimersByTimeAsync(3100);

    stop();

    expect(received).toHaveLength(1);
    expect(received[0].waitingType).toBe(WaitingType.MULTIPLE_CHOICE);
    expect(received[0].prompt).toBe("## My Plan\n1. Step one\n2. Step two");
    expect(received[0].choices).toEqual(HARDCODED_CHOICES);
  });

  it("YES_NO pattern fires directly without ExitPlanMode", async () => {
    vi.mocked(readFile).mockResolvedValue(
      makeJsonl("Should I delete the file? (y/n)") as any
    );

    const received: SessionWaitingState[] = [];
    const stop = startMonitor(async (state) => { received.push(state); });

    watcherEmitter.emit("change", FAKE_PATH);
    await vi.advanceTimersByTimeAsync(3100);

    stop();

    expect(received).toHaveLength(1);
    expect(received[0].waitingType).toBe(WaitingType.YES_NO);
  });
});
