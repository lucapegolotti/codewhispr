import { Bot, InputFile } from "grammy";
import { runAgentTurn } from "./sessions.js";
import { transcribeAudio, synthesizeSpeech } from "./voice.js";

export function createBot(token: string): Bot {
  const bot = new Bot(token);

  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    const userText = ctx.message.text;
    await ctx.replyWithChatAction("typing");

    try {
      const reply = await runAgentTurn(chatId, userText);
      await ctx.reply(reply);
    } catch (err) {
      console.error("Agent error:", err);
      await ctx.reply("Something went wrong — try again?");
    }
  });

  bot.on("message:voice", async (ctx) => {
    const chatId = ctx.chat.id;
    await ctx.replyWithChatAction("record_voice");

    try {
      // Download voice note from Telegram
      const file = await ctx.getFile();
      if (!file.file_path) throw new Error("Telegram did not return a file_path for this voice note");
      const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const audioResponse = await fetch(fileUrl);
      if (!audioResponse.ok) throw new Error(`Failed to download voice note: ${audioResponse.status}`);
      const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());

      // Transcribe with Whisper
      const transcript = await transcribeAudio(audioBuffer, "voice.ogg");

      // Run agent
      const replyText = await runAgentTurn(chatId, transcript);

      // Synthesize and send voice reply
      const audioReply = await synthesizeSpeech(replyText);
      await ctx.replyWithVoice(new InputFile(audioReply, "reply.mp3"));
    } catch (err) {
      console.error("Voice error:", err);
      await ctx.reply("Couldn't process your voice message — try again?");
    }
  });

  return bot;
}
