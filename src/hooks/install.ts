import { readFile, writeFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { join, dirname } from "path";

const CLAUDE_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

// ---------------------------------------------------------------------------
// HookSpec — defines a hook script and where it gets registered in settings.json
// ---------------------------------------------------------------------------

type HookSpec = {
  /** The hook event group in settings.json (e.g. "Stop", "Notification") */
  hookEvent: string;
  /** Optional matcher value for the group entry */
  matcher: string;
  /** Absolute path where the shell script is written */
  scriptPath: string;
  /** The shell script content */
  scriptContent: string;
  /** Unique substring in scriptPath used to detect if already installed */
  searchString: string;
  /** How to add to an existing settings group: "append-first" adds to the
   *  first existing group, "new-group" always creates a new group entry,
   *  "find-or-create" finds a group with the same matcher or creates one. */
  addStrategy: "append-first" | "new-group" | "find-or-create";
};

type HookGroup = { matcher?: string; hooks: { type: string; command: string }[] };

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

async function readSettings(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(CLAUDE_SETTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function writeSettings(settings: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
  await writeFile(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

function isSpecInstalled(settings: Record<string, unknown>, spec: HookSpec): boolean {
  const groups: HookGroup[] = (settings as Record<string, Record<string, HookGroup[]>>)
    ?.hooks?.[spec.hookEvent] ?? [];
  return groups.some((g) => g.hooks?.some((h) => h.command?.includes(spec.searchString)));
}

async function installSpec(spec: HookSpec): Promise<void> {
  // Write the hook script
  await mkdir(dirname(spec.scriptPath), { recursive: true });
  await writeFile(spec.scriptPath, spec.scriptContent, { mode: 0o755 });
}

function addSpecToSettings(settings: Record<string, unknown>, spec: HookSpec): void {
  if (!settings.hooks) settings.hooks = {};
  const hooks = settings.hooks as Record<string, HookGroup[]>;
  if (!hooks[spec.hookEvent]) hooks[spec.hookEvent] = [];
  const groups = hooks[spec.hookEvent];

  if (isSpecInstalled(settings, spec)) return;

  const entry = { type: "command" as const, command: spec.scriptPath };

  switch (spec.addStrategy) {
    case "append-first":
      if (groups.length > 0) {
        groups[0].hooks.push(entry);
      } else {
        groups.push({ matcher: spec.matcher, hooks: [entry] });
      }
      break;
    case "find-or-create": {
      const existing = groups.find((g) => g.matcher === spec.matcher);
      if (existing) {
        existing.hooks.push(entry);
      } else {
        groups.push({ matcher: spec.matcher, hooks: [entry] });
      }
      break;
    }
    case "new-group":
    default:
      groups.push({ matcher: spec.matcher, hooks: [entry] });
      break;
  }
}

// ---------------------------------------------------------------------------
// Hook definitions
// ---------------------------------------------------------------------------

const STOP_HOOK: HookSpec = {
  hookEvent: "Stop",
  matcher: "",
  scriptPath: join(homedir(), ".claude", "hooks", "codedove-stop.sh"),
  searchString: "codedove-stop",
  addStrategy: "append-first",
  scriptContent: `#!/bin/bash
# Signals codedove bot that Claude has finished a turn.
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
`,
};

// Shared helper used by both compact hooks to send a Telegram notification.
const COMPACT_HOOK_COMMON = `
CODEDOVE_DIR="$HOME/.codedove"
TOKEN=$(cat "$CODEDOVE_DIR/bot-token" 2>/dev/null)
CHAT_ID=$(cat "$CODEDOVE_DIR/chat-id" 2>/dev/null)
[ -z "$TOKEN" ] || [ -z "$CHAT_ID" ] && exit 0

# Only notify for the currently attached session (match by cwd)
ATTACHED_CWD=$(sed -n '2p' "$CODEDOVE_DIR/attached" 2>/dev/null)
HOOK_CWD=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('cwd',''))" 2>/dev/null)
[ -n "$ATTACHED_CWD" ] && [ "$HOOK_CWD" != "$ATTACHED_CWD" ] && exit 0
`;

const PERMISSION_HOOK: HookSpec = {
  hookEvent: "Notification",
  matcher: "permission_prompt",
  scriptPath: join(homedir(), ".claude", "hooks", "codedove-permission.sh"),
  searchString: "codedove-permission",
  addStrategy: "find-or-create",
  scriptContent: `#!/bin/bash
# Forwards Claude Code tool permission requests to the codedove Telegram bot.
# Waits for the user to approve or deny via Telegram, then exits accordingly.
# Clarifying questions (no matching tool name) are ignored — they arrive via the
# normal JSONL text path and the user replies by sending a message in Telegram.

CODEDOVE_DIR="$HOME/.codedove"
mkdir -p "$CODEDOVE_DIR"

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | python3 -c "
import sys, json, re
d = json.load(sys.stdin)
msg = d.get('message', '')
m = re.search(r'permission to use (\\w+)', msg)
print(m.group(1) if m else '')
" 2>/dev/null || echo "")

# Not a tool permission request (e.g. a plan approval prompt) — ignored here.
# These messages arrive via the normal JSONL text path.
if [ -z "$TOOL_NAME" ]; then
  exit 0
fi

TOOL_INPUT=$(echo "$INPUT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d.get('message', json.dumps(d)))
" 2>/dev/null || echo "$INPUT")

TRANSCRIPT_PATH=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('transcript_path',''))" 2>/dev/null || echo "")

REQUEST_ID=$(python3 -c "import uuid; print(str(uuid.uuid4()))")
REQUEST_FILE="$CODEDOVE_DIR/permission-request-\${REQUEST_ID}.json"
RESPONSE_FILE="$CODEDOVE_DIR/permission-response-\${REQUEST_ID}"

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
`,
};

const COMPACT_START_HOOK: HookSpec = {
  hookEvent: "PreCompact",
  matcher: "manual",
  scriptPath: join(homedir(), ".claude", "hooks", "codedove-compact-start.sh"),
  searchString: "codedove-compact-start",
  addStrategy: "new-group",
  scriptContent: `#!/bin/bash
# Notifies the codedove Telegram bot when context compaction begins.
INPUT=$(cat)
${COMPACT_HOOK_COMMON}
curl -s -X POST "https://api.telegram.org/bot\${TOKEN}/sendMessage" \\
  --data-urlencode "chat_id=$CHAT_ID" \\
  --data-urlencode "text=⏳ Compacting context..." > /dev/null 2>&1
exit 0
`,
};

const COMPACT_END_HOOK: HookSpec = {
  hookEvent: "SessionStart",
  matcher: "compact",
  scriptPath: join(homedir(), ".claude", "hooks", "codedove-compact-end.sh"),
  searchString: "codedove-compact-end",
  addStrategy: "new-group",
  scriptContent: `#!/bin/bash
# Notifies the codedove Telegram bot when context compaction finishes.
# Fires via SessionStart with source=compact (Claude Code restarts the session after compaction).
INPUT=$(cat)
SOURCE=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('source',''))" 2>/dev/null)
[ "$SOURCE" != "compact" ] && exit 0
${COMPACT_HOOK_COMMON}
curl -s -X POST "https://api.telegram.org/bot\${TOKEN}/sendMessage" \\
  --data-urlencode "chat_id=$CHAT_ID" \\
  --data-urlencode "text=✅ Compact complete." > /dev/null 2>&1
exit 0
`,
};

// ---------------------------------------------------------------------------
// Public API — unchanged signatures
// ---------------------------------------------------------------------------

export async function isHookInstalled(): Promise<boolean> {
  return isSpecInstalled(await readSettings(), STOP_HOOK);
}

export async function installHook(): Promise<void> {
  await installSpec(STOP_HOOK);
  const settings = await readSettings();
  addSpecToSettings(settings, STOP_HOOK);
  await writeSettings(settings);
}

export async function isPermissionHookInstalled(): Promise<boolean> {
  return isSpecInstalled(await readSettings(), PERMISSION_HOOK);
}

export async function installPermissionHook(): Promise<void> {
  await installSpec(PERMISSION_HOOK);
  const settings = await readSettings();
  addSpecToSettings(settings, PERMISSION_HOOK);
  await writeSettings(settings);
}

export async function isCompactHooksInstalled(): Promise<boolean> {
  return isSpecInstalled(await readSettings(), COMPACT_START_HOOK);
}

export async function installCompactHooks(): Promise<void> {
  await installSpec(COMPACT_START_HOOK);
  await installSpec(COMPACT_END_HOOK);
  const settings = await readSettings();
  addSpecToSettings(settings, COMPACT_START_HOOK);
  addSpecToSettings(settings, COMPACT_END_HOOK);
  await writeSettings(settings);
}
