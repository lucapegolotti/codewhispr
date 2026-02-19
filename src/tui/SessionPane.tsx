import { Box, Text } from "ink";
import { useState, useEffect } from "react";
import { logEmitter } from "../logger.js";
import { getActiveSessions } from "../session/adapter.js";

export function SessionPane() {
  const [sessions, setSessions] = useState<number[]>(getActiveSessions());

  useEffect(() => {
    const onSession = () => setSessions(getActiveSessions());
    logEmitter.on("session", onSession);
    return () => { logEmitter.off("session", onSession); };
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
