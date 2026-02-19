# claude-voice

A Telegram bot that lets you have conversations with the Claude Agent SDK from your phone — via text or voice notes.

Send a message or hold the mic button → Claude does the work on your Mac → you get a short, conversational reply (or a voice message back).

## How it works

```
Telegram text/voice
        ↓
  [Telegram Bot]
        ↓
  [Voice Pipeline]  ← OGG → Whisper STT (voice notes only)
        ↓
  [Session Manager] ← persistent session per chat ID
        ↓
  [Claude Agent SDK] ← reads files, runs commands, edits code
        ↓
  [Narrator]        ← claude-haiku converts output to 1-3 sentences
        ↓
Telegram text/voice reply (OpenAI TTS for voice)
```

One Telegram conversation = one persistent Claude Agent SDK session. Claude remembers what it did earlier in the conversation.

## Setup

### 1. Get credentials

- **Telegram bot token** — message [@BotFather](https://t.me/BotFather), send `/newbot`
- **Anthropic API key** — [console.anthropic.com](https://console.anthropic.com)
- **OpenAI API key** — [platform.openai.com/api-keys](https://platform.openai.com/api-keys)

### 2. Configure

```bash
cp .env.example .env
# Edit .env and fill in the three keys
```

### 3. Install and run

```bash
npm install
npm start
```

The bot will print `claude-voice bot running` once it's polling.

## Usage

Open Telegram, find your bot, and start chatting.

**Text:** Type anything — "what's in ~/repositories?" or "fix the bug in auth.ts"

**Voice:** Hold the mic button in Telegram, ask your question out loud. You'll get a voice message back.

Claude has access to your filesystem (read/write/edit), bash, and search. It starts from your home directory and will look for projects in `~/repositories/` by name.

## Security note

This bot runs with `permissionMode: "acceptEdits"` and shell access (`Bash` tool). Only share the bot token with yourself — anyone who can message the bot can run commands on your machine. Consider adding a chat ID allowlist if you ever share the token.

## Stack

| Layer | Technology |
|---|---|
| Telegram | [grammy](https://grammy.dev) |
| Agent | [@anthropic-ai/claude-agent-sdk](https://platform.claude.com/docs/en/agent-sdk/overview) |
| Narrator | Claude Haiku (`@anthropic-ai/sdk`) |
| STT | OpenAI Whisper |
| TTS | OpenAI TTS (`nova` voice) |
| Runtime | Node.js + TypeScript (`tsx`) |
