import { Box, Text, useApp, useInput } from "ink";
import { useState, useEffect, useRef } from "react";
import { StatusBar } from "./StatusBar.js";
import { KeyBar } from "./KeyBar.js";
import { LogPane } from "./LogPane.js";
import { SessionPane } from "./SessionPane.js";
import { isHookInstalled, installHook, isPermissionHookInstalled, installPermissionHook, isCompactHooksInstalled, installCompactHooks } from "../hooks/install.js";
import { getServiceStatus, startService, stopService, restartService, isServiceInstalled } from "../service/index.js";

type Status = "running" | "stopped" | "not_installed";
type HookStatus = "unknown" | "installed" | "missing" | "installing";

type Props = { token: string };

export function Dashboard({ token: _token }: Props) {
  const { exit } = useApp();
  const [status, setStatus] = useState<Status>("stopped");
  const [hookStatus, setHookStatus] = useState<HookStatus>("unknown");
  const [permHookStatus, setPermHookStatus] = useState<HookStatus>("unknown");
  const [clearCount, setClearCount] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const flashRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showFlash(msg: string) {
    setFlash(msg);
    if (flashRef.current) clearTimeout(flashRef.current);
    flashRef.current = setTimeout(() => setFlash(null), 2000);
  }

  async function refreshStatus() {
    if (!(await isServiceInstalled())) {
      setStatus("not_installed");
    } else {
      setStatus(await getServiceStatus());
    }
  }

  function startPolling() {
    if (pollingRef.current) clearInterval(pollingRef.current);
    pollingRef.current = setInterval(refreshStatus, 2000);
  }

  useEffect(() => {
    refreshStatus();
    isHookInstalled().then((installed) => setHookStatus(installed ? "installed" : "missing"));
    isPermissionHookInstalled().then((installed) => setPermHookStatus(installed ? "installed" : "missing"));
    isCompactHooksInstalled().then((installed) => { if (!installed) installCompactHooks().catch(() => {}); });
    startPolling();
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
      if (flashRef.current) clearTimeout(flashRef.current);
    };
  }, []);

  useInput((input) => {
    if (input === "q") exit();
    if (input === "s" && status === "stopped") {
      showFlash("Starting service…");
      startService()
        .then(() => showFlash("Service started"))
        .catch((e) => showFlash(`Failed to start: ${e instanceof Error ? e.message : String(e)}`))
        .finally(refreshStatus);
    }
    if (input === "x" && status === "running") {
      showFlash("Stopping service…");
      stopService()
        .then(() => showFlash("Service stopped"))
        .catch((e) => showFlash(`Failed to stop: ${e instanceof Error ? e.message : String(e)}`))
        .finally(refreshStatus);
    }
    if (input === "r" && status !== "not_installed") {
      showFlash("Restarting service…");
      restartService()
        .then(() => showFlash("Service restarted"))
        .catch((e) => showFlash(`Failed to restart: ${e instanceof Error ? e.message : String(e)}`))
        .finally(refreshStatus);
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
      <StatusBar status={status === "not_installed" ? "stopped" : status} />
      {flash && (
        <Box paddingX={1}>
          <Text color="yellow">{flash}</Text>
        </Box>
      )}
      {status === "not_installed" && !flash && (
        <Box paddingX={1} backgroundColor="yellow">
          <Text color="black">Service not installed — run codedove --mock-setup or codedove (without .env) to set up</Text>
        </Box>
      )}
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
