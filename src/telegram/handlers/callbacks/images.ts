import { type Bot, type Context, InputFile } from "grammy";
import { log } from "../../../logger.js";
import type { DetectedImage } from "../../../session/monitor.js";

export const pendingImages = new Map<string, DetectedImage[]>();
// Set when the user clicked "Part" — next numeric message picks that many at random
export let pendingImageCount: { key: string; max: number } | null = null;
export function clearPendingImageCount(): void { pendingImageCount = null; }

export async function handleImagesCallback(ctx: Context, data: string, bot: Bot): Promise<void> {
  const parts = data.split(":");
  const action = parts[1];

  if (action === "skip") {
    const key = parts.slice(2).join(":");
    pendingImages.delete(key);
    await ctx.answerCallbackQuery({ text: "Skipped." });
    await ctx.editMessageReplyMarkup();
    return;
  }

  if (action === "part") {
    const key = parts.slice(2).join(":");
    const images = pendingImages.get(key);
    if (!images) {
      await ctx.answerCallbackQuery({ text: "Images no longer available." });
      return;
    }
    pendingImageCount = { key, max: images.length };
    await ctx.answerCallbackQuery();
    await ctx.reply(`How many images would you like? (1–${images.length})`);
    return;
  }

  if (action === "send") {
    const key = parts.slice(2).join(":");
    const images = pendingImages.get(key);
    if (!images) {
      await ctx.answerCallbackQuery({ text: "Images no longer available." });
      return;
    }
    pendingImages.delete(key);
    await ctx.answerCallbackQuery({ text: "Sending…" });
    await ctx.editMessageReplyMarkup();
    for (const img of images) {
      const buf = Buffer.from(img.data, "base64");
      const ext = img.mediaType.split("/")[1] ?? "jpg";
      const file = new InputFile(buf, `image.${ext}`);
      await bot.api.sendPhoto(ctx.chat!.id, file).catch(async () => {
        await bot.api.sendDocument(ctx.chat!.id, new InputFile(buf, `image.${ext}`)).catch((err) => {
          log({ message: `sendPhoto/sendDocument error: ${err instanceof Error ? err.message : String(err)}` });
        });
      });
    }
  }
}
