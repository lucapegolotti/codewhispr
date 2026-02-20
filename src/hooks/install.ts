import { readFile, writeFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { join, dirname } from "path";

const HOOK_SCRIPT_PATH = join(homedir(), ".claude", "hooks", "claude-voice-stop.sh");
const CLAUDE_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

const HOOK_SCRIPT = `#!/bin/bash
# Signals claude-voice bot that Claude has finished a turn.
# Appends a result event to the session JSONL so the bot's watcher
# can fire the voice narration without relying on a silence timeout.

INPUT=$(cat)

STOP_HOOK_ACTIVE=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('stop_hook_active', False))" 2>/dev/null)
if [ "$STOP_HOOK_ACTIVE" = "True" ]; then
  exit 0
fi

TRANSCRIPT=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('transcript_path', ''))" 2>/dev/null)
if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
  echo '{"type":"result","source":"stop-hook"}' >> "$TRANSCRIPT"
fi

exit 0
`;

const PERMISSION_HOOK_SCRIPT_PATH = join(homedir(), ".claude", "hooks", "claude-voice-permission.sh");

const PERMISSION_HOOK_SCRIPT = `#!/bin/bash
# Forwards Claude Code permission requests to the claude-voice Telegram bot.
# Waits for the user to approve or deny via Telegram, then exits accordingly.

CLAUDE_VOICE_DIR="$HOME/.claude-voice"
mkdir -p "$CLAUDE_VOICE_DIR"

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | python3 -c "
import sys, json, re
d = json.load(sys.stdin)
msg = d.get('message', '')
m = re.search(r'permission to use (\\w+)', msg)
print(m.group(1) if m else d.get('tool_name', 'unknown'))
" 2>/dev/null || echo "unknown")

TOOL_INPUT=$(echo "$INPUT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d.get('message', json.dumps(d)))
" 2>/dev/null || echo "$INPUT")

TRANSCRIPT_PATH=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('transcript_path',''))" 2>/dev/null || echo "")

REQUEST_ID=$(python3 -c "import uuid; print(str(uuid.uuid4()))")
REQUEST_FILE="$CLAUDE_VOICE_DIR/permission-request-\${REQUEST_ID}.json"
RESPONSE_FILE="$CLAUDE_VOICE_DIR/permission-response-\${REQUEST_ID}"

python3 -c "
import json, sys
data = {
    'requestId': sys.argv[1],
    'toolName': sys.argv[2],
    'toolInput': sys.argv[3],
    'transcriptPath': sys.argv[4],
}
print(json.dumps(data))
" "$REQUEST_ID" "$TOOL_NAME" "$TOOL_INPUT" "$TRANSCRIPT_PATH" > "$REQUEST_FILE"

TIMEOUT=300
ELAPSED=0
while [ $ELAPSED -lt $TIMEOUT ]; do
  if [ -f "$RESPONSE_FILE" ]; then
    RESPONSE=$(cat "$RESPONSE_FILE" | tr -d '\\n\\r' | tr '[:upper:]' '[:lower:]')
    rm -f "$REQUEST_FILE" "$RESPONSE_FILE"
    [ "$RESPONSE" = "approve" ] && exit 0 || exit 2
  fi
  sleep 1
  ELAPSED=$((ELAPSED + 1))
done

rm -f "$REQUEST_FILE"
exit 0
`;

const COMPACT_START_HOOK_PATH = join(homedir(), ".claude", "hooks", "claude-voice-compact-start.sh");
const COMPACT_END_HOOK_PATH = join(homedir(), ".claude", "hooks", "claude-voice-compact-end.sh");

// Shared helper used by both compact hooks to send a Telegram notification.
const COMPACT_HOOK_COMMON = `
CLAUDE_VOICE_DIR="$HOME/.claude-voice"
TOKEN=$(cat "$CLAUDE_VOICE_DIR/bot-token" 2>/dev/null)
CHAT_ID=$(cat "$CLAUDE_VOICE_DIR/chat-id" 2>/dev/null)
[ -z "$TOKEN" ] || [ -z "$CHAT_ID" ] && exit 0

# Only notify for the currently attached session (match by cwd)
ATTACHED_CWD=$(sed -n '2p' "$CLAUDE_VOICE_DIR/attached" 2>/dev/null)
HOOK_CWD=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('cwd',''))" 2>/dev/null)
[ -n "$ATTACHED_CWD" ] && [ "$HOOK_CWD" != "$ATTACHED_CWD" ] && exit 0
`;

const COMPACT_START_HOOK_SCRIPT = `#!/bin/bash
# Notifies the claude-voice Telegram bot when context compaction begins.
INPUT=$(cat)
${COMPACT_HOOK_COMMON}
curl -s -X POST "https://api.telegram.org/bot\${TOKEN}/sendMessage" \\
  --data-urlencode "chat_id=$CHAT_ID" \\
  --data-urlencode "text=⏳ Compacting context..." > /dev/null 2>&1
exit 0
`;

const COMPACT_END_HOOK_SCRIPT = `#!/bin/bash
# Notifies the claude-voice Telegram bot when context compaction finishes.
# Fires via SessionStart with source=compact (Claude Code restarts the session after compaction).
INPUT=$(cat)
SOURCE=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('source',''))" 2>/dev/null)
[ "$SOURCE" != "compact" ] && exit 0
${COMPACT_HOOK_COMMON}
curl -s -X POST "https://api.telegram.org/bot\${TOKEN}/sendMessage" \\
  --data-urlencode "chat_id=$CHAT_ID" \\
  --data-urlencode "text=✅ Compact complete." > /dev/null 2>&1
exit 0
`;

export async function isCompactHooksInstalled(): Promise<boolean> {
  try {
    const raw = await readFile(CLAUDE_SETTINGS_PATH, "utf8");
    const settings = JSON.parse(raw);
    const preCompactGroups: { hooks?: { command?: string }[] }[] = settings?.hooks?.PreCompact ?? [];
    return preCompactGroups.some((group) =>
      group.hooks?.some((h) => h.command?.includes("claude-voice-compact-start"))
    );
  } catch {
    return false;
  }
}

export async function installCompactHooks(): Promise<void> {
  await mkdir(dirname(COMPACT_START_HOOK_PATH), { recursive: true });
  await writeFile(COMPACT_START_HOOK_PATH, COMPACT_START_HOOK_SCRIPT, { mode: 0o755 });
  await writeFile(COMPACT_END_HOOK_PATH, COMPACT_END_HOOK_SCRIPT, { mode: 0o755 });

  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(await readFile(CLAUDE_SETTINGS_PATH, "utf8"));
  } catch {
    // File may not exist yet
  }

  if (!settings.hooks) settings.hooks = {};
  const hooks = settings.hooks as Record<string, unknown[]>;

  // PreCompact hook — fires when /compact begins
  if (!hooks.PreCompact) hooks.PreCompact = [];
  type HookGroup = { matcher?: string; hooks: { type: string; command: string }[] };
  const preCompactGroups = hooks.PreCompact as HookGroup[];
  const preAlreadyInstalled = preCompactGroups.some((g) =>
    g.hooks?.some((h) => h.command?.includes("claude-voice-compact-start"))
  );
  if (!preAlreadyInstalled) {
    preCompactGroups.push({
      matcher: "manual",
      hooks: [{ type: "command", command: COMPACT_START_HOOK_PATH }],
    });
  }

  // SessionStart hook — fires when the session restarts after compaction completes
  if (!hooks.SessionStart) hooks.SessionStart = [];
  const sessionStartGroups = hooks.SessionStart as HookGroup[];
  const sessionAlreadyInstalled = sessionStartGroups.some((g) =>
    g.hooks?.some((h) => h.command?.includes("claude-voice-compact-end"))
  );
  if (!sessionAlreadyInstalled) {
    sessionStartGroups.push({
      matcher: "compact",
      hooks: [{ type: "command", command: COMPACT_END_HOOK_PATH }],
    });
  }

  await mkdir(dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
  await writeFile(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

export async function isPermissionHookInstalled(): Promise<boolean> {
  try {
    const raw = await readFile(CLAUDE_SETTINGS_PATH, "utf8");
    const settings = JSON.parse(raw);
    const notifGroups: { hooks?: { command?: string }[] }[] = settings?.hooks?.Notification ?? [];
    return notifGroups.some((group) =>
      group.hooks?.some((h) => h.command?.includes("claude-voice-permission"))
    );
  } catch {
    return false;
  }
}

export async function installPermissionHook(): Promise<void> {
  await mkdir(dirname(PERMISSION_HOOK_SCRIPT_PATH), { recursive: true });
  await writeFile(PERMISSION_HOOK_SCRIPT_PATH, PERMISSION_HOOK_SCRIPT, { mode: 0o755 });

  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(await readFile(CLAUDE_SETTINGS_PATH, "utf8"));
  } catch {
    // File may not exist yet
  }

  if (!settings.hooks) settings.hooks = {};
  const hooks = settings.hooks as Record<string, unknown[]>;
  if (!hooks.Notification) hooks.Notification = [];

  type NotifGroup = { matcher?: string; hooks: { type: string; command: string }[] };
  const notifGroups = hooks.Notification as NotifGroup[];

  const alreadyInstalled = notifGroups.some((g) =>
    g.hooks?.some((h) => h.command?.includes("claude-voice-permission"))
  );

  if (!alreadyInstalled) {
    const permGroup = notifGroups.find((g) => g.matcher === "permission_prompt");
    if (permGroup) {
      permGroup.hooks.push({ type: "command", command: PERMISSION_HOOK_SCRIPT_PATH });
    } else {
      notifGroups.push({
        matcher: "permission_prompt",
        hooks: [{ type: "command", command: PERMISSION_HOOK_SCRIPT_PATH }],
      });
    }
  }

  await mkdir(dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
  await writeFile(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

export async function isHookInstalled(): Promise<boolean> {
  try {
    const raw = await readFile(CLAUDE_SETTINGS_PATH, "utf8");
    const settings = JSON.parse(raw);
    const stopGroups: { hooks?: { command?: string }[] }[] = settings?.hooks?.Stop ?? [];
    return stopGroups.some((group) =>
      group.hooks?.some((h) => h.command?.includes("claude-voice-stop"))
    );
  } catch {
    return false;
  }
}

export async function installHook(): Promise<void> {
  // Write the hook script
  await mkdir(dirname(HOOK_SCRIPT_PATH), { recursive: true });
  await writeFile(HOOK_SCRIPT_PATH, HOOK_SCRIPT, { mode: 0o755 });

  // Update ~/.claude/settings.json
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(await readFile(CLAUDE_SETTINGS_PATH, "utf8"));
  } catch {
    // File may not exist yet
  }

  if (!settings.hooks) settings.hooks = {};
  const hooks = settings.hooks as Record<string, unknown[]>;
  if (!hooks.Stop) hooks.Stop = [];

  const stopGroups = hooks.Stop as { matcher?: string; hooks: { type: string; command: string }[] }[];
  const alreadyInstalled = stopGroups.some((g) =>
    g.hooks?.some((h) => h.command?.includes("claude-voice-stop"))
  );

  if (!alreadyInstalled) {
    if (stopGroups.length > 0) {
      // Add to the existing first group alongside other Stop hooks
      stopGroups[0].hooks.push({ type: "command", command: HOOK_SCRIPT_PATH });
    } else {
      stopGroups.push({ matcher: "", hooks: [{ type: "command", command: HOOK_SCRIPT_PATH }] });
    }
  }

  await mkdir(dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
  await writeFile(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf8");
}
