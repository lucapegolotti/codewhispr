import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { useState } from "react";
import { writeFile } from "fs/promises";

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
  const [error, setError] = useState<string | null>(null);

  const current = STEPS[step];

  async function handleSubmit(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;

    const next = { ...values, [current.key]: trimmed };
    setValues(next);
    setInput("");

    if (step === STEPS.length - 1) {
      const content = STEPS.map(s => {
        const v = next[s.key] ?? "";
        const escaped = v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        return `${s.key}="${escaped}"`;
      }).join("\n") + "\n";
      try {
        await writeFile(envPath, content, "utf8");
        onComplete();
      } catch (err) {
        setError(`Failed to write .env: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      setStep(step + 1);
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
