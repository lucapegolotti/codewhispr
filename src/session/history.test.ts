import { describe, it, expect, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { parseJsonlLines, extractWaitingPrompt, listSessions, getLatestSessionFileForCwd, PROJECTS_PATH } from "./history.js";

const ASSISTANT_LINE = JSON.stringify({
  type: "assistant",
  cwd: "/Users/luca/repositories/my-app",
  message: {
    content: [{ type: "text", text: "I've updated the migration file. Should I delete the old one? (y/n)" }],
  },
});

const TOOL_LINE = JSON.stringify({
  type: "assistant",
  message: {
    content: [{ type: "tool_use", name: "Bash", input: { command: "npm install" } }],
  },
});

describe("parseJsonlLines", () => {
  it("extracts cwd from first assistant line", () => {
    const result = parseJsonlLines([ASSISTANT_LINE]);
    expect(result.cwd).toBe("/Users/luca/repositories/my-app");
  });

  it("extracts last text message", () => {
    const result = parseJsonlLines([ASSISTANT_LINE]);
    expect(result.lastMessage).toContain("updated the migration file");
  });

  it("skips malformed lines", () => {
    const result = parseJsonlLines(["not json", ASSISTANT_LINE]);
    expect(result.cwd).toBe("/Users/luca/repositories/my-app");
  });

  it("records tool calls", () => {
    const result = parseJsonlLines([TOOL_LINE]);
    expect(result.toolCalls).toContainEqual({ name: "Bash", input: { command: "npm install" } });
  });
});

describe("extractWaitingPrompt", () => {
  it("detects y/n prompt", () => {
    expect(extractWaitingPrompt("Should I delete it? (y/n)")).toBe("Should I delete it? (y/n)");
  });

  it("detects press enter", () => {
    expect(extractWaitingPrompt("Press enter to continue")).toBe("Press enter to continue");
  });

  it("detects trailing question mark", () => {
    expect(extractWaitingPrompt("Do you want me to proceed?")).toBe("Do you want me to proceed?");
  });

  it("returns null for non-waiting text", () => {
    expect(extractWaitingPrompt("I have updated the file.")).toBeNull();
  });

  it("returns null for short non-prompts", () => {
    expect(extractWaitingPrompt("Done.")).toBeNull();
  });
});

function assistantJsonl(text: string, cwd = "/tmp/proj"): string {
  return JSON.stringify({
    type: "assistant",
    cwd,
    message: { content: [{ type: "text", text }] },
  }) + "\n";
}

describe("listSessions", () => {
  let tmpProjects: string;

  afterEach(async () => {
    await rm(tmpProjects, { recursive: true, force: true });
  });

  it("returns one session per project directory", async () => {
    tmpProjects = join(tmpdir(), `cv-projects-${Date.now()}`);
    await mkdir(join(tmpProjects, "-Users-luca-repos-alpha"), { recursive: true });
    await mkdir(join(tmpProjects, "-Users-luca-repos-beta"), { recursive: true });
    await writeFile(join(tmpProjects, "-Users-luca-repos-alpha", "session1.jsonl"), assistantJsonl("Hello from A"));
    await writeFile(join(tmpProjects, "-Users-luca-repos-beta", "session2.jsonl"), assistantJsonl("Hello from B"));

    const sessions = await listSessions(20, tmpProjects);
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.projectName)).toEqual(expect.arrayContaining(["alpha", "beta"]));
  });

  it("deduplicates multiple sessions in same project — keeps the newest", async () => {
    tmpProjects = join(tmpdir(), `cv-projects-${Date.now()}`);
    const projDir = join(tmpProjects, "-Users-luca-repositories-my-project");
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, "old-session.jsonl"), assistantJsonl("old message"));
    await new Promise((r) => setTimeout(r, 10)); // ensure distinct mtime
    await writeFile(join(projDir, "new-session.jsonl"), assistantJsonl("new message"));

    const sessions = await listSessions(20, tmpProjects);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].lastMessage).toContain("new message");
  });

  it("sorts by most recently modified", async () => {
    tmpProjects = join(tmpdir(), `cv-projects-${Date.now()}`);
    await mkdir(join(tmpProjects, "-Users-luca-repositories-alpha"), { recursive: true });
    await mkdir(join(tmpProjects, "-Users-luca-repositories-beta"), { recursive: true });
    await writeFile(join(tmpProjects, "-Users-luca-repositories-alpha", "s.jsonl"), assistantJsonl("alpha"));
    await new Promise((r) => setTimeout(r, 10));
    await writeFile(join(tmpProjects, "-Users-luca-repositories-beta", "s.jsonl"), assistantJsonl("beta"));

    const sessions = await listSessions(20, tmpProjects);
    expect(sessions[0].projectName).toBe("beta");
    expect(sessions[1].projectName).toBe("alpha");
  });

  it("respects the limit", async () => {
    tmpProjects = join(tmpdir(), `cv-projects-${Date.now()}`);
    for (const name of ["p1", "p2", "p3"]) {
      await mkdir(join(tmpProjects, `-Users-luca-${name}`), { recursive: true });
      await writeFile(join(tmpProjects, `-Users-luca-${name}`, "s.jsonl"), assistantJsonl("msg"));
    }

    const sessions = await listSessions(2, tmpProjects);
    expect(sessions).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Helper: produce a snapshot-only JSONL line (no assistant messages)
// ---------------------------------------------------------------------------
function snapshotLine(): string {
  return JSON.stringify({ type: "file-history-snapshot", messageId: "abc" }) + "\n";
}

describe("getLatestSessionFileForCwd", () => {
  // The function uses the module-level PROJECTS_PATH constant (typically
  // ~/.claude/projects). We create real files under PROJECTS_PATH using unique
  // test-id-based directory names so tests are isolated and cleaned up after each run.

  let encodedCwd: string;
  let projectDir: string;
  let fakeCwd: string;

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  function setupProjectDir(testId: string): void {
    // Use a cwd of form /cv-test-<id> — encodes to -cv-test-<id>
    // getLatestSessionFileForCwd encodes cwd by replacing "/" with "-"
    fakeCwd = `/cv-test-${testId}`;
    encodedCwd = fakeCwd.replace(/\//g, "-");
    projectDir = join(PROJECTS_PATH, encodedCwd);
  }

  it("returns the file with assistant messages even when a newer snapshot-only file exists", async () => {
    setupProjectDir(`assistant-prefers-${Date.now()}`);
    await mkdir(projectDir, { recursive: true });

    // Write older assistant file
    await writeFile(join(projectDir, "session-old.jsonl"), assistantJsonl("Hello world"));
    await new Promise((r) => setTimeout(r, 20)); // ensure distinct mtime
    // Write newer snapshot-only file
    await writeFile(join(projectDir, "session-new.jsonl"), snapshotLine());

    const result = await getLatestSessionFileForCwd(fakeCwd);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("session-old");
    expect(result!.filePath).toContain("session-old.jsonl");
  });

  it("falls back to the most-recently-modified file when no file has assistant messages", async () => {
    setupProjectDir(`fallback-${Date.now()}`);
    await mkdir(projectDir, { recursive: true });

    await writeFile(join(projectDir, "session-a.jsonl"), snapshotLine());
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(join(projectDir, "session-b.jsonl"), snapshotLine());

    const result = await getLatestSessionFileForCwd(fakeCwd);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("session-b");
  });

  it("returns null when the project directory doesn't exist", async () => {
    // Use a cwd that has no matching project dir
    const nonExistentCwd = `/cv-test-nonexistent-${Date.now()}`;
    const result = await getLatestSessionFileForCwd(nonExistentCwd);
    expect(result).toBeNull();
  });

  it("when multiple files have assistant messages, returns the most recently modified one", async () => {
    setupProjectDir(`multi-assistant-${Date.now()}`);
    await mkdir(projectDir, { recursive: true });

    await writeFile(join(projectDir, "session-first.jsonl"), assistantJsonl("First response"));
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(join(projectDir, "session-second.jsonl"), assistantJsonl("Second response"));
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(join(projectDir, "session-third.jsonl"), assistantJsonl("Third response"));

    const result = await getLatestSessionFileForCwd(fakeCwd);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("session-third");
  });
});
