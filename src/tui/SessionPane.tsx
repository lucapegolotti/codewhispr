import { Box, Text } from "ink";
import { useState, useEffect } from "react";
import { logEmitter } from "../logger.js";
import { getActiveSessions } from "../sessions.js";

export function SessionPane() {
  const [sessions, setSessions] = useState<number[]>(getActiveSessions());

  useEffect(() => {
    const onLog = () => setSessions(getActiveSessions());
    logEmitter.on("log", onLog);
    return () => { logEmitter.off("log", onLog); };
  }, []);

  return (
    <Box flexDirection="column" width={22} paddingX={1}>
      <Text bold dimColor>SESSIONS</Text>
      {sessions.length === 0
        ? <Text dimColor>none yet</Text>
        : sessions.map(id => <Text key={id}>{id}</Text>)
      }
    </Box>
  );
}
