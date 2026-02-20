# Zero-Cost Routing Design

**Date:** 2026-02-20

## Overview

Remove the `classifyIntent` API call that currently fires on every message. When attached to a session all messages route directly to Claude Code via tmux — no Anthropic API tokens consumed. Summarization and voice polish become explicit opt-in commands.

## Routing Changes

### `loop.ts` — simplified pass-through

`handleTurn` becomes a direct router with zero API calls:

- **cwd known** → `injectInput(cwd, message)`
  - pane found → return `__INJECTED__`
  - pane not found → return "No Claude Code running in the attached project. Start Claude Code there, or use /sessions to switch."
- **no cwd** → return "No session attached. Use /sessions to pick one."

`classifyIntent`, `runAgentTurn`, and `lastBotMessage` context tracking are removed. `clearChatState` stays as a no-op (called by `bot.ts` on attach/detach). `chatState` map is removed entirely.

### Files deleted

- `src/agent/classifier.ts`
- `src/agent/classifier.test.ts`
- `src/session/adapter.ts`
- `src/session/adapter.test.ts`

`src/agent/summarizer.ts` is **kept** — used by the new `/summarize` command.

## New Commands

### `/summarize`

Calls `summarizeSession()` directly from `bot.ts` and sends the result as a Markdown reply. No routing through `loop.ts`.

### `/polishvoice`

Toggles voice transcript polishing on/off. Persisted in `~/.claude-voice/polish-voice` (file present = off, absent = on by default). The voice handler in `bot.ts` reads this flag before calling `polishTranscript`. Replies with current state after toggling.

## Token Impact

| Path | Before | After |
|------|--------|-------|
| Text message (attached) | 1 Haiku call (classify) | 0 |
| Text message (not attached) | 1 Haiku call (classify) | 0 |
| Voice message (attached) | 2 Haiku calls (classify + polish) | 0–1 (polish only, toggleable) |
| `/summarize` | 1 Haiku call | 1 Haiku call (unchanged) |
