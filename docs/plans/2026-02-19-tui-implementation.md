# TUI Dashboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a full-screen `ink` terminal dashboard launched via `npm run tui` or the global `claude-voice` command, with a setup wizard for first-run credential entry, live log pane, active sessions pane, and bot start/stop controls.

**Architecture:** `ink` (React for the terminal) renders a multi-pane dashboard. A new `src/logger.ts` module provides a shared event emitter; `bot.ts` and `sessions.ts` import it instead of calling `console.log/error`. The Dashboard component owns the bot lifecycle — it creates and starts the bot on mount and stops it on quit or explicit keypress. `src/tui.tsx` is the entry point: it checks for a valid `.env`, shows the Setup wizard if needed, then renders the Dashboard.

**Tech Stack:** `ink`, `react`, `ink-text-input`, `@types/react`, existing `grammy` + `tsx` stack

---

### Task 1: Install dependencies and configure TypeScript for JSX

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`

**Step 1: Install new runtime dependencies**

```bash
cd /Users/luca/repositories/claude-voice
npm install ink react ink-text-input
npm install --save-dev @types/react
```

Expected: packages added, no errors, `package-lock.json` updated

**Step 2: Update `tsconfig.json`** — add `"jsx": "react-jsx"` to compilerOptions

Current file is at `/Users/luca/repositories/claude-voice/tsconfig.json`. Add one line to `compilerOptions`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "jsx": "react-jsx"
  },
  "include": ["src"]
}
```

**Step 3: Update `package.json`** — add `tui` script and `bin` entry

```json
{
  "name": "claude-voice",
  "version": "1.0.0",
  "type": "module",
  "bin": {
    "claude-voice": "src/tui.tsx"
  },
  "scripts": {
    "start": "tsx src/index.ts",
    "dev": "tsx watch src/index.ts",
    "tui": "tsx src/tui.tsx"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "latest",
    "@anthropic-ai/sdk": "latest",
    "grammy": "latest",
    "ink": "latest",
    "ink-text-input": "latest",
    "openai": "latest",
    "react": "latest"
  },
  "devDependencies": {
    "@types/node": "latest",
    "@types/react": "latest",
    "tsx": "latest",
    "typescript": "latest"
  }
}
```

**Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json
git commit -m "chore: add ink/react deps and JSX tsconfig support"
```

---

### Task 2: Shared logger

**Files:**
- Create: `src/logger.ts`

**Step 1: Create `src/logger.ts`**

```typescript
import { EventEmitter } from "events";

export type LogEntry = {
  time: string;
  chatId?: number;
  direction?: "in" | "out";
  message: string;
};

