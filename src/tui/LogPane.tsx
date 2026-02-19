import { Box, Text, useStdout } from "ink";
import { useState, useEffect } from "react";
import { logEmitter, getLogs, type LogEntry } from "../logger.js";

export function LogPane() {
  const { stdout } = useStdout();
  const [logs, setLogs] = useState<LogEntry[]>(getLogs());

  useEffect(() => {
    const onLog = () => setLogs(getLogs());
    const onClear = () => setLogs([]);
    logEmitter.on("log", onLog);
    logEmitter.on("clear", onClear);
    return () => {
      logEmitter.off("log", onLog);
      logEmitter.off("clear", onClear);
    };
  }, []);

  const height = (stdout?.rows ?? 24) - 4;
  const visible = logs.slice(-height);

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Text bold dimColor>LOGS</Text>
      {visible.map((entry, i) => (
        <Box key={i} gap={1}>
          <Text dimColor>{entry.time}</Text>
          {entry.direction === "in" && <Text color="cyan">←</Text>}
          {entry.direction === "out" && <Text color="green">→</Text>}
          {!entry.direction && <Text> </Text>}
          {entry.chatId !== undefined && <Text dimColor>{entry.chatId}</Text>}
          <Text wrap="truncate">{entry.message}</Text>
        </Box>
      ))}
    </Box>
  );
}
