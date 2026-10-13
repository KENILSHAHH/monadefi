/**
 * A small, safe Markdown parser for the agent replies. Pure, so the tests can pin it.
 * It never returns raw markdown symbols: unknown or unclosed markers (for example a "**" that is still
 * streaming) are removed from the text. It never renders HTML.
 *
 * Blocks: paragraphs, headings (shown as bold body text), bullet and numbered lists, short tables,
 * code blocks, quotes and rules. Inline: **bold**, *italic*, `code`, [links](https://…) and bare URLs.
 */

export type Inline =
  | { t: "text"; text: string; bold?: boolean; italic?: boolean }
  | { t: "code"; text: string }
  | { t: "link"; text: string; url: string; bold?: boolean; italic?: boolean };

export type Block =
  | { t: "p"; inline: Inline[] }
  | { t: "h"; inline: Inline[] }
  | { t: "li"; ordered: boolean; n: number; depth: number; inline: Inline[] }
  | { t: "table"; header: Inline[][]; rows: Inline[][][] }
  | { t: "code"; text: string }
  | { t: "quote"; inline: Inline[] }
  | { t: "hr" };

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

/** Remove the markers that are left over: unclosed **, __, ~~, `, and * or _ at a word edge. */
export function stripStray(s: string): string {
  return s
    .replace(/\*\*|__|~~|`+/g, "")
    .replace(/(^|\s)[*_]+(?=\S)/g, "$1")
    .replace(/(\S)[*_]+(?=\s|$|[.,;:!?)])/g, "$1")
    .replace(/\s\*+\s*$/, "");
}

type Style = { bold?: boolean; italic?: boolean };

/** Parse inline markdown. Unclosed markers are text with the marker removed. */
export function parseInline(src: string, style: Style = {}): Inline[] {
  const out: Inline[] = [];
  const pushText = (text: string) => {
    const clean = stripStray(text);
    if (!clean) return;
    const last = out[out.length - 1];
    if (last && last.t === "text" && last.bold === style.bold && last.italic === style.italic) last.text += clean;
    else out.push({ t: "text", text: clean, ...style });
  };

  let i = 0;
  let buf = "";
  const flush = () => {
    if (buf) pushText(buf);
    buf = "";
  };

  while (i < src.length) {
    const rest = src.slice(i);
    let m: RegExpExecArray | null;

    if (rest[0] === "\\" && rest.length > 1 && /[\\`*_[\]()#+\-.!|~]/.test(rest[1]!)) {
      // An escaped symbol is plain text, never a marker.
      flush();
      const last = out[out.length - 1];
      if (last && last.t === "text" && last.bold === style.bold && last.italic === style.italic) last.text += rest[1]!;
      else out.push({ t: "text", text: rest[1]!, ...style });
      i += 2;
      continue;
    }
    if ((m = /^`([^`\n]+)`/.exec(rest))) {
      flush();
      out.push({ t: "code", text: m[1]! });
      i += m[0].length;
      continue;
    }
    if ((m = /^\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest))) {
      flush();
      const url = m[2]!;
      const label = parseInline(m[1]!, style).map((x) => x.text).join("");
      if (SAFE_URL.test(url)) out.push({ t: "link", text: label || url, url, ...style });
      else pushText(label);
      i += m[0].length;
      continue;
    }
    if ((m = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/.exec(rest)) && !/[\w/]$/.test(buf)) {
      flush();
      out.push({ t: "link", text: m[0], url: m[0], ...style });
      i += m[0].length;
      continue;
    }
    if ((m = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest))) {
      flush();
      out.push(...parseInline(m[2]!, { ...style, bold: true }));
      i += m[0].length;
      continue;
    }
    if ((m = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest))) {
      flush();
      out.push(...parseInline(m[1]!, style));
      i += m[0].length;
      continue;
    }
    // *italic* anywhere; _italic_ only at word edges (snake_case stays as it is).
    if ((m = /^\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/.exec(rest)) || (!/\w$/.test(buf) && (m = /^_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/.exec(rest)))) {
      flush();
      out.push(...parseInline(m[1]!, { ...style, italic: true }));
      i += m[0].length;
      continue;
    }
    // snake_case and other words with markers inside them are plain text.
    if ((m = /^\w+(?:_\w+)+/.exec(rest))) {
      flush();
      const last = out[out.length - 1];
      if (last && last.t === "text" && last.bold === style.bold && last.italic === style.italic) last.text += m[0];
      else out.push({ t: "text", text: m[0], ...style });
      i += m[0].length;
      continue;
    }
    buf += rest[0];
    i += 1;
  }
  flush();
  return out;
}

const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

const isTableSep = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const isTableRow = (line: string) => /^\s*\|.*\|\s*$/.test(line) || (line.includes("|") && line.split("|").length >= 3);

/** Parse a whole reply into blocks. Safe on partial text while it streams. */
export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      const inline = parseInline(para.join("\n"));
      if (inline.length) blocks.push({ t: "p", inline });
    }
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let m: RegExpExecArray | null;

    if ((m = /^\s*(```|~~~)/.exec(line))) {
      flushPara();
      const fence = m[1]!;
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence)) code.push(lines[i++]!);
      // An unclosed fence (still streaming) shows the code so far.
      blocks.push({ t: "code", text: code.join("\n").replace(/\s+$/, "") });
      continue;
    }
    if (!line.trim()) {
      flushPara();
      continue;
    }
    if ((m = /^\s{0,3}#{1,6}\s*(.*?)\s*#*\s*$/.exec(line)) && /^\s{0,3}#/.test(line)) {
      flushPara();
      const inline = parseInline(m[1]!, { bold: true });
      if (inline.length) blocks.push({ t: "h", inline });
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      blocks.push({ t: "hr" });
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1]!)) {
      flushPara();
      const header = splitRow(line).map((c) => parseInline(c));
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.trim() && isTableRow(lines[i]!)) rows.push(splitRow(lines[i++]!).map((c) => parseInline(c)));
      i--;
      blocks.push({ t: "table", header, rows });
      continue;
    }
    if (isTableSep(line)) continue; // a separator row with no header yet (streaming)
    if ((m = /^(\s*)([-*+•]|(\d{1,3})[.)])\s+(.*)$/.exec(line))) {
      flushPara();
      const depth = Math.min(3, Math.floor(m[1]!.replace(/\t/g, "  ").length / 2));
      const ordered = m[3] !== undefined;
      blocks.push({ t: "li", ordered, n: ordered ? Number(m[3]) : 0, depth, inline: parseInline(m[4]!) });
      continue;
    }
    if ((m = /^\s*>\s?(.*)$/.exec(line))) {
      flushPara();
      const inline = parseInline(m[1]!);
      if (inline.length) blocks.push({ t: "quote", inline });
      continue;
    }
    para.push(line);
  }
  flushPara();
  return blocks;
}

/** The plain text of inline nodes (for tests and accessibility). */
export const inlineText = (xs: Inline[]) => xs.map((x) => x.text).join("");