function timestamp(): string {
  return new Date().toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export const logEmitter = new EventEmitter();
let buffer: LogEntry[] = [];

export function log(entry: Omit<LogEntry, "time">): void {
  const full: LogEntry = { time: timestamp(), ...entry };
  buffer.push(full);
  logEmitter.emit("log", full);
}

export function getLogs(): LogEntry[] {
  return [...buffer];
}

export function clearLogs(): void {
  buffer = [];
  logEmitter.emit("clear");
}
```

**Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add src/logger.ts
git commit -m "feat: add shared logger with event emitter"
```

---

### Task 3: Wire logger into bot.ts and sessions.ts

**Files:**
- Modify: `src/bot.ts`
- Modify: `src/sessions.ts`

**Step 1: Replace `src/bot.ts`** — swap `console.error` for `log`, add message logging

```typescript
import { Bot, InputFile } from "grammy";
import { runAgentTurn } from "./sessions.js";
import { transcribeAudio, synthesizeSpeech } from "./voice.js";
import { log } from "./logger.js";

export function createBot(token: string): Bot {
  const bot = new Bot(token);

  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    const userText = ctx.message.text;
    await ctx.replyWithChatAction("typing");
    log({ chatId, direction: "in", message: userText });

    try {
      const reply = await runAgentTurn(chatId, userText);
      log({ chatId, direction: "out", message: reply });
      await ctx.reply(reply);
    } catch (err) {
      log({ chatId, message: `Error: ${err instanceof Error ? err.message : String(err)}` });
      await ctx.reply("Something went wrong — try again?");
    }
  });

  bot.on("message:voice", async (ctx) => {
    const chatId = ctx.chat.id;
    await ctx.replyWithChatAction("record_voice");
    log({ chatId, direction: "in", message: "[voice note]" });

    try {
      const file = await ctx.getFile();
      if (!file.file_path) throw new Error("Telegram did not return a file_path for this voice note");
      const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const audioResponse = await fetch(fileUrl);
      if (!audioResponse.ok) throw new Error(`Failed to download voice note: ${audioResponse.status}`);
      const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());

      const transcript = await transcribeAudio(audioBuffer, "voice.ogg");
      log({ chatId, message: `transcribed: "${transcript}"` });

      const replyText = await runAgentTurn(chatId, transcript);
      log({ chatId, direction: "out", message: "[voice reply]" });
      const audioReply = await synthesizeSpeech(replyText);
      await ctx.replyWithVoice(new InputFile(audioReply, "reply.mp3"));
    } catch (err) {
      log({ chatId, message: `Voice error: ${err instanceof Error ? err.message : String(err)}` });
      await ctx.reply("Couldn't process your voice message — try again?");
    }
  });

  return bot;
}
```

**Step 2: Replace `src/sessions.ts`** — add `getActiveSessions()` export and session logging

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
import { narrate } from "./narrator.js";
import { log } from "./logger.js";
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
  }

  return narrate(result || "The agent completed the task but produced no output.");
}
```

**Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 4: Commit**

```bash
git add src/bot.ts src/sessions.ts
git commit -m "feat: wire logger into bot and sessions"
```

---

### Task 4: StatusBar and KeyBar components

**Files:**
- Create: `src/tui/StatusBar.tsx`
- Create: `src/tui/KeyBar.tsx`

**Step 1: Create `src/tui/StatusBar.tsx`**

```tsx
import { Box, Text } from "ink";

type Props = { status: "running" | "stopped" };

export function StatusBar({ status }: Props) {
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text bold>claude-voice</Text>
      <Box gap={3}>
        <Text color={status === "running" ? "green" : "yellow"}>
          {status === "running" ? "● RUNNING" : "○ STOPPED"}
        </Text>
        <Text dimColor>[q] quit</Text>
      </Box>
    </Box>
  );
}
```

**Step 2: Create `src/tui/KeyBar.tsx`**

```tsx
import { Box, Text } from "ink";

type Props = { status: "running" | "stopped" };

export function KeyBar({ status }: Props) {
  return (
    <Box paddingX={1} gap={3}>
      {status === "stopped" ? (
        <Text>[s] start</Text>
      ) : (
        <Text>[x] stop</Text>
      )}
      <Text>[r] restart</Text>
      <Text>[c] clear logs</Text>
    </Box>
  );
}
```

**Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 4: Commit**

```bash
git add src/tui/StatusBar.tsx src/tui/KeyBar.tsx
git commit -m "feat: add StatusBar and KeyBar TUI components"
```

---

### Task 5: LogPane and SessionPane components

**Files:**
- Create: `src/tui/LogPane.tsx`
- Create: `src/tui/SessionPane.tsx`

**Step 1: Create `src/tui/LogPane.tsx`**

```tsx
import { Box, Text, useStdout } from "ink";
import { useState, useEffect } from "react";
import { logEmitter, getLogs, type LogEntry } from "../logger.js";

