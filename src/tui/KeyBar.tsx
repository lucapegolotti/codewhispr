import { Box, Text } from "ink";

type Props = { status: "running" | "stopped"; hookStatus?: "unknown" | "installed" | "missing" | "installing" };

export function KeyBar({ status, hookStatus }: Props) {
  return (
    <Box paddingX={1} gap={3}>
      {status === "stopped" ? (
        <Text>[s] start service</Text>
      ) : (
        <Text>[x] stop service</Text>
      )}
      <Text>[r] restart</Text>
      <Text>[c] clear logs</Text>
      {hookStatus === "missing" && <Text color="yellow">[i] install hook</Text>}
    </Box>
  );
}
