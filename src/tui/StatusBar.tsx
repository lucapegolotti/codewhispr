import { Box, Text } from "ink";

type Props = { status: "running" | "stopped" };

export function StatusBar({ status }: Props) {
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text bold>codewhispr</Text>
      <Box gap={3}>
        <Text color={status === "running" ? "green" : "yellow"}>
          {status === "running" ? "● RUNNING" : "○ STOPPED"}
        </Text>
        <Text dimColor>[q] quit</Text>
      </Box>
    </Box>
  );
}
