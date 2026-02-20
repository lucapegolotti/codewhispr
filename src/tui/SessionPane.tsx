import { Box, Text } from "ink";
import { useState, useEffect } from "react";
import { watch } from "fs";
import { getAttachedSession, listSessions, ATTACHED_SESSION_PATH } from "../session/history.js";

type AttachedInfo = { projectName: string; cwd: string } | null;

async function readAttached(): Promise<AttachedInfo> {
  const session = await getAttachedSession().catch(() => null);
  if (!session) return null;
  const sessions = await listSessions(20).catch(() => []);
  const info = sessions.find((s) => s.sessionId === session.sessionId);
  return { projectName: info?.projectName ?? "(unknown)", cwd: session.cwd };
}

export function SessionPane() {
  const [attached, setAttached] = useState<AttachedInfo>(null);

  useEffect(() => {
    readAttached().then(setAttached);

    let watcher: ReturnType<typeof watch> | null = null;
    try {
      watcher = watch(ATTACHED_SESSION_PATH, () => readAttached().then(setAttached));
    } catch {
      // file may not exist yet
    }

    const interval = setInterval(() => readAttached().then(setAttached), 5000);
    return () => {
      watcher?.close();
      clearInterval(interval);
    };
  }, []);

  return (
    <Box flexDirection="column" width={22} paddingX={1}>
      <Text bold dimColor>ATTACHED</Text>
      {attached ? (
        <>
          <Text color="green">{attached.projectName}</Text>
          <Text dimColor wrap="truncate">{attached.cwd}</Text>
        </>
      ) : (
        <Text dimColor>none</Text>
      )}
    </Box>
  );
}
