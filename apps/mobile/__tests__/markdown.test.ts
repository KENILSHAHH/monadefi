import { inlineText, parseInline, parseMarkdown, type Block } from "../src/lib/markdown";

const texts = (blocks: Block[]) =>
  blocks.map((b) => (b.t === "code" ? b.text : b.t === "hr" ? "---" : b.t === "table" ? "table" : inlineText(b.inline)));

describe("markdown: inline", () => {
  it("bold, italic, code and links", () => {
    expect(parseInline("A **bold** and *italic* with `code` and [docs](https://docs.perpl.xyz).")).toEqual([
      { t: "text", text: "A " },
      { t: "text", text: "bold", bold: true },
      { t: "text", text: " and " },
      { t: "text", text: "italic", italic: true },
      { t: "text", text: " with " },
      { t: "code", text: "code" },
      { t: "text", text: " and " },
      { t: "link", text: "docs", url: "https://docs.perpl.xyz" },
      { t: "text", text: "." },
    ]);
  });

  it("streaming: an unclosed ** or * or ` never shows", () => {
    expect(inlineText(parseInline("Your **ETH lon"))).toBe("Your ETH lon");
    expect(inlineText(parseInline("Price *2,40"))).toBe("Price 2,40");
    expect(inlineText(parseInline("Run `forge te"))).toBe("Run forge te");
  });

  it("snake_case and math stay as they are", () => {
    expect(inlineText(parseInline("Call perpl_open_position now"))).toBe("Call perpl_open_position now");
    expect(inlineText(parseInline("3 * 4 = 12"))).toBe("3 * 4 = 12");
  });

  it("unsafe link schemes become plain text", () => {
    expect(parseInline("[x](javascript:alert(1))").some((x) => x.t === "link")).toBe(false);
  });

  it("bare URLs are links", () => {
    expect(parseInline("See https://monadscan.com/tx/0xabc.")).toEqual([
      { t: "text", text: "See " },
      { t: "link", text: "https://monadscan.com/tx/0xabc", url: "https://monadscan.com/tx/0xabc" },
      { t: "text", text: "." },
    ]);
  });
});

describe("markdown: blocks", () => {
  it("headings are bold paragraphs with no #", () => {
    const b = parseMarkdown("## Your position\nText");
    expect(b[0]).toEqual({ t: "h", inline: [{ t: "text", text: "Your position", bold: true }] });
    expect(texts(b)).toEqual(["Your position", "Text"]);
  });

  it("bullet and numbered lists", () => {
    const b = parseMarkdown("- one\n* two\n  - nested\n1. first\n2) second");
    expect(b.map((x) => (x.t === "li" ? [x.ordered, x.n, x.depth, inlineText(x.inline)] : null))).toEqual([
      [false, 0, 0, "one"],
      [false, 0, 0, "two"],
      [false, 0, 1, "nested"],
      [true, 1, 0, "first"],
      [true, 2, 0, "second"],
    ]);
  });

  it("short tables", () => {
    const b = parseMarkdown("| Market | Funding |\n|---|:--:|\n| ETH | **0.01%** |\n| BTC | 0.02% |\n\nAfter");
    expect(b[0]!.t).toBe("table");
    const t = b[0] as Extract<Block, { t: "table" }>;
    expect(t.header.map(inlineText)).toEqual(["Market", "Funding"]);
    expect(t.rows.map((r) => r.map(inlineText))).toEqual([["ETH", "0.01%"], ["BTC", "0.02%"]]);
    expect(texts(b).slice(1)).toEqual(["After"]);
  });

  it("code blocks, also unclosed while streaming", () => {
    expect(parseMarkdown("```bash\ncast call\n```")).toEqual([{ t: "code", text: "cast call" }]);
    expect(parseMarkdown("```\npartial")).toEqual([{ t: "code", text: "partial" }]);
  });

  it("line breaks inside a paragraph are kept; rules and quotes", () => {
    expect(texts(parseMarkdown("line one\nline two\n\n---\n> quoted"))).toEqual(["line one\nline two", "---", "quoted"]);
  });

  it("no raw symbols in a typical reply", () => {
    const all = texts(parseMarkdown("### **Plan**\n- **Open** a *3x* long\n- Stop-loss at `2,300`\n\n**Risk:** low *")).join(" ");
    expect(all).not.toMatch(/\*|#|`/);
  });
});
