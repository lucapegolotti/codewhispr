import { Box, Text, useStdout } from "ink";
import { useState, useEffect, useRef } from "react";
import { watch } from "fs";
import { readFile } from "fs/promises";
import { homedir } from "os";

const LOG_PATH = `${homedir()}/.codewhispr/bot.log`;

type LogLine = { raw: string; direction?: "in" | "out" };

function parseLine(raw: string): LogLine {
  if (raw.includes(" [in] ")) return { raw, direction: "in" };
  if (raw.includes(" [out] ")) return { raw, direction: "out" };
  return { raw };
}

type Props = { clearCount: number };

export function LogPane({ clearCount }: Props) {
  const { stdout } = useStdout();
  const [lines, setLines] = useState<LogLine[]>([]);
  const offsetRef = useRef(0);
  const prevClear = useRef(clearCount);

  async function readNew() {
    try {
      const buf = await readFile(LOG_PATH);
      const newContent = buf.subarray(offsetRef.current).toString("utf8");
      if (!newContent) return;
      offsetRef.current = buf.length;
      const newLines = newContent.split("\n").filter(Boolean).map(parseLine);
      setLines((prev) => [...prev, ...newLines].slice(-1000));
    } catch {
      // file may not exist yet
    }
  }

  useEffect(() => {
    readNew();
    let watcher: ReturnType<typeof watch> | null = null;
    try {
      watcher = watch(LOG_PATH, () => readNew());
    } catch {
      // file may not exist yet; will pick up once it's created
    }
    return () => watcher?.close();
  }, []);

  useEffect(() => {
    if (clearCount !== prevClear.current) {
      prevClear.current = clearCount;
      offsetRef.current = 0;
      setLines([]);
    }
  }, [clearCount]);

  const height = (stdout?.rows ?? 24) - 4;
  const visible = lines.slice(-height);

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Text bold dimColor>LOGS</Text>
      {visible.map((line, i) => (
        <Box key={i}>
          {line.direction === "in" && <Text color="cyan">← </Text>}
          {line.direction === "out" && <Text color="green">→ </Text>}
          {!line.direction && <Text>  </Text>}
          <Text wrap="truncate">{line.raw}</Text>
        </Box>
      ))}
    </Box>
  );
}
