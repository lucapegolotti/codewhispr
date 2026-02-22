import { Bot } from "grammy";
import { applyAllowlistMiddleware } from "./middleware.js";
import { sendMarkdownReply } from "./utils.js";
import { processTextTurn } from "./handlers/text.js";
import { handleVoice } from "./handlers/voice.js";
import { handleImageMessage } from "./handlers/image.js";
import { registerCommands } from "./handlers/commands.js";
import { registerCallbacks } from "./handlers/callbacks/index.js";
import { registerForNotifications } from "./notifications.js";
import { log } from "../logger.js";


export function createBot(token: string, allowedChatId?: number): Bot {
  const bot = new Bot(token);
  applyAllowlistMiddleware(bot, allowedChatId);

  bot.on("message:text", async (ctx, next) => {
    // Pass slash commands through to their bot.command() handlers.
    // Without this, returning here would stop the grammY middleware chain.
    if (ctx.message.text.startsWith("/")) return next();

    const chatId = ctx.chat.id;
    await ctx.replyWithChatAction("typing");
    log({ chatId, direction: "in", message: ctx.message.text });
    registerForNotifications(bot, chatId);

    try {
      await processTextTurn(ctx, chatId, ctx.message.text);
    } catch (err) {
      log({ chatId, message: `Error: ${err instanceof Error ? err.message : String(err)}` });
      await ctx.reply("Something went wrong — try again?");
    }
  });

  bot.on("message:voice", async (ctx) => {
    registerForNotifications(bot, ctx.chat.id);
    await handleVoice(ctx, ctx.chat.id, token).catch(async (err) => {
      log({ chatId: ctx.chat.id, message: `Voice error: ${err instanceof Error ? err.message : String(err)}` });
      await ctx.reply("Couldn't process your voice message — try again?");
    });
  });

  bot.on("message:photo", async (ctx) => {
    const chatId = ctx.chat.id;
    registerForNotifications(bot, chatId);
    try {
      const largest = ctx.message.photo[ctx.message.photo.length - 1];
      await handleImageMessage(ctx, chatId, largest.file_id, "image/jpeg", ctx.message.caption ?? "", token);
    } catch (err) {
      log({ chatId, message: `Image error: ${err instanceof Error ? err.message : String(err)}` });
      await ctx.reply("Couldn't process the image — try again?");
    }
  });

  bot.on("message:document", async (ctx) => {
    const chatId = ctx.chat.id;
    const mime = ctx.message.document.mime_type ?? "";
    if (!mime.startsWith("image/")) return;
    registerForNotifications(bot, chatId);
    try {
      await handleImageMessage(ctx, chatId, ctx.message.document.file_id, mime, ctx.message.caption ?? "", token);
    } catch (err) {
      log({ chatId, message: `Image error: ${err instanceof Error ? err.message : String(err)}` });
      await ctx.reply("Couldn't process the image — try again?");
    }
  });

  registerCommands(bot);
  registerCallbacks(bot);
  return bot;
}
