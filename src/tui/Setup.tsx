import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { useState } from "react";
import { writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { saveConfig } from "../config/config.js";
import { SetupHooks } from "./SetupHooks.js";
import { SetupLaunchd } from "./SetupLaunchd.js";

// API key steps (phase 1) - still require non-empty input
const API_STEPS = [
  { key: "TELEGRAM_BOT_TOKEN", label: "Telegram bot token", hint: "Get from @BotFather → /newbot" },
  { key: "ANTHROPIC_API_KEY",  label: "Anthropic API key",  hint: "console.anthropic.com" },
  { key: "OPENAI_API_KEY",     label: "OpenAI API key",     hint: "platform.openai.com/api-keys" },
] as const;

type ApiKey = typeof API_STEPS[number]["key"];

// Config steps (phase 2) - allow empty (use default)
const CONFIG_STEPS = [
  {
    key: "reposFolder" as const,
    label: "Repositories folder",
    hint: "Default folder for your projects. Press Enter to use the default.",
    defaultValue: join(homedir(), "repositories"),
  },
  {
    key: "allowedChatId" as const,
    label: "Your Telegram chat ID",
    hint: "Message @userinfobot to find your ID.",
    defaultValue: "",
  },
];

type Props = { envPath: string; onComplete: () => void };
type Phase = "api" | "config" | "hooks" | "launchd";

export function Setup({ envPath, onComplete }: Props) {
  const [phase, setPhase] = useState<Phase>("api");
  const [apiStep, setApiStep] = useState(0);
  const [configStep, setConfigStep] = useState(0);
  const [apiValues, setApiValues] = useState<Partial<Record<ApiKey, string>>>({});
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleApiSubmit(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    const current = API_STEPS[apiStep];
    const next = { ...apiValues, [current.key]: trimmed };
    setApiValues(next);
    setInput("");

    if (apiStep === API_STEPS.length - 1) {
      const content = API_STEPS.map((s) => {
        const v = next[s.key] ?? "";
        const escaped = v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$");
        return `${s.key}="${escaped}"`;
      }).join("\n") + "\n";
      try {
        await writeFile(envPath, content, "utf8");
        setPhase("config");
      } catch (err) {
        setError(`Failed to write .env: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      setApiStep(apiStep + 1);
    }
  }

  async function handleConfigSubmit(value: string) {
    const current = CONFIG_STEPS[configStep];
    const trimmed = value.trim() || current.defaultValue;

    // Chat ID is required and must be a valid number
    if (current.key === "allowedChatId") {
      const parsed = parseInt(trimmed, 10);
      if (!trimmed || !Number.isFinite(parsed)) {
        setError(null);
        return; // silently reject empty/invalid input
      }
    }

    const next = { ...configValues, [current.key]: trimmed };
    setConfigValues(next);
    setInput("");

    if (configStep === CONFIG_STEPS.length - 1) {
      try {
        const chatId = parseInt(next.allowedChatId ?? "", 10);
        await saveConfig({
          reposFolder: next.reposFolder || CONFIG_STEPS[0].defaultValue,
          allowedChatId: chatId,
        });
        setPhase("hooks");
      } catch (err) {
        setError(`Failed to write config: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      setConfigStep(configStep + 1);
    }
  }

  if (error) {
    return (
      <Box flexDirection="column" gap={1} padding={2}>
        <Text bold color="red">Setup failed</Text>
        <Text>{error}</Text>
      </Box>
    );
  }

  if (phase === "api") {
    const current = API_STEPS[apiStep];
    return (
      <Box flexDirection="column" gap={1} padding={2}>
        <Text bold>codedove setup — API keys ({apiStep + 1}/{API_STEPS.length})</Text>
        <Text dimColor>Credentials are saved to .env in the install directory.</Text>
        <Box flexDirection="column" marginTop={1} gap={1}>
          {API_STEPS.slice(0, apiStep).map((s) => (
            <Text key={s.key} color="green">✓ {s.label}</Text>
          ))}
          <Box gap={1}>
            <Text bold>{current.label}: </Text>
            <TextInput value={input} onChange={setInput} onSubmit={handleApiSubmit} mask="*" />
          </Box>
          <Text dimColor>{current.hint}</Text>
        </Box>
      </Box>
    );
  }

  if (phase === "hooks") return <SetupHooks onComplete={() => setPhase("launchd")} />;
  if (phase === "launchd") return <SetupLaunchd onComplete={onComplete} />;

  // config phase
  const current = CONFIG_STEPS[configStep];
  return (
    <Box flexDirection="column" gap={1} padding={2}>
      <Text bold>codedove setup — preferences ({configStep + 1}/{CONFIG_STEPS.length})</Text>
      <Text dimColor>Saved to ~/.codedove/config.json</Text>
      <Box flexDirection="column" marginTop={1} gap={1}>
        {CONFIG_STEPS.slice(0, configStep).map((s) => (
          <Text key={s.key} color="green">✓ {s.label}</Text>
        ))}
        <Box gap={1}>
          <Text bold>{current.label}: </Text>
          <TextInput value={input} onChange={setInput} onSubmit={handleConfigSubmit} />
        </Box>
        <Text dimColor>
          {current.hint}
          {current.defaultValue ? `  Default: ${current.defaultValue}` : ""}
        </Text>
      </Box>
    </Box>
  );
}
