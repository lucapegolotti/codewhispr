import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { installService, SERVICE_FILE_PATH } from "../service/index.js";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// The bot entry point (runs src/index.ts, not the TUI)
const CODEDOVE_BIN = resolve(__dirname, "..", "..", "bin", "codedove-bot");

const isMac = process.platform === "darwin";
const serviceLabel = isMac ? "macOS launch agent" : "systemd user service";

type Props = { onComplete: () => void };

export function SetupLaunchd({ onComplete }: Props) {
  const [state, setState] = useState<"prompt" | "installing" | "done">("prompt");

  useInput(async (input) => {
    if (state !== "prompt") return;
    if (input === "y" || input === "Y") {
      setState("installing");
      await installService(CODEDOVE_BIN).catch(() => {});
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
        <Text color="yellow">Registering {serviceLabel}…</Text>
      </Box>
    );
  }

  if (state === "done") {
    return (
      <Box flexDirection="column" gap={1} padding={2}>
        <Text color="green">✓ Bot registered as a {serviceLabel}.</Text>
        <Text dimColor>It will start automatically when you log in.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1} padding={2}>
      <Text bold>Register as {serviceLabel}?</Text>
      <Text dimColor>The bot will start automatically when you log in.</Text>
      <Text dimColor>Service file: {SERVICE_FILE_PATH}</Text>
      <Box marginTop={1}>
        <Text bold>Register now? [y/n] </Text>
      </Box>
    </Box>
  );
}
