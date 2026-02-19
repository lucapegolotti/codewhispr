# Session Attach Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow the Telegram bot to join an existing Claude Code session by typing `/attach` in the terminal, so both the terminal and Telegram share the same conversation thread.

**Architecture:** A `SessionStart` hook in `~/.claude/settings.json` writes the current session_id to `~/.claude-voice/current-session` whenever Claude Code starts. `/attach` copies that to `~/.claude-voice/attached`. On each Telegram message, `sessions.ts` checks for that file and uses it as the `resume` session_id instead of its own per-chat map.

**Tech Stack:** TypeScript (Node.js fs), shell script hooks, Claude Code slash commands (`~/.claude/commands/`)

---

### Task 1: Add SessionStart hook to ~/.claude/settings.json

**Files:**
- Modify: `~/.claude/settings.json`

The file already exists at `/Users/luca/.claude/settings.json` with `Stop` and `Notification` hooks. Add a `SessionStart` entry.

**Step 1: Read the current file**

Run: `cat ~/.claude/settings.json`

**Step 2: Add the SessionStart hook**

The hook reads JSON from stdin, extracts `session_id`, and writes it to `~/.claude-voice/current-session`. Merge this into the existing `hooks` object:

```json
"SessionStart": [
  {
    "matcher": "",
    "hooks": [
      {
        "type": "command",
        "command": "mkdir -p ~/.claude-voice && jq -r '.session_id' > ~/.claude-voice/current-session"
      }
    ]
  }
]
```

The resulting `hooks` section must keep the existing `Stop` and `Notification` entries intact. Only add `SessionStart`.

**Step 3: Verify the JSON is valid**

Run: `python3 -m json.tool ~/.claude/settings.json > /dev/null && echo OK`
Expected: `OK`

**Step 4: Verify jq is available**

Run: `which jq`
Expected: a path (e.g. `/opt/homebrew/bin/jq`). If missing, install: `brew install jq`

**Step 5: Commit**

```bash
cd /Users/luca/repositories/claude-voice
git add -A  # nothing to stage here — settings.json is outside the repo
# Instead, just note the change in the commit log:
git commit --allow-empty -m "chore: install SessionStart hook in ~/.claude/settings.json (manual step)"
```

---

### Task 2: Create /attach and /detach slash commands

**Files:**
- Create: `~/.claude/commands/attach.md`
- Create: `~/.claude/commands/detach.md`

Slash commands are markdown files in `~/.claude/commands/`. When the user types `/attach`, Claude Code reads the file and executes any Bash tool calls it describes.

**Step 1: Create the commands directory**

Run: `mkdir -p ~/.claude/commands`

**Step 2: Create `~/.claude/commands/attach.md`**

```markdown
Register this Claude Code session with the claude-voice Telegram bot.

Run this bash command and report the result:

```bash
if [ -f ~/.claude-voice/current-session ]; then
  cp ~/.claude-voice/current-session ~/.claude-voice/attached
  echo "Attached to session: $(cat ~/.claude-voice/attached)"
else
  echo "Error: ~/.claude-voice/current-session not found. Is the SessionStart hook installed in ~/.claude/settings.json?"
fi
```
```

**Step 3: Create `~/.claude/commands/detach.md`**

```markdown
Disconnect the claude-voice Telegram bot from this session.

Run this bash command and report the result:

```bash
if [ -f ~/.claude-voice/attached ]; then
  rm ~/.claude-voice/attached
  echo "Detached. The Telegram bot will start a fresh session on next message."
else
  echo "No active attachment found."
fi
```
```

**Step 4: Verify both files exist**

Run: `ls ~/.claude/commands/`
Expected: `attach.md  detach.md` (plus any others)

**Step 5: Commit (note only)**

```bash
cd /Users/luca/repositories/claude-voice
git commit --allow-empty -m "chore: create /attach and /detach slash commands in ~/.claude/commands/ (manual step)"
```

---

### Task 3: Read attached session in sessions.ts

**Files:**
- Modify: `src/sessions.ts` (full file at `/Users/luca/repositories/claude-voice/src/sessions.ts`)

