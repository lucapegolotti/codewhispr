import * as p from "@clack/prompts";
import { readFile, writeFile } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { saveConfig } from "../config/config.js";
import {
  isHookInstalled, installHook,
  isPermissionHookInstalled, installPermissionHook,
  isCompactHooksInstalled, installCompactHooks,
} from "../hooks/install.js";
import { installService, SERVICE_FILE_PATH } from "../service/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CODEDOVE_BIN = resolve(__dirname, "..", "..", "bin", "codedove-bot");

const isMac = process.platform === "darwin";
const serviceLabel = isMac ? "macOS launch agent" : "systemd user service";

function bail(): never {
  p.cancel("Setup cancelled.");
  process.exit(0);
}

export function escapeEnvValue(val: string): string {
  return val.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$");
}

const BLUE = "\x1b[38;2;150;200;227m";
const RESET = "\x1b[0m";

const LOGO = `
 ${BLUE}██████╗ ██████╗ ██████╗ ███████╗██████╗  ██████╗ ██╗   ██╗███████╗${RESET}
 ${BLUE}██╔════╝██╔═══██╗██╔══██╗██╔════╝██╔══██╗██╔═══██╗██║   ██║██╔════╝${RESET}
 ${BLUE}██║     ██║   ██║██║  ██║█████╗  ██║  ██║██║   ██║██║   ██║█████╗${RESET}
 ${BLUE}██║     ██║   ██║██║  ██║██╔══╝  ██║  ██║██║   ██║╚██╗ ██╔╝██╔══╝${RESET}
 ${BLUE}╚██████╗╚██████╔╝██████╔╝███████╗██████╔╝╚██████╔╝ ╚████╔╝ ███████╗${RESET}
 ${BLUE} ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚═════╝  ╚═════╝   ╚═══╝  ╚══════╝${RESET}
`;

export async function runSetup(envPath: string, dryRun: boolean): Promise<void> {
  console.log(LOGO);
  p.intro(`codedove setup${dryRun ? " (dry run)" : ""}`);

  p.note(
    dryRun
      ? "Dry run — nothing will be written to disk."
      : "Credentials are saved to .env in the install directory.",
  );

  // --- Telegram bot token ---
  const botToken = await p.password({
    message: "Telegram bot token",
    validate: (v) => {
      if (!dryRun && !v) return "Bot token is required. Get one from @BotFather → /newbot";
    },
  });
  if (p.isCancel(botToken)) bail();

  if (!dryRun) {
    const escaped = escapeEnvValue(botToken);
    await writeFile(envPath, `TELEGRAM_BOT_TOKEN="${escaped}"\n`, "utf8");
  }

  // --- Optional API keys ---
  const anthropicKey = await p.password({
    message: "Anthropic API key (Enter to skip)",
  });
  if (p.isCancel(anthropicKey)) bail();

  const openaiKey = await p.password({
    message: "OpenAI API key (Enter to skip)",
  });
  if (p.isCancel(openaiKey)) bail();

  // --- Chat ID ---
  const chatId = await p.text({
    message: "Your Telegram chat ID",
    placeholder: "Message @userinfobot to find your ID",
    validate: (v) => {
      if (!dryRun && (!v || !Number.isFinite(parseInt(v, 10)))) {
        return "Must be a valid integer.";
      }
    },
  });
  if (p.isCancel(chatId)) bail();

  // --- Write config ---
  if (!dryRun) {
    const envLines: string[] = [];
    if (anthropicKey) envLines.push(`ANTHROPIC_API_KEY="${escapeEnvValue(anthropicKey)}"`);
    if (openaiKey) envLines.push(`OPENAI_API_KEY="${escapeEnvValue(openaiKey)}"`);
    if (envLines.length > 0) {
      const existing = await readFile(envPath, "utf8");
      await writeFile(envPath, existing + envLines.join("\n") + "\n", "utf8");
    }
    await saveConfig({ allowedChatId: parseInt(chatId, 10) });
  }

  // --- Hooks ---
  const s = p.spinner();

  s.start("Checking Claude Code hooks");
  let stopOk: boolean, permOk: boolean, compactOk: boolean;
  if (dryRun) {
    stopOk = false; permOk = false; compactOk = false;
  } else {
    [stopOk, permOk, compactOk] = await Promise.all([
      isHookInstalled(),
      isPermissionHookInstalled(),
      isCompactHooksInstalled(),
    ]);
  }
  s.stop("Hooks checked");

  const allHooksInstalled = stopOk && permOk && compactOk;

  if (allHooksInstalled) {
    p.log.success("All Claude Code hooks are already installed.");
  } else {
    const installHooks = await p.confirm({
      message: "Install missing Claude Code hooks?",
    });
    if (p.isCancel(installHooks)) bail();

    if (installHooks) {
      s.start("Installing hooks");
      if (dryRun) {
        await new Promise((r) => setTimeout(r, 300));
      } else {
        if (!stopOk) await installHook().catch(() => {});
        if (!permOk) await installPermissionHook().catch(() => {});
        if (!compactOk) await installCompactHooks().catch(() => {});
      }
      s.stop("Hooks installed");
    }
  }

  // --- Launchd / systemd ---
  const registerService = await p.confirm({
    message: `Register as ${serviceLabel}?`,
  });
  if (p.isCancel(registerService)) bail();

  if (registerService) {
    s.start(`Registering ${serviceLabel}`);
    if (dryRun) {
      await new Promise((r) => setTimeout(r, 300));
    } else {
      await installService(CODEDOVE_BIN).catch(() => {});
    }
    s.stop(`${serviceLabel} registered`);
    p.log.info(`Service file: ${SERVICE_FILE_PATH}`);
  }

  p.outro("Setup complete!");
}
