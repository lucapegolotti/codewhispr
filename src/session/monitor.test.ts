import { describe, it, expect, afterEach } from "vitest";
import { writeFile, appendFile, unlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { classifyWaitingType, parseMultipleChoices, WaitingType, getFileSize, watchForResponse } from "./monitor.js";
import type { SessionResponseState } from "./monitor.js";

describe("classifyWaitingType", () => {
  it("detects y/n prompt", () => {
    expect(classifyWaitingType("Should I delete the file? (y/n)")).toBe(WaitingType.YES_NO);
  });

  it("detects [y/N] variant", () => {
    expect(classifyWaitingType("Overwrite existing file? [y/N]")).toBe(WaitingType.YES_NO);
  });

  it("detects press enter", () => {
    expect(classifyWaitingType("Press enter to continue")).toBe(WaitingType.ENTER);
  });

  it("returns null for generic question (not a real input prompt)", () => {
    expect(classifyWaitingType("What should I name the new file?")).toBeNull();
  });

  it("returns null for completed statement", () => {
    expect(classifyWaitingType("I have updated the migration file.")).toBeNull();
  });

  it("returns null for short non-prompts", () => {
    expect(classifyWaitingType("Done.")).toBeNull();
  });

  it("detects confirm prompt", () => {
    expect(classifyWaitingType("Are you sure you want to proceed? Confirm?")).toBe(WaitingType.YES_NO);
  });
});

describe("parseMultipleChoices", () => {
  const PLAN_APPROVAL_PANE = `
Claude has written up a plan and is ready to execute. Would you like to proceed?
> 1. Yes, clear context (21% used) and bypass permissions
  2. Yes, and bypass permissions
  3. Yes, manually approve edits
  4. Type here to tell Claude what to change
ctrl-g to edit in Vim · ~/.claude/plans/hazy-purring-fog.md
`;

  it("extracts choices from a plan approval pane", () => {
    const choices = parseMultipleChoices(PLAN_APPROVAL_PANE);
    expect(choices).toEqual([
      "Yes, clear context (21% used) and bypass permissions",
      "Yes, and bypass permissions",
      "Yes, manually approve edits",
      "Type here to tell Claude what to change",
    ]);
  });

  it("returns null when fewer than 2 numbered items are found", () => {
    expect(parseMultipleChoices("Some text\n1. Only one item\nMore text")).toBeNull();
  });

  it("returns null when numbering does not start from 1", () => {
    const text = "  2. First item\n  3. Second item\n  4. Third item";
    expect(parseMultipleChoices(text)).toBeNull();
  });

  it("returns null for plain text with no numbered list", () => {
    expect(parseMultipleChoices("I have updated the migration file.")).toBeNull();
  });
});

function assistantLine(text: string, cwd = "/tmp/project"): string {
  return (
    JSON.stringify({
      type: "assistant",
      cwd,
      message: { content: [{ type: "text", text }] },
    }) + "\n"
  );
}

describe("getFileSize", () => {
  const tmpFile = join(tmpdir(), `cv-getfilesize-${Date.now()}.jsonl`);

  afterEach(async () => {
    await unlink(tmpFile).catch(() => {});
  });

  it("returns byte count of file contents", async () => {
    await writeFile(tmpFile, "hello");
    expect(await getFileSize(tmpFile)).toBe(5);
  });

  it("returns 0 for a non-existent file", async () => {
    expect(await getFileSize("/tmp/definitely-does-not-exist-cv.jsonl")).toBe(0);
  });
});

describe("watchForResponse", () => {
  let tmpFile: string;
  let stopWatcher: (() => void) | null = null;

  afterEach(async () => {
    stopWatcher?.();
    stopWatcher = null;
    if (tmpFile) await unlink(tmpFile).catch(() => {});
  });

  it("fires callback when new assistant text appears after baseline", async () => {
    tmpFile = join(tmpdir(), `cv-watch-${Date.now()}.jsonl`);
    await writeFile(tmpFile, "");
    const baseline = await getFileSize(tmpFile);

    const received: SessionResponseState[] = [];
    stopWatcher = watchForResponse(
      tmpFile,
      baseline,
      async (state) => {
        received.push(state);
      }
    );

    await new Promise((r) => setTimeout(r, 200));
    await appendFile(tmpFile, assistantLine("Build succeeded."));
    await new Promise((r) => setTimeout(r, 300));

    expect(received).toHaveLength(1);
    expect(received[0].text).toBe("Build succeeded.");
  });

  it("ignores content written before the baseline", async () => {
    tmpFile = join(tmpdir(), `cv-watch-${Date.now()}.jsonl`);
    await writeFile(tmpFile, assistantLine("Old message from before injection."));
    const baseline = await getFileSize(tmpFile);

    const received: SessionResponseState[] = [];
    stopWatcher = watchForResponse(
      tmpFile,
      baseline,
      async (state) => {
        received.push(state);
      }
    );

    await new Promise((r) => setTimeout(r, 500));
    expect(received).toHaveLength(0);
  });

  it("does not fire twice for the same text block", async () => {
    tmpFile = join(tmpdir(), `cv-watch-${Date.now()}.jsonl`);
    await writeFile(tmpFile, "");
    const baseline = await getFileSize(tmpFile);

    const received: SessionResponseState[] = [];
    stopWatcher = watchForResponse(
      tmpFile,
      baseline,
      async (state) => {
        received.push(state);
      }
    );

    await new Promise((r) => setTimeout(r, 200));
    await appendFile(tmpFile, assistantLine("Done."));
    await new Promise((r) => setTimeout(r, 50));
    await appendFile(tmpFile, assistantLine("Done.")); // duplicate

    await new Promise((r) => setTimeout(r, 300));
    expect(received).toHaveLength(1);
  });

  it("fires separately for two distinct text blocks", async () => {
    tmpFile = join(tmpdir(), `cv-watch-${Date.now()}.jsonl`);
    await writeFile(tmpFile, "");
    const baseline = await getFileSize(tmpFile);

    const received: SessionResponseState[] = [];
    stopWatcher = watchForResponse(
      tmpFile,
      baseline,
      async (state) => {
        received.push(state);
      }
    );

    await new Promise((r) => setTimeout(r, 200));
    await appendFile(tmpFile, assistantLine("First block."));
    await new Promise((r) => setTimeout(r, 300));
    await appendFile(tmpFile, assistantLine("Second block."));
    await new Promise((r) => setTimeout(r, 300));

    expect(received).toHaveLength(2);
    expect(received[0].text).toBe("First block.");
    expect(received[1].text).toBe("Second block.");
  });

  it("stop function prevents further callbacks", async () => {
    tmpFile = join(tmpdir(), `cv-watch-${Date.now()}.jsonl`);
    await writeFile(tmpFile, "");
    const baseline = await getFileSize(tmpFile);

    const received: SessionResponseState[] = [];
    stopWatcher = watchForResponse(
      tmpFile,
      baseline,
      async (state) => {
        received.push(state);
      }
    );

    await new Promise((r) => setTimeout(r, 200));
    stopWatcher();
    stopWatcher = null;

    await appendFile(tmpFile, assistantLine("Should not arrive."));
    await new Promise((r) => setTimeout(r, 300));
    expect(received).toHaveLength(0);
  });

  it("calls onComplete after result event", async () => {
    tmpFile = join(tmpdir(), `cv-watch-${Date.now()}.jsonl`);
    await writeFile(tmpFile, "");
    const baseline = await getFileSize(tmpFile);

    let completed = false;
    stopWatcher = watchForResponse(
      tmpFile,
      baseline,
      async () => {},
      undefined,
      () => { completed = true; }
    );

    await new Promise((r) => setTimeout(r, 100));
    // Write assistant text + result in one append so a single change event sees both
    await appendFile(tmpFile, assistantLine("Step one.") + JSON.stringify({ type: "result" }) + "\n");
    await new Promise((r) => setTimeout(r, 900)); // 500ms delay + buffer

    expect(completed).toBe(true);
  });

});
