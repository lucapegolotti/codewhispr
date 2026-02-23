import { log } from "../../logger.js";
import { getAttachedSession, listSessions } from "../../session/history.js";
import { findClaudePane, sendKeysToPane } from "../../session/tmux.js";
import { sendPing } from "../notifications.js";
import { watcherManager } from "./text.js";

interface TimerSetupFrequency {
  phase: "awaiting_frequency";
}

interface TimerSetupPrompt {
  phase: "awaiting_prompt";
  frequencyMin: number;
}

export type TimerSetup = TimerSetupFrequency | TimerSetupPrompt;

interface ActiveTimer {
  intervalId: ReturnType<typeof setInterval>;
  frequencyMin: number;
  prompt: string;
}

let timerSetup: TimerSetup | null = null;
let activeTimer: ActiveTimer | null = null;

export function getTimerSetup(): TimerSetup | null {
  return timerSetup;
}

export function setTimerSetup(setup: TimerSetup | null): void {
  timerSetup = setup;
}

export function isTimerActive(): boolean {
  return activeTimer !== null;
}

export function stopTimer(): { frequencyMin: number; prompt: string } | null {
  if (!activeTimer) return null;
  const { frequencyMin, prompt } = activeTimer;
  clearInterval(activeTimer.intervalId);
  activeTimer = null;
  return { frequencyMin, prompt };
}

async function getProjectName(cwd: string): Promise<string> {
  const sessions = await listSessions(20).catch(() => []);
  const match = sessions.find((s) => s.cwd === cwd);
  if (match) return match.projectName;
  return cwd.split("/").pop() || "unknown";
}

export function startTimer(frequencyMin: number, prompt: string): void {
  if (activeTimer) stopTimer();

  const intervalMs = frequencyMin * 60 * 1000;

  const tick = async () => {
    try {
      const attached = await getAttachedSession().catch(() => null);
      if (!attached) {
        log({ message: "timer tick: no attached session, skipping" });
        return;
      }
      const pane = await findClaudePane(attached.cwd).catch(() => ({
        found: false as const,
        reason: "no_tmux" as const,
      }));
      if (!pane.found) {
        log({ message: "timer tick: no Claude pane found, skipping" });
        return;
      }

      const repoName = await getProjectName(attached.cwd);

      // Notify Telegram that the timer prompt is being injected
      await sendPing(`\`Timer - ${repoName}:\` ${prompt}`);

      // Snapshot baseline BEFORE injection
      const preBaseline = await watcherManager.snapshotBaseline(attached.cwd);

      log({ message: `timer tick: injecting prompt` });
      await sendKeysToPane(pane.paneId, prompt);

      // Start watcher so the response triggers notifyResponse
      await watcherManager.startInjectionWatcher(
        attached,
        0, // chatId not needed — notifyResponse uses its own registered chatId
        undefined,
        undefined,
        preBaseline
      );
    } catch (err) {
      log({
        message: `timer tick error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const intervalId = setInterval(tick, intervalMs);
  activeTimer = { intervalId, frequencyMin, prompt };
}