**Current file:**
```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
import { narrate } from "./narrator.js";
import { log, logEmitter } from "./logger.js";
import { homedir } from "os";

const sessions = new Map<number, string>();

const SYSTEM_PROMPT = `You are a coding assistant accessed via Telegram.
When the user mentions a project by name, look for it in ${homedir()}/repositories/.
If the project directory is ambiguous, ask the user to clarify.
Keep responses concise.`;

export function getActiveSessions(): number[] {
  return [...sessions.keys()];
}

export async function runAgentTurn(chatId: number, userMessage: string): Promise<string> {
  const existingSessionId = sessions.get(chatId);

  if (!existingSessionId) {
    log({ chatId, message: "starting new session" });
  }

  let result = "";
  let capturedSessionId: string | undefined;

  for await (const message of query({
    prompt: userMessage,
    options: {
      allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
      permissionMode: "acceptEdits",
      cwd: homedir(),
      ...(existingSessionId
        ? { resume: existingSessionId }
        : { systemPrompt: SYSTEM_PROMPT }),
    },
  })) {
    if (message.type === "system" && message.subtype === "init" && !existingSessionId) {
      capturedSessionId = message.session_id;
    }
    if (message.type === "result" && message.subtype === "success") {
      result = message.result;
    }
    if (message.type === "result" && message.subtype !== "success") {
      throw new Error(`Agent error (${message.subtype})`);
    }
  }

  if (capturedSessionId) {
    sessions.set(chatId, capturedSessionId);
    log({ chatId, message: "session established" });
    logEmitter.emit("session");
  }

  return narrate(result || "The agent completed the task but produced no output.");
}
```

**Step 1: Replace `src/sessions.ts` with the updated version**

Key changes:
- Add `readFileSync`, `existsSync` imports from `"fs"`
- Add `ATTACHED_SESSION_PATH` constant
- Add `getAttachedSessionId()` helper that reads `~/.claude-voice/attached`
- In `runAgentTurn`: check attached session first, log accordingly, skip updating the per-chat map when attached

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
import { narrate } from "./narrator.js";
import { log, logEmitter } from "./logger.js";
import { homedir } from "os";
import { existsSync, readFileSync } from "fs";

const sessions = new Map<number, string>();

const ATTACHED_SESSION_PATH = `${homedir()}/.claude-voice/attached`;

const SYSTEM_PROMPT = `You are a coding assistant accessed via Telegram.
When the user mentions a project by name, look for it in ${homedir()}/repositories/.
If the project directory is ambiguous, ask the user to clarify.
Keep responses concise.`;

function getAttachedSessionId(): string | null {
  if (!existsSync(ATTACHED_SESSION_PATH)) return null;
  const id = readFileSync(ATTACHED_SESSION_PATH, "utf8").trim();
  return id || null;
}

export function getActiveSessions(): number[] {
  return [...sessions.keys()];
}

export async function runAgentTurn(chatId: number, userMessage: string): Promise<string> {
  const attachedSessionId = getAttachedSessionId();
  const existingSessionId = attachedSessionId ?? sessions.get(chatId);

  if (attachedSessionId) {
    log({ chatId, message: `joining attached session ${attachedSessionId.slice(0, 8)}...` });
  } else if (!existingSessionId) {
    log({ chatId, message: "starting new session" });
  }

  let result = "";
  let capturedSessionId: string | undefined;

  for await (const message of query({
    prompt: userMessage,
    options: {
      allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
      permissionMode: "acceptEdits",
      cwd: homedir(),
      ...(existingSessionId
        ? { resume: existingSessionId }
        : { systemPrompt: SYSTEM_PROMPT }),
    },
  })) {
    if (message.type === "system" && message.subtype === "init" && !existingSessionId) {
      capturedSessionId = message.session_id;
    }
    if (message.type === "result" && message.subtype === "success") {
      result = message.result;
    }
    if (message.type === "result" && message.subtype !== "success") {
      throw new Error(`Agent error (${message.subtype})`);
    }
  }

  if (capturedSessionId && !attachedSessionId) {
    sessions.set(chatId, capturedSessionId);
    log({ chatId, message: "session established" });
    logEmitter.emit("session");
  }

  return narrate(result || "The agent completed the task but produced no output.");
}
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add src/sessions.ts
git commit -m "feat: join attached Claude Code session when ~/.claude-voice/attached exists"
```

---

### Task 4: Install the hook by restarting Claude Code

**This is a manual verification task.**

The `SessionStart` hook is only read when Claude Code starts a new session.

**Step 1: Start a new Claude Code session**

Open a new terminal and run `claude` (or open a new Claude Code window). The hook should fire and write to `~/.claude-voice/current-session`.

**Step 2: Verify the file was written**

Run: `cat ~/.claude-voice/current-session`
Expected: a UUID-like session ID string, e.g. `550e8400-e29b-41d4-a716-446655440000`

**Step 3: Test /attach**

In that Claude Code session, type `/attach`.
Expected: Claude runs the bash command and reports back: `Attached to session: <session_id>`

**Step 4: Verify the attached file**

Run: `cat ~/.claude-voice/attached`
Expected: same session ID as `current-session`

**Step 5: Test /detach**

Type `/detach` in Claude Code.
Expected: `Detached. The Telegram bot will start a fresh session on next message.`

Run: `ls ~/.claude-voice/attached`
Expected: `No such file or directory`

**Step 6: Commit (note only)**

```bash
cd /Users/luca/repositories/claude-voice
git commit --allow-empty -m "chore: verified session attach flow end-to-end"
```
