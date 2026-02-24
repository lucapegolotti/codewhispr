#!/usr/bin/env tsx
import { render } from "ink";
import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { Dashboard } from "./tui/Dashboard.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, "..", ".env");

const mockSetup = process.argv.includes("--mock-setup");

const REQUIRED = ["TELEGRAM_BOT_TOKEN"] as const;

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

const env = loadEnv();
const needsSetup = mockSetup || REQUIRED.some(k => !env[k]);

if (needsSetup) {
  const { runSetup } = await import("./tui/setup.js");
  await runSetup(ENV_PATH, mockSetup);
}

const freshEnv = loadEnv();
const ALL_KEYS = ["TELEGRAM_BOT_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;
for (const k of ALL_KEYS) {
  if (freshEnv[k]) process.env[k] = freshEnv[k];
}

render(<Dashboard token={freshEnv.TELEGRAM_BOT_TOKEN!} />);
