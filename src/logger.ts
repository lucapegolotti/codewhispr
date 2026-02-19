import { EventEmitter } from "events";

export type LogEntry = {
  time: string;
  chatId?: number;
  direction?: "in" | "out";
  message: string;
};

function timestamp(): string {
  return new Date().toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export const logEmitter = new EventEmitter();
logEmitter.setMaxListeners(20);
const MAX_BUFFER = 1000;
let buffer: LogEntry[] = [];

export function log(entry: Omit<LogEntry, "time">): void {
  const full: LogEntry = { time: timestamp(), ...entry };
  buffer.push(full);
  if (buffer.length > MAX_BUFFER) buffer.shift();
  logEmitter.emit("log", full);
}

export function getLogs(): LogEntry[] {
  return [...buffer];
}

export function clearLogs(): void {
  buffer = [];
  logEmitter.emit("clear");
}
