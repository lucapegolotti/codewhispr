# Tests and Voice Streaming Design

**Date:** 2026-02-20

## Overview

Two changes: expand test coverage for all features added in the recent session, and improve voice message handling to stream text as it arrives before sending the final audio summary.

## Part 1 — Voice Message Improvements

### New flow

1. Transcribe with Whisper → `polishTranscript()` cleans up raw transcript
2. Immediately reply: `` `[transcription]` <polished text> ``
3. Inject polished text into Claude Code
4. Show typing indicator
5. As each text block arrives → immediately send `` `[claude-code]` <text> `` (streamed in real-time)
6. After 3s debounce on last block → `narrate()` + `synthesizeSpeech()` → send audio reply

### Changes to `src/telegram/bot.ts`

In the voice handler, after `__INJECTED__` is confirmed:
- Send the transcription reply before starting the watcher
- In `voiceResponseHandler`, send each incoming text block immediately as a text message
- Keep the 3s debounce only to trigger final audio generation
- Remove the error-fallback text send (text already streamed; just log the error)

## Part 2 — Test Coverage

### Files to update

**`src/agent/loop.test.ts`** (outdated — update existing tests)
- `GENERAL_CHAT` with a `cwd`: should call `injectInput`, return `__INJECTED__` (currently wrong)
- `COMMAND_EXECUTION` when tmux pane found: should return `__INJECTED__`
- Add test: `clearChatState` removes state so next turn has no prior context

### New test files

**`src/session/monitor.test.ts`** (extend existing)
- `getFileSize`: write content to a tmp file, assert reported byte count matches
- `watchForResponse` — ignores content before baseline: write JSONL before recording baseline, append more after, assert callback only fires for post-baseline content
- `watchForResponse` — fires on new assistant text: append assistant JSONL line, advance fake timers past 1s debounce, assert callback called with correct text
- `watchForResponse` — debounce resets on rapid writes: two quick writes, only one callback after debounce settles
- `watchForResponse` — calls stop function after timeout: advance fake timers past timeout, assert watcher cleans up

**`src/voice.test.ts`** (new)
- `polishTranscript` returns cleaned text: mock `@anthropic-ai/sdk`, assert messages API called with transcript, return mocked text response
- `polishTranscript` falls back to raw transcript: mock returns non-text block, assert original transcript returned

**`src/telegram/notifications.test.ts`** (new)
- `splitMessage`: message under limit returns single chunk
- `splitMessage`: message over limit splits at last newline before limit
- `splitMessage`: message over limit with no newlines splits at hard limit
- `notifyResponse` sends text prefixed with `` `[claude-code]` ``

**`src/session/adapter.test.ts`** (new)
- `clearAdapterSession`: mock the Agent SDK, run a turn to create session state, call `clearAdapterSession`, verify next turn starts fresh (no session continuity)

### Test pattern for `watchForResponse`

```typescript
import { tmpdir } from "os";
import { join } from "path";
import { writeFile, appendFile } from "fs/promises";

const tmpFile = join(tmpdir(), `cv-test-${Date.now()}.jsonl`);
await writeFile(tmpFile, "");
const baseline = await getFileSize(tmpFile);

const callback = vi.fn();
watchForResponse(tmpFile, baseline, callback);

await appendFile(tmpFile, JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "text", text: "Done!" }] }
}) + "\n");

await vi.advanceTimersByTimeAsync(1500);
expect(callback).toHaveBeenCalledWith(expect.objectContaining({ text: "Done!" }));
```

Fake timers via `vi.useFakeTimers()` / `vi.useRealTimers()` in `beforeEach`/`afterEach`.

## Constraints

- All external API calls (Anthropic, OpenAI) must be mocked — no real API calls in tests
- `splitMessage` in `notifications.ts` needs to be exported so it can be imported in tests
- Tests must clean up tmp files in `afterEach`
