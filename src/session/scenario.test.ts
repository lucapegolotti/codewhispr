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

// ---------------------------------------------------------------------------
// JSONL fixture helpers — minimal representations of what Claude Code writes
// ---------------------------------------------------------------------------

function assistantEntry(text: string, cwd = "/tmp/proj"): string {
  return JSON.stringify({ type: "assistant", cwd, message: { content: [{ type: "text", text }] } }) + "\n";
}

function resultEntry(): string {
  return JSON.stringify({ type: "result", source: "stop-hook" }) + "\n";
}

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

    // --- state after /clear: new empty session ---
    const newSessionFile = join(projectDir, "session-new.jsonl");
    await writeFile(newSessionFile, "");

    // 1. snapshotBaseline equivalent: find the latest session file
    const latest = await getLatestSessionFileForCwd(fakeCwd);
    expect(latest).not.toBeNull();
    expect(latest!.sessionId).toBe("session-new"); // must be the new session, not old

    const baseline = await getFileSize(latest!.filePath);
    expect(baseline).toBe(0); // empty file

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