export function LogPane() {
  const { stdout } = useStdout();
  const [logs, setLogs] = useState<LogEntry[]>(getLogs());

  useEffect(() => {
    const onLog = () => setLogs(getLogs());
    const onClear = () => setLogs([]);
    logEmitter.on("log", onLog);
    logEmitter.on("clear", onClear);
    return () => {
      logEmitter.off("log", onLog);
      logEmitter.off("clear", onClear);
    };
  }, []);

  const height = (stdout?.rows ?? 24) - 4;
  const visible = logs.slice(-height);

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Text bold dimColor>LOGS</Text>
      {visible.map((entry, i) => (
        <Box key={i} gap={1}>
          <Text dimColor>{entry.time}</Text>
          {entry.direction === "in" && <Text color="cyan">←</Text>}
          {entry.direction === "out" && <Text color="green">→</Text>}
          {!entry.direction && <Text> </Text>}
          {entry.chatId !== undefined && <Text dimColor>{entry.chatId}</Text>}
          <Text wrap="truncate">{entry.message}</Text>
        </Box>
      ))}
    </Box>
  );
}
```

**Step 2: Create `src/tui/SessionPane.tsx`**

```tsx
import { Box, Text } from "ink";
import { useState, useEffect } from "react";
import { logEmitter } from "../logger.js";
import { getActiveSessions } from "../sessions.js";

export function SessionPane() {
  const [sessions, setSessions] = useState<number[]>(getActiveSessions());

  useEffect(() => {
    const onLog = () => setSessions(getActiveSessions());
    logEmitter.on("log", onLog);
    return () => { logEmitter.off("log", onLog); };
  }, []);

  return (
    <Box flexDirection="column" width={22} paddingX={1}>
      <Text bold dimColor>SESSIONS</Text>
      {sessions.length === 0
        ? <Text dimColor>none yet</Text>
        : sessions.map(id => <Text key={id}>{id}</Text>)
      }
    </Box>
  );
}
```

**Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 4: Commit**

```bash
git add src/tui/LogPane.tsx src/tui/SessionPane.tsx
git commit -m "feat: add LogPane and SessionPane TUI components"
```

---

### Task 6: Setup wizard

**Files:**
- Create: `src/tui/Setup.tsx`

**Step 1: Create `src/tui/Setup.tsx`**

```tsx
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { useState } from "react";
import { writeFileSync } from "fs";

const STEPS = [
  { key: "TELEGRAM_BOT_TOKEN", label: "Telegram bot token", hint: "Get from @BotFather → /newbot" },
  { key: "ANTHROPIC_API_KEY",  label: "Anthropic API key",  hint: "console.anthropic.com" },
  { key: "OPENAI_API_KEY",     label: "OpenAI API key",     hint: "platform.openai.com/api-keys" },
] as const;

type Key = typeof STEPS[number]["key"];
type Props = { envPath: string; onComplete: () => void };

export function Setup({ envPath, onComplete }: Props) {
  const [step, setStep] = useState(0);
  const [values, setValues] = useState<Partial<Record<Key, string>>>({});
  const [input, setInput] = useState("");

  const current = STEPS[step];

  function handleSubmit(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;

    const next = { ...values, [current.key]: trimmed };
    setValues(next);
    setInput("");

    if (step === STEPS.length - 1) {
      const content = STEPS.map(s => `${s.key}=${next[s.key]}`).join("\n") + "\n";
      writeFileSync(envPath, content, "utf8");
      onComplete();
    } else {
      setStep(step + 1);
    }
  }

  return (
    <Box flexDirection="column" gap={1} padding={2}>
      <Text bold>claude-voice setup</Text>
      <Text dimColor>Enter your API credentials. They'll be saved to .env</Text>
      <Box flexDirection="column" marginTop={1} gap={1}>
        {STEPS.slice(0, step).map(s => (
          <Text key={s.key} color="green">✓ {s.label}</Text>
        ))}
        <Box gap={1}>
          <Text bold>{current.label}: </Text>
          <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} mask="*" />
        </Box>
        <Text dimColor>{current.hint}</Text>
      </Box>
    </Box>
  );
}
```

**Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add src/tui/Setup.tsx
git commit -m "feat: add TUI setup wizard"
```

---

### Task 7: Dashboard component

**Files:**
- Create: `src/tui/Dashboard.tsx`

