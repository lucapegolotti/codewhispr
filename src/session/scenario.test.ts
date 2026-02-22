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

import { describe, it, expect, afterEach } from "vitest";
import { mkdir, writeFile, appendFile, rm } from "fs/promises";
import { join } from "path";
import { getLatestSessionFileForCwd, PROJECTS_PATH } from "./history.js";
import { watchForResponse, getFileSize } from "./monitor.js";
import type { SessionResponseState } from "./monitor.js";
import { splitAtTables } from "../telegram/utils.js";
import { renderTableAsPng } from "../telegram/tableImage.js";

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
| \`src/agent/loop.test.ts\` | Agent loop logic |
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
