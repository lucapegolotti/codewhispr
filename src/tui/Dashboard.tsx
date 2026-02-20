import { Box, useApp, useInput } from "ink";
import { useState, useEffect, useRef } from "react";
import type { Bot } from "grammy";
import { StatusBar } from "./StatusBar.js";
import { KeyBar } from "./KeyBar.js";
import { LogPane } from "./LogPane.js";
import { SessionPane } from "./SessionPane.js";
import { createBot } from "../telegram/bot.js";
import { clearLogs } from "../logger.js";
import { sendStartupMessage } from "../telegram/notifications.js";

type Status = "running" | "stopped";
type Props = { token: string };

export function Dashboard({ token }: Props) {
  const { exit } = useApp();
  const [status, setStatus] = useState<Status>("stopped");
  const botRef = useRef<Bot | null>(null);

  function start() {
    if (botRef.current) return;
    const bot = createBot(token);
    bot.catch(() => setStatus("stopped"));
    botRef.current = bot;
    bot.start({ onStart: () => {
      setStatus("running");
      sendStartupMessage(bot).catch(() => {});
    }}).catch(() => setStatus("stopped"));
  }

  async function stop() {
    if (!botRef.current) return;
    await botRef.current.stop();
    botRef.current = null;
    setStatus("stopped");
  }

  useEffect(() => {
    start();
    return () => { stop(); };
  }, []);

  useInput((input) => {
    if (input === "q") stop().then(() => exit()).catch(() => exit());
    if (input === "s" && status === "stopped") start();
    if (input === "x" && status === "running") stop();
    if (input === "r") stop().then(() => start()).catch(() => {});
    if (input === "c") clearLogs();
  });

  return (
    <Box flexDirection="column" height="100%">
      <StatusBar status={status} />
      <Box flexGrow={1} borderStyle="single">
        <LogPane />
        <Box borderStyle="single" width={24}>
          <SessionPane />
        </Box>
      </Box>
      <KeyBar status={status} />
    </Box>
  );
}
