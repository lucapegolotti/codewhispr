import { readFile, writeFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { join, dirname } from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execAsync = promisify(execFile);
const isMac = process.platform === "darwin";

// macOS
const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", "com.codedove.bot.plist");
const SERVICE_LABEL = "com.codedove.bot";

// Linux
const SERVICE_UNIT = "codedove.service";
const SYSTEMD_PATH = join(homedir(), ".config", "systemd", "user", SERVICE_UNIT);

export const SERVICE_FILE_PATH = isMac ? PLIST_PATH : SYSTEMD_PATH;

export type ServiceStatus = "running" | "stopped";

export async function getServiceStatus(): Promise<ServiceStatus> {
  if (isMac) {
    try {
      const { stdout } = await execAsync("launchctl", ["list", SERVICE_LABEL]);
      return stdout.includes('"PID"') ? "running" : "stopped";
    } catch {
      return "stopped";
    }
  } else {
    try {
      const { stdout } = await execAsync("systemctl", ["--user", "is-active", SERVICE_UNIT]);
      return stdout.trim() === "active" ? "running" : "stopped";
    } catch {
      return "stopped";
    }
  }
}

export async function startService(): Promise<void> {
  if (isMac) {
    const uid = process.getuid ? process.getuid() : 501;
    // bootstrap re-registers the service (needed after bootout)
    await execAsync("launchctl", ["bootstrap", `gui/${uid}`, PLIST_PATH]);
  } else {
    await execAsync("systemctl", ["--user", "start", SERVICE_UNIT]);
  }
}

export async function stopService(): Promise<void> {
  if (isMac) {
    const uid = process.getuid ? process.getuid() : 501;
    // bootout fully unregisters the service so KeepAlive doesn't respawn it
    await execAsync("launchctl", ["bootout", `gui/${uid}/${SERVICE_LABEL}`]);
  } else {
    await execAsync("systemctl", ["--user", "stop", SERVICE_UNIT]);
  }
}

export async function restartService(): Promise<void> {
  if (isMac) {
    const uid = process.getuid ? process.getuid() : 501;
    await execAsync("launchctl", ["kickstart", "-k", `gui/${uid}/${SERVICE_LABEL}`]);
  } else {
    await execAsync("systemctl", ["--user", "restart", SERVICE_UNIT]);
  }
}

function buildPlist(executablePath: string): string {
  // Capture the current PATH so launchd can find node/tsx
  const currentPath = process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin";
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
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${currentPath}</string>
  </dict>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${join(homedir(), ".codedove", "bot.log")}</string>
  <key>StandardErrorPath</key>
  <string>${join(homedir(), ".codedove", "bot.err")}</string>
</dict>
</plist>
`;
}

function buildSystemdUnit(executablePath: string): string {
  return `[Unit]
Description=codedove Telegram bot

[Service]
ExecStart=${executablePath}
Restart=always
StandardOutput=append:${join(homedir(), ".codedove", "bot.log")}
StandardError=append:${join(homedir(), ".codedove", "bot.err")}

[Install]
WantedBy=default.target
`;
}

export async function installService(executablePath: string): Promise<void> {
  if (isMac) {
    const uid = process.getuid ? process.getuid() : 501;
    await mkdir(dirname(PLIST_PATH), { recursive: true });
    await writeFile(PLIST_PATH, buildPlist(executablePath), "utf8");
    await execAsync("launchctl", ["bootstrap", `gui/${uid}`, PLIST_PATH]).catch(() => {});
  } else {
    await mkdir(dirname(SYSTEMD_PATH), { recursive: true });
    await writeFile(SYSTEMD_PATH, buildSystemdUnit(executablePath), "utf8");
    await execAsync("systemctl", ["--user", "daemon-reload"]).catch(() => {});
    await execAsync("systemctl", ["--user", "enable", SERVICE_UNIT]).catch(() => {});
    await execAsync("systemctl", ["--user", "start", SERVICE_UNIT]).catch(() => {});
  }
}

export async function isServiceInstalled(): Promise<boolean> {
  try {
    await readFile(SERVICE_FILE_PATH, "utf8");
    return true;
  } catch {
    return false;
  }
}
