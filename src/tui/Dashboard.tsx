import { Box, Text, useApp, useInput } from "ink";
import { useState, useEffect, useRef } from "react";
import { execFile } from "child_process";
import { homedir } from "os";
import { StatusBar } from "./StatusBar.js";
import { KeyBar } from "./KeyBar.js";
import { LogPane } from "./LogPane.js";
import { SessionPane } from "./SessionPane.js";
import { isHookInstalled, installHook, isPermissionHookInstalled, installPermissionHook, isCompactHooksInstalled, installCompactHooks } from "../hooks/install.js";

const PLIST_PATH = `${homedir()}/Library/LaunchAgents/com.codewhispr.bot.plist`;
const SERVICE_LABEL = "com.codewhispr.bot";

type Status = "running" | "stopped";
type HookStatus = "unknown" | "installed" | "missing" | "installing";

function launchctl(...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("launchctl", args, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

async function getServiceStatus(): Promise<Status> {
  try {
    const out = await launchctl("list", SERVICE_LABEL);
    return out.includes('"PID"') ? "running" : "stopped";
  } catch {
    return "stopped";
  }
}

type Props = { token: string };

export function Dashboard({ token: _token }: Props) {
  const { exit } = useApp();
  const [status, setStatus] = useState<Status>("stopped");
  const [hookStatus, setHookStatus] = useState<HookStatus>("unknown");
  const [permHookStatus, setPermHookStatus] = useState<HookStatus>("unknown");
  const [clearCount, setClearCount] = useState(0);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function startPolling() {
    if (pollingRef.current) clearInterval(pollingRef.current);
    pollingRef.current = setInterval(async () => {
      setStatus(await getServiceStatus());
    }, 2000);
  }

  useEffect(() => {
    getServiceStatus().then(setStatus);
    isHookInstalled().then((installed) => setHookStatus(installed ? "installed" : "missing"));
    isPermissionHookInstalled().then((installed) => setPermHookStatus(installed ? "installed" : "missing"));
    isCompactHooksInstalled().then((installed) => { if (!installed) installCompactHooks().catch(() => {}); });
    startPolling();
    return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
  }, []);

  useInput((input) => {
    if (input === "q") exit();
    if (input === "s" && status === "stopped") {
      launchctl("load", PLIST_PATH).then(() => getServiceStatus().then(setStatus)).catch(() => {});
    }
    if (input === "x" && status === "running") {
      launchctl("unload", PLIST_PATH).then(() => setStatus("stopped")).catch(() => {});
    }
    if (input === "r") {
      const uid = process.getuid ? process.getuid() : 501;
      launchctl("kickstart", "-k", `gui/${uid}/${SERVICE_LABEL}`)
        .then(() => getServiceStatus().then(setStatus))
        .catch(() => {});
    }
    if (input === "c") setClearCount((n) => n + 1);
    if (input === "i" && (hookStatus === "missing" || permHookStatus === "missing")) {
      if (hookStatus === "missing") {
        setHookStatus("installing");
        installHook().then(() => setHookStatus("installed")).catch(() => setHookStatus("missing"));
      }
      if (permHookStatus === "missing") {
        setPermHookStatus("installing");
        installPermissionHook().then(() => setPermHookStatus("installed")).catch(() => setPermHookStatus("missing"));
      }
    }
  });

  const hooksMissing = hookStatus === "missing" || permHookStatus === "missing";
  const hooksInstalling = hookStatus === "installing" || permHookStatus === "installing";
  const hooksInstalled = hookStatus === "installed" && permHookStatus === "installed";

  return (
    <Box flexDirection="column" height="100%">
      <StatusBar status={status} />
      {hooksInstalling && (
        <Box paddingX={1}>
          <Text color="yellow">Installing hooks…</Text>
        </Box>
      )}
      {hooksMissing && !hooksInstalling && (
        <Box paddingX={1} backgroundColor="yellow">
          <Text color="black">
            {`⚠ Missing: ${[hookStatus === "missing" ? "stop" : "", permHookStatus === "missing" ? "permission" : ""].filter(Boolean).join(", ")} hook${hookStatus === "missing" && permHookStatus === "missing" ? "s" : ""} — [i] install`}
          </Text>
        </Box>
      )}
      {hooksInstalled && (
        <Box paddingX={1}>
          <Text color="green">✓ All hooks installed</Text>
        </Box>
      )}
      <Box flexGrow={1} borderStyle="single">
        <LogPane clearCount={clearCount} />
        <Box borderStyle="single" width={24}>
          <SessionPane />
        </Box>
      </Box>
      <KeyBar status={status} hookStatus={hooksMissing ? "missing" : hooksInstalled ? "installed" : "unknown"} />
    </Box>
  );
}
