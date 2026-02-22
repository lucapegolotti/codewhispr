import { InputFile } from "grammy";
import type { Context, Bot } from "grammy";
import { renderTableAsPng } from "./tableImage.js";
import { log } from "../logger.js";

// ---------------------------------------------------------------------------
// Table splitting
// ---------------------------------------------------------------------------

export type MessagePart =
  | { type: "text"; content: string }
  | { type: "table"; lines: string[] };

// Split text into alternating text/table parts at markdown table boundaries.
export function splitAtTables(text: string): MessagePart[] {
  const lines = text.split("\n");
  const parts: MessagePart[] = [];
  let textLines: string[] = [];
  let tableLines: string[] = [];

  for (const line of lines) {
    if (/^\s*\|/.test(line)) {
      if (textLines.length > 0) {
        parts.push({ type: "text", content: textLines.join("\n") });
        textLines = [];
      }
      tableLines.push(line);
    } else {
      if (tableLines.length > 0) {
        parts.push({ type: "table", lines: tableLines });
        tableLines = [];
      }
      textLines.push(line);
    }
  }
  if (tableLines.length > 0) parts.push({ type: "table", lines: tableLines });
  if (textLines.length > 0) parts.push({ type: "text", content: textLines.join("\n") });

  return parts;
}

// ---------------------------------------------------------------------------
// Inline text fallback for when image rendering fails
// ---------------------------------------------------------------------------

function escapeMd(s: string): string {
  return s.replace(/[_*`\[]/g, "\\$&");
}

function tableAsText(lines: string[]): string {
  const allRows = lines.map((line) =>
    line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim())
  );
  const isSeparator = (row: string[]) => row.every((c) => /^[-:\s]+$/.test(c));
  const contentRows = allRows.filter((row) => !isSeparator(row));
  if (contentRows.length === 0) return lines.join("\n");

  const fmtRow = (cells: string[], bold: boolean) =>
    cells.map((c) => (bold ? `*${escapeMd(c)}*` : escapeMd(c))).join(" | ");

  return [fmtRow(contentRows[0], true), ...contentRows.slice(1).map((r) => fmtRow(r, false))].join("\n");
}

// ---------------------------------------------------------------------------
// Message splitting
// ---------------------------------------------------------------------------

export function splitMessage(text: string, limit = 4000): string[] {
  if (!text) return [];
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt <= 0) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

// ---------------------------------------------------------------------------
// Send helpers
// ---------------------------------------------------------------------------

async function sendTextChunk(
  send: (text: string, markdown: boolean) => Promise<void>,
  text: string
): Promise<void> {
  if (!text.trim()) return;
  for (const chunk of splitMessage(text)) {
    try {
      await send(chunk, true);
    } catch {
      await send(chunk, false);
    }
  }
}

async function sendParts(
  sendText: (text: string, markdown: boolean) => Promise<void>,
  sendPhoto: (buf: Buffer) => Promise<void>,
  text: string
): Promise<void> {
  const parts = splitAtTables(text);
  for (const part of parts) {
    if (part.type === "text") {
      await sendTextChunk(sendText, part.content);
    } else {
      try {
        log({ message: `sendParts: rendering table (${part.lines.length} lines)` });
        const png = renderTableAsPng(part.lines);
        log({ message: `sendParts: sending photo (${png.length} bytes)` });
        await sendPhoto(png);
        log({ message: `sendParts: photo sent` });
      } catch (err) {
        log({ message: `sendParts: table render/send failed, falling back to text: ${err instanceof Error ? err.message : String(err)}` });
        await sendTextChunk(sendText, tableAsText(part.lines));
      }
    }
  }
}

export async function sendMarkdownReply(ctx: Context, text: string): Promise<void> {
  await sendParts(
    (chunk, md) =>
      md ? ctx.reply(chunk, { parse_mode: "Markdown" }) : ctx.reply(chunk),
    (buf) => ctx.replyWithPhoto(new InputFile(buf, "table.png")),
    text
  );
}

export async function sendMarkdownMessage(bot: Bot, chatId: number, text: string): Promise<void> {
  await sendParts(
    (chunk, md) =>
      md
        ? bot.api.sendMessage(chatId, chunk, { parse_mode: "Markdown" })
        : bot.api.sendMessage(chatId, chunk),
    (buf) => bot.api.sendPhoto(chatId, new InputFile(buf, "table.png")),
    text
  );
}
