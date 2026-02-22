import { createCanvas, GlobalFonts } from "@napi-rs/canvas";

// Load system fonts once at module init.
GlobalFonts.loadSystemFonts();

// ---------------------------------------------------------------------------
// Emoji preprocessing
//
// No color emoji fonts are available on this server (only DejaVu / Liberation).
// We replace the most common indicator emoji with DejaVu-supported characters
// and strip any remaining emoji so they don't render as boxes.
// ---------------------------------------------------------------------------

const EMOJI_REPLACEMENTS: [RegExp, string][] = [
  [/✅/g, "✓"],  // U+2713 CHECK MARK
  [/❌/g, "✗"],  // U+2717 BALLOT X
  [/⚠️?/g, "⚠"], // U+26A0 WARNING SIGN
  [/🔴/g, "●"],
  [/🟢/g, "●"],
  [/🟡/g, "○"],
  [/📁/g, "▸"],
  [/📄/g, "▸"],
  [/🔧/g, "#"],
  [/🔐/g, "*"],
  [/⏳/g, "..."],
  [/✔️?/g, "✓"],
  [/❎/g, "✗"],
];

// Strip remaining high-plane emoji that weren't covered by the replacement map.
// We deliberately do NOT strip the U+2600–U+27BF "Miscellaneous Symbols" block
// because our own replacements (✓ U+2713, ✗ U+2717, ⚠ U+26A0, ● U+25CF) live
// nearby and DejaVu Sans renders them correctly.
const EMOJI_STRIP_RE = /[\u{1F300}-\u{1FAFF}]|\u{FE0F}/gu;

export function preprocessCell(text: string): string {
  let out = text;
  for (const [re, rep] of EMOJI_REPLACEMENTS) out = out.replace(re, rep);
  return out.replace(EMOJI_STRIP_RE, "").trim();
}

// ---------------------------------------------------------------------------
// Table parsing
// ---------------------------------------------------------------------------

export interface TableData {
  headers: string[];
  rows: string[][];
}

export function parseTableLines(lines: string[]): TableData {
  const allRows = lines.map((line) =>
    line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim())
  );
  const isSeparator = (row: string[]) => row.every((c) => /^[-:\s]+$/.test(c));
  const contentRows = allRows.filter((row) => !isSeparator(row));
  return {
    headers: contentRows[0] ?? [],
    rows: contentRows.slice(1),
  };
}

// ---------------------------------------------------------------------------
// Canvas rendering
// ---------------------------------------------------------------------------

const FONT_FACE = "DejaVu Sans";
const FONT_SIZE = 15;          // px
const PAD_H = 16;              // horizontal cell padding (each side)
const PAD_V = 11;              // vertical cell padding (each side)
const ROW_HEIGHT = FONT_SIZE + PAD_V * 2;
const HEADER_EXTRA = 2;        // extra height for header row
const HEADER_HEIGHT = ROW_HEIGHT + HEADER_EXTRA;
const MIN_COL_W = 50;
const OUTER_BORDER = 1;

// Color palette — light theme that reads well over Telegram's backgrounds
const COL_HEADER_BG = "#1e293b";   // slate-800
const COL_HEADER_TEXT = "#f8fafc"; // slate-50
const COL_ROW_EVEN = "#ffffff";
const COL_ROW_ODD = "#f1f5f9";     // slate-100
const COL_GRID = "#cbd5e1";        // slate-300
const COL_BORDER = "#94a3b8";      // slate-400
const COL_DATA_TEXT = "#1e293b";   // slate-800

export function renderTableAsPng(lines: string[]): Buffer {
  const { headers, rows } = parseTableLines(lines);
  const colCount = Math.max(headers.length, ...rows.map((r) => r.length), 1);

  // --- Measure text to compute exact column widths ---
  const probe = createCanvas(1, 1).getContext("2d");

  probe.font = `bold ${FONT_SIZE}px "${FONT_FACE}"`;
  const headerWidths = Array.from({ length: colCount }, (_, i) =>
    probe.measureText(preprocessCell(headers[i] ?? "")).width
  );

  probe.font = `${FONT_SIZE}px "${FONT_FACE}"`;
  const dataWidths = Array.from({ length: colCount }, (_, i) =>
    rows.length > 0
      ? Math.max(...rows.map((r) => probe.measureText(preprocessCell(r[i] ?? "")).width))
      : 0
  );

  const colWidths = Array.from({ length: colCount }, (_, i) =>
    Math.max(headerWidths[i], dataWidths[i], MIN_COL_W) + PAD_H * 2
  );

  const totalWidth = colWidths.reduce((a, b) => a + b, 0) + OUTER_BORDER * 2;
  const totalHeight =
    HEADER_HEIGHT + rows.length * ROW_HEIGHT + OUTER_BORDER * 2;

  // --- Draw ---
  const canvas = createCanvas(totalWidth, totalHeight);
  const ctx = canvas.getContext("2d");

  const ox = OUTER_BORDER;
  const oy = OUTER_BORDER;
  const tableW = totalWidth - OUTER_BORDER * 2;
  const tableH = totalHeight - OUTER_BORDER * 2;

  // Outer border
  ctx.strokeStyle = COL_BORDER;
  ctx.lineWidth = OUTER_BORDER;
  ctx.strokeRect(ox - 0.5, oy - 0.5, tableW + 1, tableH + 1);

  // Header background
  ctx.fillStyle = COL_HEADER_BG;
  ctx.fillRect(ox, oy, tableW, HEADER_HEIGHT);

  // Row backgrounds
  for (let i = 0; i < rows.length; i++) {
    ctx.fillStyle = i % 2 === 0 ? COL_ROW_EVEN : COL_ROW_ODD;
    ctx.fillRect(ox, oy + HEADER_HEIGHT + i * ROW_HEIGHT, tableW, ROW_HEIGHT);
  }

  // Horizontal dividers
  ctx.strokeStyle = COL_GRID;
  ctx.lineWidth = 1;
  for (let i = 0; i <= rows.length; i++) {
    const lineY = oy + HEADER_HEIGHT + i * ROW_HEIGHT;
    ctx.beginPath();
    ctx.moveTo(ox, lineY);
    ctx.lineTo(ox + tableW, lineY);
    ctx.stroke();
  }

  // Vertical dividers
  let cx = ox;
  for (let i = 0; i < colCount - 1; i++) {
    cx += colWidths[i];
    ctx.beginPath();
    ctx.moveTo(cx, oy);
    ctx.lineTo(cx, oy + tableH);
    ctx.stroke();
  }

  // Header text
  ctx.fillStyle = COL_HEADER_TEXT;
  ctx.font = `bold ${FONT_SIZE}px "${FONT_FACE}"`;
  ctx.textBaseline = "middle";
  cx = ox;
  for (let i = 0; i < colCount; i++) {
    const text = preprocessCell(headers[i] ?? "");
    ctx.fillText(text, cx + PAD_H, oy + HEADER_HEIGHT / 2 + HEADER_EXTRA / 2);
    cx += colWidths[i];
  }

  // Data text
  ctx.fillStyle = COL_DATA_TEXT;
  ctx.font = `${FONT_SIZE}px "${FONT_FACE}"`;
  for (let row = 0; row < rows.length; row++) {
    cx = ox;
    for (let col = 0; col < colCount; col++) {
      const text = preprocessCell(rows[row][col] ?? "");
      const ty = oy + HEADER_HEIGHT + row * ROW_HEIGHT + ROW_HEIGHT / 2;
      ctx.fillText(text, cx + PAD_H, ty);
      cx += colWidths[col];
    }
  }

  return canvas.toBuffer("image/png");
}
