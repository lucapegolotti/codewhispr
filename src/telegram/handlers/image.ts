import { Context } from "grammy";
import { log } from "../../logger.js";
import { writeFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { processTextTurn } from "./text.js";

export async function handleImageMessage(
  ctx: Context,
  chatId: number,
  fileId: string,
  fileMimeType: string | undefined,
  caption: string,
  token: string
): Promise<void> {
  await ctx.replyWithChatAction("typing");

  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram did not return a file_path for this image");

  const ext = file.file_path.split(".").pop() ?? (fileMimeType?.split("/")[1] ?? "jpg");
  const imageDir = join(homedir(), ".codedove", "images");
  await mkdir(imageDir, { recursive: true });
  const imagePath = join(imageDir, `telegram-${Date.now()}.${ext}`);

  const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const resp = await fetch(fileUrl);
  if (!resp.ok) throw new Error(`Failed to download image: ${resp.status}`);
  await writeFile(imagePath, Buffer.from(await resp.arrayBuffer()));

  log({ chatId, direction: "in", message: `[image] saved to ${imagePath}` });

  const text = caption
    ? `${caption}\n\n[image: ${imagePath}]`
    : `[image: ${imagePath}]`;

  await processTextTurn(ctx, chatId, text);
}