**Step 1: Create `src/tui/Dashboard.tsx`**

```tsx
import { Box, useApp, useInput } from "ink";
import { useState, useEffect, useRef } from "react";
import type { Bot } from "grammy";
import { StatusBar } from "./StatusBar.js";
import { KeyBar } from "./KeyBar.js";
import { LogPane } from "./LogPane.js";
import { SessionPane } from "./SessionPane.js";
import { createBot } from "../bot.js";
import { clearLogs } from "../logger.js";

type Status = "running" | "stopped";
type Props = { token: string };

export function Dashboard({ token }: Props) {
  const { exit } = useApp();
  const [status, setStatus] = useState<Status>("stopped");
  const botRef = useRef<Bot | null>(null);

  function start() {
    if (botRef.current) return;
    const bot = createBot(token);
    bot.catch(() => setStatus("stopped"));
    botRef.current = bot;
    bot.start({ onStart: () => setStatus("running") });
  }

  async function stop() {
    if (!botRef.current) return;
    await botRef.current.stop();
    botRef.current = null;
    setStatus("stopped");
  }

  useEffect(() => {
    start();
    return () => { stop(); };
  }, []);

  useInput((input) => {
    if (input === "q") stop().then(() => exit());
    if (input === "s" && status === "stopped") start();
    if (input === "x" && status === "running") stop();
    if (input === "r") stop().then(() => start());
    if (input === "c") clearLogs();
  });

  return (
    <Box flexDirection="column" height="100%">
      <StatusBar status={status} />
      <Box flexGrow={1} borderStyle="single">
        <LogPane />
        <Box borderStyle="single" width={24}>
          <SessionPane />
        </Box>
      </Box>
      <KeyBar status={status} />
    </Box>
  );
}
```

**Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add src/tui/Dashboard.tsx
git commit -m "feat: add Dashboard TUI component"
```

---

### Task 8: TUI entry point and global command

**Files:**
- Create: `src/tui.tsx`
- Modify: `README.md`

**Step 1: Create `src/tui.tsx`**

```tsx
#!/usr/bin/env tsx
import { render } from "ink";
import { useState } from "react";
import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { Setup } from "./tui/Setup.js";
import { Dashboard } from "./tui/Dashboard.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, "..", ".env");

const REQUIRED = ["TELEGRAM_BOT_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;

function loadEnv(): Record<string, string> {
  if (!existsSync(ENV_PATH)) return {};
  return Object.fromEntries(
    readFileSync(ENV_PATH, "utf8")
      .split("\n")
      .filter(l => l.includes("="))
      .map(l => {
        const idx = l.indexOf("=");
        return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
      })
  );
}

function App() {
  const [setupDone, setSetupDone] = useState(false);

  const env = loadEnv();
  const needsSetup = !setupDone && REQUIRED.some(k => !env[k]);

  if (needsSetup) {
    return <Setup envPath={ENV_PATH} onComplete={() => setSetupDone(true)} />;
  }

  const freshEnv = loadEnv();
  for (const k of REQUIRED) {
    if (freshEnv[k]) process.env[k] = freshEnv[k];
  }

  return <Dashboard token={freshEnv.TELEGRAM_BOT_TOKEN!} />;
}

render(<App />);
```

**Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 3: Register the global command**

Run: `npm link`
Expected: symlink created, no errors

**Step 4: Verify the command is available**

Run: `which claude-voice`
Expected: a path like `/usr/local/bin/claude-voice`

**Step 5: Update `README.md`** — add TUI section

In the Setup section, add a step 4 after "Install and run":

```markdown
### 4. Launch the dashboard

```bash
npm run tui
```

Or register the global `claude-voice` command (one-time):

```bash
npm link
```

Then launch from anywhere:

```bash
claude-voice
```

On first run without a `.env`, a setup wizard walks you through entering your three API keys.
```

**Step 6: Commit**

```bash
git add src/tui.tsx README.md
git commit -m "feat: add TUI entry point and claude-voice global command"
```
