import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { installLaunchd, PLIST_PATH } from "../launchd/install.js";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// The codewhispr binary is at <install-dir>/bin/codewhispr
const CODEWHISPR_BIN = resolve(__dirname, "..", "..", "bin", "codewhispr");

type Props = { onComplete: () => void };

export function SetupLaunchd({ onComplete }: Props) {
  const [state, setState] = useState<"prompt" | "installing" | "done">("prompt");

  useInput(async (input) => {
    if (state !== "prompt") return;
    if (input === "y" || input === "Y") {
      setState("installing");
      await installLaunchd(CODEWHISPR_BIN).catch(() => {});
      setState("done");
      setTimeout(onComplete, 1000);
    }
    if (input === "n" || input === "N") {
      onComplete();
    }
  });

  if (state === "installing") {
    return (
      <Box padding={2}>
        <Text color="yellow">Registering launch agent…</Text>
      </Box>
    );
  }

  if (state === "done") {
    return (
      <Box flexDirection="column" gap={1} padding={2}>
        <Text color="green">✓ Bot registered as a macOS launch agent.</Text>
        <Text dimColor>It will start automatically when you log in.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1} padding={2}>
      <Text bold>Register as macOS launch agent?</Text>
      <Text dimColor>The bot will start automatically when you log in.</Text>
      <Text dimColor>Plist: {PLIST_PATH}</Text>
      <Box marginTop={1}>
        <Text bold>Register now? [y/n] </Text>
      </Box>
    </Box>
  );
}
