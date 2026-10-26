/**
 * A small, safe reading of the markdown subset general answers use: fenced code, headings,
 * bullet and numbered lists, simple tables, bold and inline code. It produces data only; the
 * renderer builds React elements from it, so no answer text is ever treated as HTML.
 */
export type Inline = { kind: "text" | "bold" | "italic" | "code"; text: string };
export type RichBlock =
  | { kind: "paragraph"; lines: Inline[][] }
  | { kind: "quote"; lines: Inline[][] }
  | { kind: "rule" }
  | { kind: "heading"; level: 3 | 4; inline: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "code"; language: string; code: string }
  | { kind: "table"; header: Inline[][]; rows: Inline[][][] };

export function parseInline(text: string): Inline[] {
  const parts: Inline[] = [];
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|(?<![\w*])\*(?![\s*])[^*\n]+?(?<!\s)\*(?![\w*]))/gu;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ kind: "text", text: text.slice(last, index) });
    const token = match[0];
    parts.push(
      token.startsWith("`")
        ? { kind: "code", text: token.slice(1, -1) }
        : token.startsWith("**")
          ? { kind: "bold", text: token.slice(2, -2) }
          : { kind: "italic", text: token.slice(1, -1) },
    );
    last = index + token.length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts.length ? parts : [{ kind: "text", text: "" }];
}

const FENCE = /^\s*```\s*([\w+#.-]*)\s*$/u;
const HEADING = /^\s*(#{1,4})\s+(.+?)\s*#*\s*$/u;
const BULLET = /^\s*(?:[-*•])\s+(.+)$/u;
const NUMBERED = /^\s*(?:\d{1,3}|[٠-٩]{1,3})[.)]\s+(.+)$/u;
const TABLE_ROW = /^\s*\|.*\|\s*$/u;
const QUOTE = /^\s*>\s?(.*)$/u;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u;

const ARABIC_LETTER = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/u;
const LATIN_LETTER = /[A-Za-z]/u;
/**
 * Base direction for one block of an Arabic-first answer: any Arabic letter makes it RTL, so
 * «React Hooks دوال…» keeps its full stop on the left; text with only Latin letters is LTR.
 * `dir="auto"` would pick LTR from the first English term instead.
 */
export function textDirection(text: string): "rtl" | "ltr" | undefined {
  if (ARABIC_LETTER.test(text)) return "rtl";
  return LATIN_LETTER.test(text) ? "ltr" : undefined;
}
export const inlineText = (parts: Inline[]) => parts.map((part) => part.text).join("");
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/u;

const cells = (line: string) =>
  line.trim().replace(/^\||\|$/gu, "").split("|").map((cell) => parseInline(cell.trim()));

export function parseRichText(body: string): RichBlock[] {
  const lines = body.replace(/\r\n?/gu, "\n").split("\n");
  const blocks: RichBlock[] = [];
  let paragraph: Inline[][] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", lines: paragraph });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fence = line.match(FENCE);
    if (fence) {
      flush();
      const code: string[] = [];
      index += 1;
      // An unclosed fence (a streaming answer) runs to the end.
      while (index < lines.length && !FENCE.test(lines[index]!)) code.push(lines[index++]!);
      blocks.push({ kind: "code", language: fence[1] ?? "", code: code.join("\n") });
      continue;
    }
    if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[index + 1] ?? "")) {
      flush();
      const header = cells(line);
      const rows: Inline[][][] = [];
      index += 2;
      while (index < lines.length && TABLE_ROW.test(lines[index]!)) rows.push(cells(lines[index++]!));
      index -= 1;
      blocks.push({ kind: "table", header, rows });
      continue;
    }
    if (RULE.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      continue;
    }
    const quote = line.match(QUOTE);
    if (quote) {
      flush();
      const previous = blocks.at(-1);
      const content = parseInline(quote[1]!);
      if (previous?.kind === "quote") previous.lines.push(content);
      else blocks.push({ kind: "quote", lines: [content] });
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1]!.length <= 2 ? 3 : 4, inline: parseInline(heading[2]!) });
      continue;
    }
    const bullet = line.match(BULLET);
    const numbered = bullet ? undefined : line.match(NUMBERED);
    if (bullet || numbered) {
      flush();
      const ordered = Boolean(numbered);
      const previous = blocks.at(-1);
      const item = parseInline((bullet ?? numbered)![1]!);
      if (previous?.kind === "list" && previous.ordered === ordered) previous.items.push(item);
      else blocks.push({ kind: "list", ordered, items: [item] });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    paragraph.push(parseInline(line));
  }
  flush();
  return blocks;
}
