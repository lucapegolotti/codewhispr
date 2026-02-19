import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export type TmuxPane = {
  paneId: string;
  command: string;
  cwd: string;
  lastUsed: number; // unix timestamp from #{pane_last_used}
};

export type TmuxResult =
  | { found: true; paneId: string }
  | { found: false; reason: "no_tmux" | "no_claude_pane" | "ambiguous"; panes?: TmuxPane[] };

// Claude Code sets process.title to its version string (e.g. "2.1.47"), not "claude"
function isClaudePane(p: TmuxPane): boolean {
  return p.command.includes("claude") || /^\d+\.\d+\.\d+/.test(p.command);
}

function mostRecent(panes: TmuxPane[]): TmuxPane {
  return panes.reduce((a, b) => (b.lastUsed > a.lastUsed ? b : a));
}

export function findBestPane(panes: TmuxPane[], targetCwd: string): TmuxPane | null {
  const claudePanes = panes.filter(isClaudePane);
  if (claudePanes.length === 0) return null;

  // Exact match — if multiple, pick the most recently used
  const exact = claudePanes.filter((p) => p.cwd === targetCwd);
  if (exact.length >= 1) return mostRecent(exact);

  // Parent directory match — if multiple, pick the most recently used
  const parents = claudePanes.filter((p) => targetCwd.startsWith(p.cwd + "/"));
  if (parents.length >= 1) return mostRecent(parents);

  return null;
}

export async function listTmuxPanes(): Promise<TmuxPane[]> {
  try {
    const { stdout } = await execAsync(
      "tmux list-panes -a -F '#{pane_id} #{pane_last_used} #{pane_current_command} #{pane_current_path}'"
    );
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(" ");
        const paneId = parts[0];
        const lastUsed = parseInt(parts[1], 10) || 0;
        const command = parts[2];
        const cwd = parts.slice(3).join(" "); // handle spaces in paths
        return { paneId, lastUsed, command, cwd };
      });
  } catch {
    return [];
  }
}

export async function findClaudePane(targetCwd: string): Promise<TmuxResult> {
  let panes: TmuxPane[];
  try {
    panes = await listTmuxPanes();
  } catch {
    return { found: false, reason: "no_tmux" };
  }

  if (panes.length === 0) return { found: false, reason: "no_tmux" };

  const best = findBestPane(panes, targetCwd);
  if (best) return { found: true, paneId: best.paneId };

  const claudePanes = panes.filter(isClaudePane);
  if (claudePanes.length === 0) return { found: false, reason: "no_claude_pane" };
  if (claudePanes.length > 1) return { found: false, reason: "ambiguous", panes: claudePanes };

  // One claude pane exists but cwd doesn't match — use it anyway
  return { found: true, paneId: claudePanes[0].paneId };
}

export async function sendKeysToPane(paneId: string, input: string): Promise<void> {
  // Escape single quotes in input for shell safety
  const safe = input.replace(/'/g, "'\\''");
  await execAsync(`tmux send-keys -t '${paneId}' '${safe}' Enter`);
}

export async function injectInput(targetCwd: string, input: string): Promise<TmuxResult> {
  const result = await findClaudePane(targetCwd);
  if (result.found) {
    await sendKeysToPane(result.paneId, input);
  }
  return result;
}
