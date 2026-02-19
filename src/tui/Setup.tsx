import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { useState } from "react";
import { writeFileSync } from "fs";

const STEPS = [
  { key: "TELEGRAM_BOT_TOKEN", label: "Telegram bot token", hint: "Get from @BotFather → /newbot" },
  { key: "ANTHROPIC_API_KEY",  label: "Anthropic API key",  hint: "console.anthropic.com" },
  { key: "OPENAI_API_KEY",     label: "OpenAI API key",     hint: "platform.openai.com/api-keys" },
] as const;

type Key = typeof STEPS[number]["key"];
type Props = { envPath: string; onComplete: () => void };

export function Setup({ envPath, onComplete }: Props) {
  const [step, setStep] = useState(0);
  const [values, setValues] = useState<Partial<Record<Key, string>>>({});
  const [input, setInput] = useState("");

  const current = STEPS[step];

  function handleSubmit(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;

    const next = { ...values, [current.key]: trimmed };
    setValues(next);
    setInput("");

    if (step === STEPS.length - 1) {
      const content = STEPS.map(s => `${s.key}=${next[s.key]}`).join("\n") + "\n";
      writeFileSync(envPath, content, "utf8");
      onComplete();
    } else {
      setStep(step + 1);
    }
  }

  return (
    <Box flexDirection="column" gap={1} padding={2}>
      <Text bold>claude-voice setup</Text>
      <Text dimColor>Enter your API credentials. They'll be saved to .env</Text>
      <Box flexDirection="column" marginTop={1} gap={1}>
        {STEPS.slice(0, step).map(s => (
          <Text key={s.key} color="green">✓ {s.label}</Text>
        ))}
        <Box gap={1}>
          <Text bold>{current.label}: </Text>
          <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} mask="*" />
        </Box>
        <Text dimColor>{current.hint}</Text>
      </Box>
    </Box>
  );
}
