import { Box, Text, useInput } from "ink";
import { useState, useEffect } from "react";
import {
  isHookInstalled, installHook,
  isPermissionHookInstalled, installPermissionHook,
  isCompactHooksInstalled, installCompactHooks,
} from "../hooks/install.js";

type HookState = "checking" | "installed" | "missing" | "installing";
type Props = { onComplete: () => void };

export function SetupHooks({ onComplete }: Props) {
  const [stop, setStop] = useState<HookState>("checking");
  const [perm, setPerm] = useState<HookState>("checking");
  const [compact, setCompact] = useState<HookState>("checking");
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    isHookInstalled().then((ok) => setStop(ok ? "installed" : "missing"));
    isPermissionHookInstalled().then((ok) => setPerm(ok ? "installed" : "missing"));
    isCompactHooksInstalled().then((ok) => setCompact(ok ? "installed" : "missing"));
  }, []);

  const checking = stop === "checking" || perm === "checking" || compact === "checking";
  const allInstalled = stop === "installed" && perm === "installed" && compact === "installed";

  async function installAll() {
    setInstalling(true);
    if (stop === "missing") { setStop("installing"); await installHook().catch(() => {}); setStop("installed"); }
    if (perm === "missing") { setPerm("installing"); await installPermissionHook().catch(() => {}); setPerm("installed"); }
    if (compact === "missing") { setCompact("installing"); await installCompactHooks().catch(() => {}); setCompact("installed"); }
    setInstalling(false);
    onComplete();
  }

  useInput((input) => {
    if (installing || checking) return;
    if (allInstalled) { onComplete(); return; }
    if (input === "y" || input === "Y") { void installAll(); }
    if (input === "n" || input === "N") { onComplete(); }
  });

  if (allInstalled && !installing) {
    return (
      <Box flexDirection="column" gap={1} padding={2}>
        <Text color="green">✓ All Claude Code hooks are already installed.</Text>
        <Text dimColor>Press any key to continue…</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1} padding={2}>
      <Text bold>Claude Code hooks</Text>
      <Text dimColor>Hooks let the bot know when Claude finishes a turn and handle permissions.</Text>
      <Box flexDirection="column" marginTop={1} gap={0}>
        <Text>{stop === "installed" ? "✓" : stop === "installing" ? "…" : "✗"} Stop hook (turn completion)</Text>
        <Text>{perm === "installed" ? "✓" : perm === "installing" ? "…" : "✗"} Permission hook (approve/deny from Telegram)</Text>
        <Text>{compact === "installed" ? "✓" : compact === "installing" ? "…" : "✗"} Compact hooks (compaction notifications)</Text>
      </Box>
      {!checking && !installing && (
        <Box marginTop={1}>
          <Text bold>Install missing hooks? [y/n] </Text>
        </Box>
      )}
      {installing && <Text color="yellow">Installing…</Text>}
    </Box>
  );
}
