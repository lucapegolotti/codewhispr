# codedove

<p align="center">
  <a href="https://github.com/lucapegolotti/codedove/actions/workflows/ci.yml"><img src="https://github.com/lucapegolotti/codedove/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <img src="https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/lucapegolotti/codedove/main/.github/badges/coverage.json" alt="Coverage">
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node >= 20">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue" alt="Platform">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
</p>

> Control Claude Code from your phone via Telegram — text, voice, or image.

Send a message from Telegram. Claude Code runs on your Mac. You get the response back in Telegram — as text or as a voice note.

## What it is

codedove is a Telegram bot that acts as a remote interface for [Claude Code](https://claude.ai/code) sessions running in tmux on your machine. You can type or speak commands, receive responses as text or audio, approve tool permissions from your phone, and manage multiple Claude Code sessions from a single Telegram chat.

## Features

- **Text, voice, and image input** — type a message, send a voice note, or share a photo. Everything gets injected into Claude Code.
- **Response forwarding** — Claude's responses are forwarded to Telegram as formatted Markdown messages with the repo name and model shown.
- **Voice notes** — voice messages are transcribed (Whisper), optionally polished (Haiku), and Claude's reply is narrated back as a voice note (OpenAI TTS).
- **Image support** — photos and image files are saved locally and referenced in Claude Code. Use `/images` to retrieve images Claude created.
- **Table rendering** — Markdown tables are rendered as PNG images since Telegram doesn't support table formatting.
- **Permission approval** — when Claude needs to run a tool, you get an inline keyboard with Approve/Deny buttons.
- **Plan approval** — multiple-choice prompts and plan approvals are forwarded with inline buttons.
- **Interrupt on new message** — sending a new message while Claude is working sends Ctrl+C to interrupt, then injects your message.
- **Session management** — attach, detach, and switch between multiple Claude Code sessions running in tmux.
- **Model switching** — use `/model` to change the active Claude model from a picker of available models.
- **Recurring timer** — `/timer` sets up a prompt that auto-injects every N minutes, with response notifications.
- **Session summarization** — `/summarize` reads the session JSONL and produces a concise summary.
- **Context management** — `/clear` and `/compact` manage Claude Code's context window.
- **Auto-restart** — runs as a launchd (macOS) or systemd (Linux) service; `/restart` restarts the bot.
- **Voice polish toggle** — `/polishvoice` toggles whether voice transcripts are cleaned up before injection.

## Prerequisites

- macOS or Linux (uses launchd on macOS, systemd on Linux)
- Node.js 20+
- [tmux](https://github.com/tmux/tmux) — `brew install tmux`
- Claude Code — `npm install -g @anthropic-ai/claude-code`

## Install

```bash
git clone https://github.com/lucapegolotti/codedove.git
cd codedove
npm install
npm install -g .
codedove
```

> **Permission error?** If `npm install -g .` fails with `EACCES`, configure npm to use a user-writable directory:
> ```bash
> mkdir -p ~/.npm-global
> npm config set prefix '~/.npm-global'
> export PATH="$HOME/.npm-global/bin:$PATH"  # add this line to your ~/.zshrc or ~/.bashrc
> npm install -g .
> ```

On first run, a setup wizard walks you through:

1. **API keys** — Telegram bot token (from [@BotFather](https://t.me/BotFather)), Anthropic API key, OpenAI API key
2. **Repositories folder** — where Claude looks for your projects (default: `~/repositories`)
3. **Chat ID** — your Telegram chat ID (required) so only you can use the bot (get it from [@userinfobot](https://t.me/userinfobot))
4. **Claude Code hooks** — installs Stop, Permission, and Compact hooks so the bot gets notified when Claude finishes a turn and receives permission requests
5. **Launch agent** — registers the bot as a macOS launch agent so it starts automatically on login

## Usage

Open Telegram, find your bot by username, and send a message.

### First message

If no session is attached, the bot auto-attaches to the most recently active Claude Code session. Or use `/sessions` to pick one explicitly.

### Text messages

Type anything. The message is injected directly into Claude Code's input.

```
What files are in ~/repositories?
Fix the null pointer in auth.ts
Run the tests and tell me what's failing
```

### Voice messages

Hold the mic button in Telegram and speak your request. The bot:
1. Downloads the OGG audio from Telegram
2. Transcribes it with OpenAI Whisper
3. Optionally polishes the transcript with Claude Haiku (toggle with `/polishvoice`)
4. Injects the cleaned text into Claude Code
5. Synthesizes Claude's response as a voice note (OpenAI TTS, `nova` voice) and sends it back

### Image messages

Send a photo or image file. The bot saves it to `~/.codedove/images/` and injects a message telling Claude Code where to find it. Add a caption to include instructions alongside the image.

### Permission approval

When Claude Code needs your approval to run a command, you get a Telegram notification with the command shown and Yes/No buttons. Approve or deny from your phone.

### Commands

| Command | Description |
|---|---|
| `/sessions` | Pick a Claude Code session to attach to |
| `/detach` | Detach from the current session |
| `/status` | Show attached session, directory, watcher state |
| `/summarize` | Summarise the current Claude Code session |
| `/compact` | Trigger `/compact` in Claude Code |
| `/clear` | Clear Claude Code context |
| `/escape` | Send Escape to cancel Claude's current action |
| `/model` | Switch Claude Code model |
| `/images` | Ask Claude Code for image files it created |
| `/timer` | Set a recurring prompt on a schedule (run again to stop) |
| `/close_session` | Kill the Claude Code tmux window |
| `/polishvoice` | Toggle voice transcript polishing on/off |
| `/restart` | Restart the bot process |
| `/help` | Show all commands |

## Architecture

### Message flow

```
User (Telegram)
      │  text / voice / image
      ▼
Bot (grammy)
      │
      ├── Voice pipeline (voice messages only)
      │     OGG → Whisper STT → polish (Claude Haiku) → text
      │
      ├── Image handler (photo/document messages)
      │     Download → save to ~/.codedove/images/ → inject path
      │
      └── Text injection
            tmux send-keys → Claude Code pane
                    │
                    ▼
              Claude Code runs
              (reads files, runs bash, edits code)
                    │
                    ▼
            ~/.claude/projects/<cwd>/<session>.jsonl
                    │
                    ▼
            JSONL watcher (chokidar)
            reads new bytes after injection baseline
                    │
                    ▼
            Response delivery
            text → Telegram message
            voice → OpenAI TTS → voice note
```

### Session discovery

Claude Code writes its conversation history to `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`, where the cwd is encoded by replacing `/` with `-`. The bot scans this directory to list available sessions, reads the most recent JSONL per project, and extracts the last assistant message for the `/sessions` picker.

When a session is attached, the bot stores `<sessionId>\n<cwd>` in `~/.codedove/attached`.

### Injection

Messages are injected into the Claude Code tmux pane using `tmux send-keys`. The bot identifies the correct pane by matching the current working directory and checking that the process title matches Claude Code's title string (a semver like `2.1.47`).

Text and Enter are sent in two separate `send-keys` calls with a 100ms delay — sending them together causes Enter to fire before Claude Code finishes processing the text.

### Response detection

Before injecting a message, the bot records the current byte offset of the session JSONL file. After injection, a `chokidar` watcher monitors the file. Each new line after the baseline is parsed: if it's an `assistant` message with a text block, the text is delivered to Telegram.

When a `result` event is found (written by the Stop hook), the watcher delivers the final text and stops. This avoids the debounce problem: during an active session, Claude Code continuously writes tool results to the JSONL, which resets a plain debounce timer indefinitely.

### The Stop hook

A shell hook (`~/.claude/hooks/codedove-stop.sh`) is registered as a Claude Code `Stop` hook. After each Claude turn completes, it appends `{"type":"result","source":"stop-hook"}` to the session JSONL. The bot's watcher detects this event and fires immediately.

### Permission hook

When Claude Code needs permission to use a tool, it fires a `Notification` event (matcher: `permission_prompt`). The hook script (`codedove-permission.sh`) writes a request to `~/.codedove/permission-request-<id>.json` and waits for a response file. The bot detects the request via a file watcher, sends a Telegram message with Approve/Deny buttons, and writes the response when the user taps a button. The hook reads the response and exits with 0 (approve) or 2 (deny).

### Compact hooks

Two hooks handle context compaction. A `PreCompact` hook (`codedove-compact-start.sh`) sends a Telegram notification when compaction begins. A `SessionStart` hook (`codedove-compact-end.sh`) fires when the session resumes after compaction and notifies Telegram that compaction is complete.

### Voice pipeline

Voice notes (OGG) are transcribed with OpenAI Whisper, optionally cleaned up by Claude Haiku, and injected as text. Claude's response is narrated into plain prose by Claude Haiku, then converted to audio by OpenAI TTS and sent back as a voice note.

## Security

- **Chat ID allowlist** — configure your Telegram chat ID in the setup wizard. The bot silently ignores messages from all other IDs. Store it in `~/.codedove/config.json` as `allowedChatId`.
- **Bot token** — keep your bot token private. Anyone who can message your bot can run commands on your machine.
- **Tool permissions** — by default Claude Code runs with `acceptEdits` permission mode. The permission hook lets you approve or deny individual tool uses from Telegram.
- **Local only** — the bot runs on your Mac. No data goes anywhere except to the Telegram Bot API, Anthropic API, and OpenAI API.

## Stack

| Layer | Technology |
|---|---|
| Telegram | [grammy](https://grammy.dev) |
| Session bridge | tmux send-keys + JSONL watcher |
| STT | OpenAI Whisper (`whisper-1`) |
| TTS | OpenAI TTS (`nova` voice) |
| Narrator / Voice polish | Claude Haiku (`claude-haiku-4-5-20251001`) |
| TUI | [Ink](https://github.com/vadimdemedes/ink) (React for terminals) |
| Runtime | Node.js + TypeScript (`tsx`) |
| Service | macOS launchd / Linux systemd |

---

