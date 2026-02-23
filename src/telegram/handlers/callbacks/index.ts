import type { Bot } from "grammy";
import { handleWaitingCallback } from "./waiting.js";
import { handlePermissionCallback } from "./permissions.js";
import { handleSessionCallback } from "./sessions.js";
import { handleLaunchCallback } from "./launch.js";
import { handleImagesCallback } from "./images.js";
import { handleModelCallback } from "./model.js";
import { handleDetachCallback } from "./detach.js";
import { handleTimerCallback } from "./timer.js";

// Re-export image state used by text.ts
export { pendingImages, pendingImageCount, clearPendingImageCount } from "./images.js";

export function registerCallbacks(bot: Bot): void {
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    if (data.startsWith("waiting:")) {
      await handleWaitingCallback(ctx, data);
      return;
    }

    if (data.startsWith("perm:")) {
      await handlePermissionCallback(ctx, data);
      return;
    }

    if (data.startsWith("session:")) {
      await handleSessionCallback(ctx, data);
      return;
    }

    if (data.startsWith("launch:")) {
      await handleLaunchCallback(ctx, data, bot);
      return;
    }

    if (data.startsWith("images:")) {
      await handleImagesCallback(ctx, data, bot);
      return;
    }

    if (data.startsWith("model:")) {
      await handleModelCallback(ctx, data);
      return;
    }

    if (data.startsWith("detach:")) {
      await handleDetachCallback(ctx, data);
      return;
    }

    if (data.startsWith("timer:")) {
      await handleTimerCallback(ctx, data);
      return;
    }
  });
}
