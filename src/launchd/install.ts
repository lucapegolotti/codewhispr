import { readFile, writeFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { join, dirname } from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execAsync = promisify(execFile);

export const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", "com.codewhispr.bot.plist");
export const SERVICE_LABEL = "com.codewhispr.bot";

function buildPlist(executablePath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${executablePath}</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${join(homedir(), ".codewhispr", "bot.log")}</string>
  <key>StandardErrorPath</key>
  <string>${join(homedir(), ".codewhispr", "bot.err")}</string>
</dict>
</plist>
`;
}

export async function isPlistInstalled(): Promise<boolean> {
  try {
    await readFile(PLIST_PATH, "utf8");
    return true;
  } catch {
    return false;
  }
}

export async function isServiceRunning(): Promise<boolean> {
  try {
    const { stdout } = await execAsync("launchctl", ["list", SERVICE_LABEL]);
    return stdout.includes('"PID"');
  } catch {
    return false;
  }
}

export async function installLaunchd(claudeVoicePath: string): Promise<void> {
  await mkdir(dirname(PLIST_PATH), { recursive: true });
  await writeFile(PLIST_PATH, buildPlist(claudeVoicePath), "utf8");
  await execAsync("launchctl", ["load", "-w", PLIST_PATH]).catch(() => {});
}
