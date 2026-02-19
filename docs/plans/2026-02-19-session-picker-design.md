# Session Picker Design

**Date:** 2026-02-19

## Overview

Allow the user to discover and resume Claude Code sessions from Telegram — including via voice — without needing to `/attach` from a terminal. The bot scans `~/.claude/projects/`, lists recent sessions with a last-message preview, and lets the user tap to resume.

## Flow

1. User sends `/sessions` or a voice message that means "show me my sessions"
2. Bot detects intent via a quick LLM call (to handle imprecise voice transcriptions)
3. Bot scans `~/.claude/projects/**/*.jsonl`, reads last 5 by mtime
4. Bot sends an inline keyboard: each button shows `<project> · <time ago>` and the last assistant message as a subtitle
5. User taps a session
6. Bot writes `sessionId\ncwd` to `~/.claude-voice/attached`
7. Bot confirms: "Attached to `<project>`. Send your first message."
8. All subsequent messages route through the existing `getAttachedSession()` path in `runAgentTurn`

## Components

### 1. Intent detection (`src/narrator.ts` or new `src/intent.ts`)

A `detectSessionListIntent(text: string): Promise<boolean>` function that calls the Anthropic API with a small classification prompt:

> "Does this message mean the user wants to see a list of available Claude Code sessions? Answer yes or no."

Used in the bot message handler before calling `runAgentTurn`.

### 2. `listSessions()` in `src/sessions.ts`

```typescript
type SessionInfo = {
  sessionId: string;
  cwd: string;
  projectName: string;
  lastMessage: string;
  mtime: Date;
};
```

- Reads `~/.claude/projects/` subdirectories (each dir name is the project path with `/` encoded as `-`)
- For each `.jsonl` file: reads mtime, scans lines for first `system/init` message (to get cwd) and last `assistant` message (to get preview)
- Returns top 5 by mtime descending

### 3. `/sessions` command + intent handler in `src/bot.ts`

- Registers `/sessions` command with grammy
- In the main message handler, calls `detectSessionListIntent()` first; if true, shows session picker instead of forwarding to agent
- Builds `InlineKeyboard` with one button per session (label = `<projectName> · <timeAgo>`, callback_data = `session:<sessionId>`)
- Stores full session info in a module-level `pendingSessions: Map<string, SessionInfo>` for lookup on callback

### 4. Callback query handler in `src/bot.ts`

- Matches `callback_data` starting with `"session:"`
- Extracts sessionId, looks up full info in `pendingSessions`
- Writes `sessionId\ncwd` to `~/.claude-voice/attached`
- Answers callback query and sends confirmation message

## Behaviour

- **Limit:** 5 most recent sessions shown
- **Decode project name:** dir name `-Users-luca-repositories-foo` → strip leading `-Users-luca-repositories-` → `foo` (or fall back to full dir name)
- **Missing cwd:** fall back to `homedir()` if no init message found in file
- **Empty sessions:** if `~/.claude/projects/` has no sessions, reply "No sessions found."
- **Pending sessions TTL:** `pendingSessions` is just in-memory; stale entries are fine since the bot process restarts are infrequent

## Files Changed

- Modify: `src/sessions.ts` — add `SessionInfo` type and `listSessions()`
- Modify: `src/bot.ts` — add `/sessions` command, intent check, inline keyboard, callback handler
- Add: `src/intent.ts` — `detectSessionListIntent()` using Anthropic API
