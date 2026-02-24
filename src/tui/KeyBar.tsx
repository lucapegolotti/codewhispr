import { Box, Text } from "ink";

type Props = { status: "running" | "stopped" | "not_installed"; hookStatus?: "unknown" | "installed" | "missing" | "installing" };

export function KeyBar({ status, hookStatus }: Props) {
  return (
    <Box paddingX={1} gap={3}>
      {status === "not_installed" ? (
        <Text dimColor>[s/r] service not installed</Text>
      ) : status === "stopped" ? (
        <Text>[s] start service</Text>
      ) : (
        <Text>[x] stop service</Text>
      )}
      {status !== "not_installed" && <Text>[r] restart</Text>}
      <Text>[c] clear logs</Text>
      {hookStatus === "missing" && <Text color="yellow">[i] install hook</Text>}
    </Box>
  );
}
