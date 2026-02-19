#!/usr/bin/env tsx
import { render } from "ink";
import { useState } from "react";
import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { Setup } from "./tui/Setup.js";
import { Dashboard } from "./tui/Dashboard.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, "..", ".env");

const REQUIRED = ["TELEGRAM_BOT_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;

function loadEnv(): Record<string, string> {
  if (!existsSync(ENV_PATH)) return {};
  return Object.fromEntries(
    readFileSync(ENV_PATH, "utf8")
      .split("\n")
      .filter(l => l.includes("="))
      .map(l => {
        const idx = l.indexOf("=");
        let val = l.slice(idx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1).replace(/\\"/g, '"').replace(/\\\$/g, "$").replace(/\\\\/g, "\\");
        }
        return [l.slice(0, idx).trim(), val];
      })
  );
}

function App() {
  const [setupDone, setSetupDone] = useState(false);

  const env = loadEnv();
  const needsSetup = !setupDone && REQUIRED.some(k => !env[k]);

  if (needsSetup) {
    return <Setup envPath={ENV_PATH} onComplete={() => setSetupDone(true)} />;
  }

  const freshEnv = loadEnv();
  for (const k of REQUIRED) {
    if (freshEnv[k]) process.env[k] = freshEnv[k];
  }

  return <Dashboard token={freshEnv.TELEGRAM_BOT_TOKEN!} />;
}

render(<App />);
