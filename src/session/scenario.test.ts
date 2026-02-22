/**
 * Scenario tests for session-handling bugs.
 *
 * These tests replay real bug scenarios using a real filesystem and a minimal
 * JSONL fixture script (derived from actual session logs).  No Telegram API or
 * Claude Code process is needed — only the session-management primitives
 * (getLatestSessionFileForCwd + watchForResponse).
 *
 * Testing strategy: each bug fix should include a scenario test that reproduces
 * the failure mode so we catch regressions without needing a live environment.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdir, mkdtemp, writeFile, appendFile, rm, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { getLatestSessionFileForCwd, PROJECTS_PATH, ATTACHED_SESSION_PATH } from "./history.js";
import { watchForResponse, getFileSize, startMonitor, WaitingType } from "./monitor.js";
import type { SessionResponseState, SessionWaitingState } from "./monitor.js";
import { splitAtTables } from "../telegram/utils.js";
import { renderTableAsPng } from "../telegram/tableImage.js";
import { startInjectionWatcher, clearActiveWatcher } from "../telegram/handlers/text.js";

// ---------------------------------------------------------------------------
// JSONL fixture helpers — minimal representations of what Claude Code writes
// ---------------------------------------------------------------------------

function assistantEntry(text: string, cwd = "/tmp/proj"): string {
  return JSON.stringify({ type: "assistant", cwd, message: { content: [{ type: "text", text }] } }) + "\n";
}

function resultEntry(): string {
  return JSON.stringify({ type: "result", source: "stop-hook" }) + "\n";
}

// Fixture derived from the real "What kind of tests do we have in place" response
// that failed to reach Telegram (the /clear session rotation bug).
const TABLE_RESPONSE = `The project has 10 test files in \`src/\`:

| File | What it tests |
|---|---|
| \`src/config/config.test.ts\` | Configuration loading/validation |
| \`src/session/history.test.ts\` | Session history management |
| \`src/session/monitor.test.ts\` | Session monitoring |
| \`src/session/tmux.test.ts\` | tmux integration |
| \`src/telegram/bot.test.ts\` | Telegram bot core |

**Test framework: Vitest** (\`vitest run\` / \`vitest\` for watch mode)`;

// ---------------------------------------------------------------------------
// Scenario: user does /clear then sends a message
//
// Bug: after /clear Claude Code creates a new empty session JSONL.
// snapshotBaseline called getLatestSessionFileForCwd which skipped the empty
// file (no assistant messages) and returned the old session instead.
// watchForResponse then watched the wrong file and the response was never
// forwarded to Telegram.
// ---------------------------------------------------------------------------

describe("scenario: /clear then new message", () => {
  let projectDir: string;

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("watchForResponse fires on the new empty session, not the old one", async () => {
    const testId = Date.now();
    const fakeCwd = `/cv-scenario-clear-${testId}`;
    const encodedCwd = fakeCwd.replace(/[^a-zA-Z0-9]/g, "-");
    projectDir = join(PROJECTS_PATH, encodedCwd);
    await mkdir(projectDir, { recursive: true });

    // --- state before /clear: old session with conversation history ---
    const oldSessionFile = join(projectDir, "session-old.jsonl");
    await writeFile(oldSessionFile, assistantEntry("Previous response from last session"));
    await new Promise((r) => setTimeout(r, 20)); // ensure distinct mtime

    // --- state after /clear: new session with only metadata (file-history-snapshot),
    //     which is what Claude Code writes immediately after creating a new session.
    //     This was the real failure mode: the non-empty metadata-only file was being
    //     skipped by hasOnlyNonAssistantContent, causing the old session to be returned.
    const newSessionFile = join(projectDir, "session-new.jsonl");
    const fileHistorySnapshot = JSON.stringify({ type: "file-history-snapshot", files: [] }) + "\n";
    await writeFile(newSessionFile, fileHistorySnapshot);

    // 1. snapshotBaseline equivalent: find the latest session file
    const latest = await getLatestSessionFileForCwd(fakeCwd);
    expect(latest).not.toBeNull();
    expect(latest!.sessionId).toBe("session-new"); // must be the new session, not old

    const baseline = await getFileSize(latest!.filePath);

    // 2. Start watching the new session file
    const received: SessionResponseState[] = [];
    let completed = false;
    const stop = watchForResponse(
      latest!.filePath,
      baseline,
      async (state) => { received.push(state); },
      undefined,
      () => { completed = true; },
    );

    // 3. Simulate Claude Code writing a response to the new session
    //    (fixture script derived from a real session log)
    await new Promise((r) => setTimeout(r, 50));
    await appendFile(newSessionFile, assistantEntry("The project has 10 test files in src/"));
    await new Promise((r) => setTimeout(r, 50));
    await appendFile(newSessionFile, resultEntry());

    // 4. Wait for the watcher to fire
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (completed) { clearInterval(interval); resolve(); }
      }, 50);
      setTimeout(() => { clearInterval(interval); resolve(); }, 3000);
    });

    stop();

    expect(received.length).toBeGreaterThan(0);
    expect(received[received.length - 1].text).toContain("10 test files");
    expect(completed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario: /clear then question — full two-message bot flow
//
// This is the end-to-end version of the previous test. It simulates the real
// sequence of two separate Telegram messages:
//
//   Message 1: "/clear"
//     snapshotBaseline called → old session captured (new file doesn't exist yet)
//     /clear injected into tmux
//     Claude Code creates new session file with file-history-snapshot metadata
//     startInjectionWatcher set up on old file (no response expected for /clear)
//
//   Message 2: question
//     snapshotBaseline called again → MUST return new session (not old)
//     startInjectionWatcher switches to new session file
//     Response written to new session → delivered
//
// Bug reproduced: hasOnlyNonAssistantContent skipped the new metadata-only file
// and returned the old session, so the watcher watched the wrong file forever.
// ---------------------------------------------------------------------------

describe("scenario: /clear then question — two-message flow end-to-end", () => {
  let projectDir: string;

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("snapshotBaseline after /clear points at new session; watchForResponse delivers the response", async () => {
    const testId = Date.now();
    const fakeCwd = `/cv-scenario-e2e-${testId}`;
    const encodedCwd = fakeCwd.replace(/[^a-zA-Z0-9]/g, "-");
    projectDir = join(PROJECTS_PATH, encodedCwd);
    await mkdir(projectDir, { recursive: true });

    // --- Message 1: /clear ---
    // State at snapshotBaseline time: only the old session exists.
    const oldSessionFile = join(projectDir, "session-old.jsonl");
    await writeFile(oldSessionFile, assistantEntry("Previous response"));
    await new Promise((r) => setTimeout(r, 20)); // ensure distinct mtime

    // snapshotBaseline for /clear → returns old session (new file not created yet)
    const baselineForClear = await getLatestSessionFileForCwd(fakeCwd);
    expect(baselineForClear!.sessionId).toBe("session-old");

    // /clear injected → Claude Code creates new session with file-history-snapshot
    const newSessionFile = join(projectDir, "session-new.jsonl");
    const fileHistorySnapshot = JSON.stringify({ type: "file-history-snapshot", files: [] }) + "\n";
    await writeFile(newSessionFile, fileHistorySnapshot);
    await new Promise((r) => setTimeout(r, 20)); // ensure new file has later mtime

    // --- Message 2: question ---
    // snapshotBaseline for question → must return new session (not old)
    const baselineForQuestion = await getLatestSessionFileForCwd(fakeCwd);
    expect(baselineForQuestion).not.toBeNull();
    expect(baselineForQuestion!.sessionId).toBe("session-new");

    const baseline = await getFileSize(baselineForQuestion!.filePath);

    // Start watching the new session file (as startInjectionWatcher would)
    const received: SessionResponseState[] = [];
    let completed = false;
    const stop = watchForResponse(
      baselineForQuestion!.filePath,
      baseline,
      async (state) => { received.push(state); },
      undefined,
      () => { completed = true; },
    );

    // Simulate Claude responding in the new session
    await new Promise((r) => setTimeout(r, 50));
    await appendFile(newSessionFile, assistantEntry("No, Ctrl+C does not fire a Stop hook."));
    await new Promise((r) => setTimeout(r, 50));
    await appendFile(newSessionFile, resultEntry());

    // Wait for delivery
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (completed) { clearInterval(interval); resolve(); }
      }, 50);
      setTimeout(() => { clearInterval(interval); resolve(); }, 3000);
    });
    stop();

    expect(completed).toBe(true);
    expect(received.length).toBeGreaterThan(0);
    expect(received[received.length - 1].text).toContain("Ctrl+C");
  });
});

// ---------------------------------------------------------------------------
// Scenario: interrupt mid-turn — new watcher starts from post-interrupt baseline
//
// Reproduces the interrupt feature flow:
//   1. Old watcher is active while Claude is mid-turn (partial output written)
//   2. New message arrives: old watcher is stopped and its onComplete is called
//   3. A new baseline is taken AFTER the interrupted output (the 600ms wait in
//      processTextTurn ensures Claude has flushed the interrupted state)
//   4. New watcher is started from the new baseline and delivers only the new
//      turn's response — the interrupted partial output is excluded.
// ---------------------------------------------------------------------------

describe("scenario: interrupt mid-turn — new watcher sees only new turn", () => {
  let projectDir: string;

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("old onComplete fires and new watcher ignores interrupted output", async () => {
    const testId = Date.now();
    const fakeCwd = `/cv-scenario-interrupt-${testId}`;
    const encodedCwd = fakeCwd.replace(/[^a-zA-Z0-9]/g, "-");
    projectDir = join(PROJECTS_PATH, encodedCwd);
    await mkdir(projectDir, { recursive: true });

    const sessionFile = join(projectDir, "session-interrupt.jsonl");
    await writeFile(sessionFile, "");
    const oldBaseline = await getFileSize(sessionFile);

    // Start old watcher (simulating a turn that's in progress)
    let oldOnCompleteCalled = false;
    const oldStop = watchForResponse(
      sessionFile,
      oldBaseline,
      async () => {},
      undefined,
      () => { oldOnCompleteCalled = true; },
    );

    // Claude writes partial output mid-turn (no result entry yet)
    await appendFile(sessionFile, assistantEntry("Partial output from interrupted turn"));
    await new Promise((r) => setTimeout(r, 50));

    // Interrupt: stop old watcher (as processTextTurn does) and call its onComplete
    // (simulates clearing the typing interval)
    oldStop();
    // Simulate calling activeWatcherOnComplete?.()
    oldOnCompleteCalled = true;

    // Take new baseline AFTER the interrupted output (as processTextTurn does after 600ms)
    const postInterruptBaseline = await getFileSize(sessionFile);

    // Start new watcher from post-interrupt baseline
    const newReceived: SessionResponseState[] = [];
    let newCompleted = false;
    const newStop = watchForResponse(
      sessionFile,
      postInterruptBaseline,
      async (state) => { newReceived.push(state); },
      undefined,
      () => { newCompleted = true; },
    );

    // Claude responds to the new message
    await new Promise((r) => setTimeout(r, 50));
    await appendFile(sessionFile, assistantEntry("Response to the new message after interrupt"));
    await new Promise((r) => setTimeout(r, 50));
    await appendFile(sessionFile, resultEntry());

    // Wait for new watcher to fire
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (newCompleted) { clearInterval(interval); resolve(); }
      }, 50);
      setTimeout(() => { clearInterval(interval); resolve(); }, 3000);
    });
    newStop();

    // Old watcher's onComplete was called (typing interval cleared)
    expect(oldOnCompleteCalled).toBe(true);

    // New watcher delivers only the new turn's content
    expect(newCompleted).toBe(true);
    expect(newReceived.length).toBeGreaterThan(0);
    const deliveredText = newReceived[newReceived.length - 1].text;
    expect(deliveredText).toContain("new message after interrupt");
    // Baseline excludes the interrupted partial output
    expect(deliveredText).not.toContain("Partial output from interrupted turn");
  });
});

// ---------------------------------------------------------------------------
// Scenario: response containing a markdown table is detected and rendered
//
// Verifies the full pipeline from raw JSONL text → watchForResponse fires →
// splitAtTables detects the table → renderTableAsPng produces a valid PNG.
// Derived from the real "What kind of tests do we have in place" response that
// first exposed the table-rendering problem.
// ---------------------------------------------------------------------------

describe("scenario: response with table is detected and rendered as PNG", () => {
  let projectDir: string;

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("watchForResponse delivers text that splitAtTables splits into text+table parts, each renderable", async () => {
    const testId = Date.now();
    const fakeCwd = `/cv-scenario-table-${testId}`;
    const encodedCwd = fakeCwd.replace(/[^a-zA-Z0-9]/g, "-");
    projectDir = join(PROJECTS_PATH, encodedCwd);
    await mkdir(projectDir, { recursive: true });

    const sessionFile = join(projectDir, "session-table.jsonl");
    await writeFile(sessionFile, "");
    const baseline = await getFileSize(sessionFile);

    // Collect the delivered response text
    const received: SessionResponseState[] = [];
    let completed = false;
    const stop = watchForResponse(
      sessionFile,
      baseline,
      async (state) => { received.push(state); },
      undefined,
      () => { completed = true; },
    );

    // Simulate Claude Code writing the fixture response (table included)
    await new Promise((r) => setTimeout(r, 50));
    await appendFile(sessionFile, assistantEntry(TABLE_RESPONSE));
    await new Promise((r) => setTimeout(r, 50));
    await appendFile(sessionFile, resultEntry());

    // Wait for completion
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (completed) { clearInterval(interval); resolve(); }
      }, 50);
      setTimeout(() => { clearInterval(interval); resolve(); }, 3000);
    });
    stop();

    expect(completed).toBe(true);
    expect(received.length).toBeGreaterThan(0);

    const responseText = received[received.length - 1].text;

    // splitAtTables must find exactly one table part and two text parts
    const parts = splitAtTables(responseText);
    const tableParts = parts.filter((p) => p.type === "table");
    const textParts = parts.filter((p) => p.type === "text");
    expect(tableParts).toHaveLength(1);
    expect(textParts).toHaveLength(2); // intro text + trailing bold line

    // The table part must render to a valid PNG
    const tableLines = (tableParts[0] as { type: "table"; lines: string[] }).lines;
    const png = renderTableAsPng(tableLines);
    expect(png[0]).toBe(0x89); // PNG magic bytes
    expect(png[1]).toBe(0x50); // P
    expect(png[2]).toBe(0x4e); // N
    expect(png[3]).toBe(0x47); // G
    expect(png.length).toBeGreaterThan(1000);
  });
});

// ---------------------------------------------------------------------------
// Scenario: ExitPlanMode detection — real filesystem, real chokidar
//
// Verifies that startMonitor fires onWaiting(MULTIPLE_CHOICE) when a JSONL
// file containing an ExitPlanMode tool_use entry is written to disk.
// tmux is mocked so no real terminal is needed; everything else is real
// (filesystem writes, chokidar file watching, 3-second debounce).
// ---------------------------------------------------------------------------

function exitPlanModeEntry(cwd = "/tmp/proj"): string {
  return (
    JSON.stringify({
      type: "assistant",
      cwd,
      message: {
        content: [{ type: "tool_use", id: "toolu_1", name: "ExitPlanMode", input: {} }],
      },
    }) + "\n"
  );
}

function exitPlanModeWithPlanEntry(plan: string, cwd = "/tmp/proj"): string {
  return (
    JSON.stringify({
      type: "assistant",
      cwd,
      message: {
        content: [{ type: "tool_use", id: "toolu_smoke", name: "ExitPlanMode", input: { plan } }],
      },
    }) + "\n"
  );
}

// ---------------------------------------------------------------------------
// Scenario: false-positive prevention — numbered list does NOT trigger pane capture
//
// A regular assistant response that contains a numbered list (e.g. plan steps
// written as plain text) must NOT cause findClaudePane to be called. Only
// entries that contain an actual ExitPlanMode tool_use block should trigger
// the pane-capture path in startMonitor.
// ---------------------------------------------------------------------------

describe("scenario: false-positive prevention — numbered list does not trigger onWaiting", () => {
  let testRoot: string;

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it("numbered-list text with no ExitPlanMode does not fire onWaiting", async () => {
    const testId = Date.now();
    const fakeCwd = `/cv-scenario-falsepos-${testId}`;
    const encodedCwd = fakeCwd.replace(/[^a-zA-Z0-9]/g, "-");
    testRoot = await mkdtemp(join(tmpdir(), "cv-test-falsepos-"));
    const projectDir = join(testRoot, encodedCwd);
    await mkdir(projectDir, { recursive: true });

    // Plain assistant entry with numbered list — no ExitPlanMode tool_use
    const numberedListEntry =
      JSON.stringify({
        type: "assistant",
        cwd: fakeCwd,
        message: { content: [{ type: "text", text: "1. Add X\n2. Refactor Y\n3. Write tests" }] },
      }) + "\n";

    const sessionFile = join(projectDir, `session-falsepos-${testId}.jsonl`);
    await writeFile(sessionFile, numberedListEntry);

    const received: SessionWaitingState[] = [];
    const stop = startMonitor(async (s) => { received.push(s); }, testRoot);

    // Let chokidar initialize
    await new Promise((r) => setTimeout(r, 200));

    // Trigger a change event
    await appendFile(sessionFile, "\n");

    // Wait for the 3-second debounce + buffer
    await new Promise((r) => setTimeout(r, 3500));

    stop();

    expect(received).toHaveLength(0);
  }, 10_000);
});

describe("scenario: ExitPlanMode detection — real filesystem, real chokidar", () => {
  let testRoot: string;

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it("startMonitor fires MULTIPLE_CHOICE with hardcoded choices when ExitPlanMode entry appears on disk", async () => {
    const testId = Date.now();
    const fakeCwd = `/cv-scenario-exitplan-${testId}`;
    const encodedCwd = fakeCwd.replace(/[^a-zA-Z0-9]/g, "-");
    testRoot = await mkdtemp(join(tmpdir(), "cv-test-exitplan-"));
    const projectDir = join(testRoot, encodedCwd);
    await mkdir(projectDir, { recursive: true });

    // Write the JSONL file with an ExitPlanMode entry before startMonitor so
    // chokidar can pick it up on the first change event.
    const sessionFile = join(projectDir, `session-exitplan-${testId}.jsonl`);
    await writeFile(sessionFile, exitPlanModeEntry(fakeCwd));

    const received: SessionWaitingState[] = [];
    const stop = startMonitor(async (s) => { received.push(s); }, testRoot);

    // Let chokidar initialize and register the file
    await new Promise((r) => setTimeout(r, 200));

    // Trigger a change event that chokidar will detect
    await appendFile(sessionFile, "\n");

    // Wait for the 3-second debounce + buffer
    await new Promise((r) => setTimeout(r, 3500));

    stop();

    expect(received).toHaveLength(1);
    expect(received[0].waitingType).toBe(WaitingType.MULTIPLE_CHOICE);
    expect(received[0].choices).toEqual([
      "Yes, clear context and bypass permissions",
      "Yes, bypass permissions",
      "Yes, manually approve edits",
      "Type here to tell Claude what to change",
    ]);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Scenario: ExitPlanMode with input.plan delivers plan text as prompt
//
// Smoke test for the bug where ExitPlanMode sent an empty `prompt` to Telegram
// because the plan text lives in `input.plan` of the tool_use block, not in a
// text block. Verifies that startMonitor fires onWaiting with prompt equal to
// the plan text from input.plan.
// ---------------------------------------------------------------------------

describe("scenario: ExitPlanMode with input.plan delivers plan text as prompt (real filesystem)", () => {
  const HARDCODED_CHOICES = [
    "Yes, clear context and bypass permissions",
    "Yes, bypass permissions",
    "Yes, manually approve edits",
    "Type here to tell Claude what to change",
  ];

  let testRoot: string;

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it("startMonitor fires MULTIPLE_CHOICE with prompt equal to input.plan text", async () => {
    const testId = Date.now();
    const fakeCwd = `/cv-scenario-plantext-${testId}`;
    const encodedCwd = fakeCwd.replace(/[^a-zA-Z0-9]/g, "-");
    testRoot = await mkdtemp(join(tmpdir(), "cv-test-plantext-"));
    const projectDir = join(testRoot, encodedCwd);
    await mkdir(projectDir, { recursive: true });

    const PLAN_TEXT = "## Smoke plan\n1. Step A\n2. Step B";

    const sessionFile = join(projectDir, `session-plantext-${testId}.jsonl`);
    await writeFile(sessionFile, exitPlanModeWithPlanEntry(PLAN_TEXT, fakeCwd));

    const received: SessionWaitingState[] = [];
    const stop = startMonitor(async (s) => { received.push(s); }, testRoot);

    // Let chokidar initialize and register the file
    await new Promise((r) => setTimeout(r, 200));

    // Trigger a change event
    await appendFile(sessionFile, "\n");

    // Wait for the 3-second debounce + buffer
    await new Promise((r) => setTimeout(r, 3500));

    stop();

    expect(received).toHaveLength(1);
    expect(received[0].waitingType).toBe(WaitingType.MULTIPLE_CHOICE);
    expect(received[0].prompt).toBe(PLAN_TEXT);
    expect(received[0].choices).toEqual(HARDCODED_CHOICES);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Scenario: session rotation during active watcher (compaction / plan approval)
//
// Bug: watchForResponse watches a specific file path. When Claude Code compresses
// context and rotates to a new JSONL session file, the watcher becomes blind.
// pollForPostCompactionSession should detect the new file and restart the watcher.
//
// Flow:
//   1. Session A exists with pre-rotation content
//   2. startInjectionWatcher starts watching session A
//   3. Session B is created (simulating rotation) with a new response + result
//   4. pollForPostCompactionSession detects session B and restarts the watcher
//   5. onResponse fires with session B's text
// ---------------------------------------------------------------------------

describe("scenario: session rotation during active watcher (compaction)", () => {
  let projectDir: string;
  let savedAttached: string | null = null;

  // Save the real attached session so pollForPostCompactionSession (which writes
  // the test session to ATTACHED_SESSION_PATH) doesn't clobber the live bot's state.
  beforeEach(async () => {
    savedAttached = await readFile(ATTACHED_SESSION_PATH, "utf8").catch(() => null);
  });

  afterEach(async () => {
    clearActiveWatcher();
    await rm(projectDir, { recursive: true, force: true });
    if (savedAttached !== null) {
      await writeFile(ATTACHED_SESSION_PATH, savedAttached, "utf8").catch(() => {});
    }
  });

  it("pollForPostCompactionSession detects new session and delivers the response", async () => {
    const testId = Date.now();
    const fakeCwd = `/cv-scenario-rotation-${testId}`;
    const encodedCwd = fakeCwd.replace(/[^a-zA-Z0-9]/g, "-");
    projectDir = join(PROJECTS_PATH, encodedCwd);
    await mkdir(projectDir, { recursive: true });

    // Session A: existing session with pre-rotation content
    const sessionA = join(projectDir, "session-a.jsonl");
    await writeFile(sessionA, assistantEntry("Pre-rotation response"));

    const baseline = await getFileSize(sessionA);

    // Start watching session A via startInjectionWatcher
    const received: SessionResponseState[] = [];
    let completed = false;
    const attached = { sessionId: "session-a", cwd: fakeCwd };
    const preBaseline = { filePath: sessionA, sessionId: "session-a", size: baseline };

    await startInjectionWatcher(
      attached,
      0,
      async (state) => { received.push(state); },
      () => { completed = true; },
      preBaseline
    );

    // Session B: new session file created by compaction/rotation.
    // Write the assistant entry first (no result yet) so the poll detects the
    // new file and starts a chokidar watcher on it.
    await new Promise((r) => setTimeout(r, 500));
    const sessionB = join(projectDir, "session-b.jsonl");
    await writeFile(sessionB, assistantEntry("Response after compaction"));

    // Wait for the poll to detect session B (~3s poll interval) and start a
    // new chokidar watcher. Then append the result entry — the chokidar change
    // event triggers the watcher to read the file and fire onResponse.
    await new Promise((r) => setTimeout(r, 5000));
    await appendFile(sessionB, resultEntry());

    // Wait for the watcher to fire
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (received.length > 0) { clearInterval(interval); resolve(); }
      }, 100);
      setTimeout(() => { clearInterval(interval); resolve(); }, 10_000);
    });

    expect(received.length).toBeGreaterThan(0);
    expect(received[received.length - 1].text).toContain("after compaction");
  }, 20_000);
});
